// ============================================================
// Validation worker — fetches a submitted URL, detects format,
// parses the citemap, and extracts metadata.
//
// Inline for v0 — no queue, no separate worker process. The
// submit route awaits validate() before responding. Acceptable
// because:
//   - validate() is bounded (~10s fetch timeout + cheap parsing)
//   - Phase 1 submission volume is Studio-only (dozens per day)
//
// Phase 5 Common Crawl mining will need a real queue + worker
// pool. That migration replaces this module's caller, not its
// shape — validate() stays a pure (url) → ValidationResult fn.
//
// SSRF defense: rejects private hosts upfront (canonicalize.ts
// helper). Fetch uses 10s timeout + AbortController. Limits
// response body to 1 MB to prevent memory blowups.
// ============================================================

import { createHash } from "crypto";
import { hostOf, isPrivateHost } from "./canonicalize";
import type { ParsedCitemap, SubmissionFormat } from "./types";

const FETCH_TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES   = 1_048_576;  // 1 MB
const USER_AGENT = "CiteMapsRegistry/0.1 (+https://citemaps.org)";

/** Result of a validation pass. The submit route maps this onto
 *  the RegistryEntry's status + parsed + statusMessage fields. */
export interface ValidationResult {
  ok: boolean;
  format: SubmissionFormat;
  /** Status to assign to the entry. Maps directly onto
   *  RegistryStatus minus the lifecycle states ("queued",
   *  "validating") that validation itself can't produce. */
  status: "indexed" | "invalid" | "timeout" | "blocked";
  statusMessage?: string;
  parsed?: ParsedCitemap;
}

/** Run validation against one URL. Pure async function; no I/O
 *  beyond the fetch. Caller decides what to persist. */
export async function validate(url: string): Promise<ValidationResult> {
  // SSRF gate — never let the worker reach localhost / private
  // networks / cloud metadata endpoints.
  const host = hostOf(url);
  if (!host || isPrivateHost(host)) {
    return {
      ok: false,
      format: "unknown",
      status: "blocked",
      statusMessage: "Submission host is not publicly reachable.",
    };
  }

  // Fetch with timeout + size cap.
  let response: Response;
  let body: string;
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      response = await fetch(url, {
        method: "GET",
        signal: controller.signal,
        headers: {
          "Accept": "application/json, text/html, application/ld+json",
          "User-Agent": USER_AGENT,
        },
        redirect: "follow",
      });
    } finally {
      clearTimeout(timeoutId);
    }
    if (!response.ok) {
      return {
        ok: false,
        format: "unknown",
        status: "invalid",
        statusMessage: `Fetch returned HTTP ${response.status}.`,
      };
    }
    body = await readBodyCapped(response);
  } catch (err) {
    const name = (err as { name?: string } | undefined)?.name ?? "";
    if (name === "AbortError") {
      return {
        ok: false,
        format: "unknown",
        status: "timeout",
        statusMessage: `Fetch exceeded ${FETCH_TIMEOUT_MS / 1000}s timeout.`,
      };
    }
    return {
      ok: false,
      format: "unknown",
      status: "invalid",
      statusMessage: `Fetch failed: ${String(err)}`,
    };
  }

  // Detect format from Content-Type, falling back to body sniff.
  const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
  let format: SubmissionFormat = "unknown";
  if (contentType.includes("application/json") || contentType.includes("application/ld+json")) {
    format = "json";
  } else if (contentType.includes("text/html") || contentType.includes("application/xhtml")) {
    format = "html";
  } else {
    // Sniff first non-whitespace char
    const trimmed = body.trimStart();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) format = "json";
    else if (trimmed.startsWith("<")) format = "html";
  }

  // Parse based on format.
  let citemapJson: Record<string, unknown> | null = null;
  if (format === "json") {
    try {
      citemapJson = JSON.parse(body) as Record<string, unknown>;
    } catch (err) {
      return {
        ok: false,
        format,
        status: "invalid",
        statusMessage: `JSON parse failed: ${String(err)}`,
      };
    }
  } else if (format === "html") {
    citemapJson = extractCitemapFromHtml(body);
    if (!citemapJson) {
      return {
        ok: false,
        format,
        status: "invalid",
        statusMessage: "No <script type=\"application/ld+json\"> with @type \"Citemap\" found.",
      };
    }
  } else {
    return {
      ok: false,
      format,
      status: "invalid",
      statusMessage: "Could not detect submission format (expected JSON or HTML).",
    };
  }

  // Validate the parsed payload shape.
  const shapeError = validateCitemapShape(citemapJson);
  if (shapeError) {
    return {
      ok: false,
      format,
      status: "invalid",
      statusMessage: shapeError,
    };
  }

  // Extract metadata + compute hash.
  const parsed = extractMetadata(citemapJson);
  parsed.rawHash = sha1(JSON.stringify(citemapJson));

  return {
    ok: true,
    format,
    status: "indexed",
    parsed,
  };
}

// ── Helpers ────────────────────────────────────────────────

async function readBodyCapped(response: Response): Promise<string> {
  // Stream the body in chunks; bail when we exceed MAX_BODY_BYTES.
  // Node 18+ Response has body as ReadableStream; we use the
  // higher-level .text() with a content-length pre-check when
  // possible, falling back to streaming for chunked responses.
  const contentLength = parseInt(response.headers.get("content-length") ?? "0", 10);
  if (contentLength > MAX_BODY_BYTES) {
    throw new Error(`Body too large: ${contentLength} bytes (max ${MAX_BODY_BYTES})`);
  }
  // For shorter / unknown-length responses, .text() is fine — we
  // accept a small risk of exceeding the cap on adversarial
  // chunked-encoding responses. Tighten with streaming if abuse
  // surfaces.
  const text = await response.text();
  if (text.length > MAX_BODY_BYTES) {
    throw new Error(`Body too large after read: ${text.length} bytes (max ${MAX_BODY_BYTES})`);
  }
  return text;
}

/** Find the first <script type="application/ld+json"> block in
 *  the HTML body that parses to a JSON object with @type
 *  matching "Citemap" (case-insensitive). Returns the parsed
 *  object or null. */
function extractCitemapFromHtml(html: string): Record<string, unknown> | null {
  // Simple regex-based extraction — we don't need a full HTML
  // parser for this; the script tag is structured and well-known.
  // [\s\S] matches across newlines without flags.
  const pattern = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html)) !== null) {
    const blockRaw = match[1].trim();
    if (!blockRaw) continue;
    try {
      const parsed = JSON.parse(blockRaw) as Record<string, unknown>;
      if (isCitemapShape(parsed)) return parsed;
      // Allow @graph form too — some publishers wrap.
      const graph = (parsed as { "@graph"?: unknown[] })["@graph"];
      if (Array.isArray(graph)) {
        for (const node of graph) {
          if (node && typeof node === "object" && isCitemapShape(node as Record<string, unknown>)) {
            return node as Record<string, unknown>;
          }
        }
      }
    } catch {
      continue;
    }
  }
  return null;
}

function isCitemapShape(obj: Record<string, unknown>): boolean {
  const type = obj["@type"] ?? obj.type;
  if (typeof type === "string") return type.toLowerCase() === "citemap";
  if (Array.isArray(type)) return type.some(t => typeof t === "string" && t.toLowerCase() === "citemap");
  return false;
}

/** Validate the parsed payload has the structural elements a
 *  registry entry needs. Returns an error message string or
 *  null when shape is valid. */
function validateCitemapShape(obj: Record<string, unknown>): string | null {
  if (!isCitemapShape(obj)) {
    return "Payload @type is not \"Citemap\".";
  }
  const version = obj.version ?? obj["citemapVersion"];
  if (typeof version !== "string" || !/^\d+(\.\d+)?(\.\d+)?$/.test(version)) {
    return "Missing or malformed version field (expected semver-like string).";
  }
  // At least one of brand / entity / data must be present —
  // these are the load-bearing structural sections.
  const brand = obj.brand;
  const entity = obj.entity;
  const data = obj.data;
  if (!brand && !entity && !data) {
    return "Payload lacks any of brand / entity / data sections.";
  }
  return null;
}

/** Pull display metadata out of a validated citemap payload. */
function extractMetadata(obj: Record<string, unknown>): ParsedCitemap {
  const out: ParsedCitemap = {};

  const version = obj.version ?? obj["citemapVersion"];
  if (typeof version === "string") out.citemapVersion = version;

  const brand = obj.brand as Record<string, unknown> | undefined;
  const entity = obj.entity as Record<string, unknown> | undefined;
  const source = brand ?? entity;
  if (source) {
    const name = source.name;
    if (typeof name === "string") out.entityName = name;
    const type = source["@type"] ?? source.type;
    if (typeof type === "string") out.entityType = type;
  }

  // Verticals — declared either at root or under brand
  const verticalsRaw = (obj.verticals ?? brand?.verticals ?? []) as unknown;
  if (Array.isArray(verticalsRaw)) {
    const vs = verticalsRaw.filter((v): v is string => typeof v === "string");
    if (vs.length > 0) {
      out.verticals = vs;
      out.primaryVertical = vs[0];
    }
  }

  // Module keys — top-level fields after the well-known
  // metadata fields. Heuristic, not exhaustive.
  const METADATA_KEYS = new Set([
    "@context", "@type", "@graph", "version", "citemapVersion",
    "brand", "entity", "verticals", "citationContract", "lastUpdated",
  ]);
  const moduleKeys = Object.keys(obj).filter(k => !METADATA_KEYS.has(k));
  if (moduleKeys.length > 0) out.moduleKeys = moduleKeys;

  // Presence flags for badges
  out.hasTrust = isObject(obj.trust) || isObject(brand?.trust);
  out.hasTemporalRecord = isObject(obj.temporalRecord) || isObject(brand?.temporalRecord);

  // Profile completeness — light heuristic; refine in Phase 2.
  // Counts presence of high-value fields out of a fixed
  // weighted denominator.
  out.profileCompleteness = computeCompleteness(obj);

  return out;
}

function isObject(x: unknown): x is Record<string, unknown> {
  return !!x && typeof x === "object" && !Array.isArray(x);
}

function computeCompleteness(obj: Record<string, unknown>): number {
  const brand = obj.brand as Record<string, unknown> | undefined;
  const source = brand ?? (obj.entity as Record<string, unknown> | undefined);
  const checks: Array<[boolean, number]> = [
    [typeof source?.name === "string", 10],
    [typeof source?.description === "string", 8],
    [Array.isArray(source?.sameAs) && (source.sameAs as unknown[]).length > 0, 8],
    [isObject(source?.address), 8],
    [typeof source?.telephone === "string", 5],
    [Array.isArray(source?.services) && (source.services as unknown[]).length > 0, 8],
    [Array.isArray(source?.products) && (source.products as unknown[]).length > 0, 8],
    [isObject(obj.trust)            || isObject(source?.trust),            10],
    [isObject(obj.temporalRecord)   || isObject(source?.temporalRecord),   10],
    [isObject(obj.citationContract),                                       10],
    [Array.isArray(obj.verticals) && (obj.verticals as unknown[]).length > 0, 5],
    [typeof obj.lastUpdated === "string", 5],
    [isObject(source?.team) || Array.isArray(source?.team),                5],
  ];
  const totalWeight = checks.reduce((s, [, w]) => s + w, 0);
  const earned = checks.reduce((s, [present, w]) => s + (present ? w : 0), 0);
  return Math.round((earned / totalWeight) * 100);
}

function sha1(input: string): string {
  return createHash("sha1").update(input).digest("hex");
}
