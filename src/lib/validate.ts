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
      statusMessage: "This URL isn't publicly reachable, so we can't index it.",
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
      const s = response.status;
      let msg: string;
      if (s === 404) {
        msg = "No file found at this URL (404). The citemap may not be published yet, or the path might have a typo.";
      } else if (s >= 500) {
        msg = `The server returned an error (${s}). Try again in a moment.`;
      } else if (s === 403 || s === 401) {
        msg = `The URL is access-restricted (${s}). The citemap needs to be publicly readable to index.`;
      } else {
        msg = `The URL returned an unexpected response (${s}). Make sure the file is reachable.`;
      }
      return {
        ok: false,
        format: "unknown",
        status: "invalid",
        statusMessage: msg,
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
        statusMessage: `Took longer than ${FETCH_TIMEOUT_MS / 1000} seconds to respond. The server may be slow or unreachable.`,
      };
    }
    return {
      ok: false,
      format: "unknown",
      status: "invalid",
      statusMessage: "Couldn't connect to this URL. Check that the domain is reachable from the public internet.",
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
    } catch {
      return {
        ok: false,
        format,
        status: "invalid",
        statusMessage: "File found but it's not valid JSON. The file may be corrupted or misnamed.",
      };
    }
  } else if (format === "html") {
    citemapJson = extractCitemapFromHtml(body);
    if (!citemapJson) {
      return {
        ok: false,
        format,
        status: "invalid",
        statusMessage: "Found a page at this URL but no citemap was embedded in it. Make sure the page contains the HTML companion you generated.",
      };
    }
  } else {
    return {
      ok: false,
      format,
      status: "invalid",
      statusMessage: "Couldn't detect the file format — expected JSON or HTML.",
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
    return "File found but it's not a citemap — the @type field doesn't match.";
  }
  const version = obj.version ?? obj["citemapVersion"];
  if (typeof version !== "string" || !/^\d+(\.\d+)?(\.\d+)?$/.test(version)) {
    return "The citemap is missing a valid version field.";
  }
  // At least one of brand / entity / data must be present —
  // these are the load-bearing structural sections.
  const brand = obj.brand;
  const entity = obj.entity;
  const data = obj.data;
  if (!brand && !entity && !data) {
    return "The citemap is missing required content sections (brand, entity, or data).";
  }
  // v3.3 §1.3 orphan rejection — every @graph node must be
  // reachable from the primary entity via relationships[]
  // (directly or transitively). Pure structural pass, no
  // network calls. Skipped for documents that don't use the
  // @graph extension.
  const graphError = validateGraphReachability(obj);
  if (graphError) return graphError;

  return null;
}

/** v3.3 §1.3 orphan-node rejection.
 *
 *  Every node in `@graph[]` MUST be reachable from the primary
 *  entity via at least one edge in `relationships[]`, directly
 *  or transitively. Edges are treated as undirected for
 *  reachability purposes — direction expresses semantic role
 *  (parentOrganizationOf vs subOrganizationOf), not graph
 *  connectivity. A `Person` node connected to the primary by
 *  a `worksFor` edge in EITHER direction satisfies the rule.
 *
 *  Returns null when the document is well-formed (or when no
 *  @graph extension is present — the rule only fires for
 *  documents that opt in). Returns a descriptive error when
 *  orphans are found, when @graph nodes lack @id, or when the
 *  primary entity can't be identified despite @graph being
 *  populated.
 *
 *  Cross-document @id references (absolute URLs in `to` that
 *  aren't local @graph node IDs) participate in the adjacency
 *  set — they're valid edge endpoints per §1.4 — but they
 *  don't need to be "reachable" since they're external. The
 *  check only inspects whether THIS document's @graph nodes
 *  are reachable; external edges that pass through them on
 *  the way to remote @ids still count for connectivity.
 *
 *  Algorithm: O(V + E) BFS. Typical citemap sizes (~10-50
 *  graph nodes, ~20-100 edges) — trivially fast.
 */
function validateGraphReachability(obj: Record<string, unknown>): string | null {
  const graph = obj["@graph"];
  if (!Array.isArray(graph) || graph.length === 0) return null;

  // Identify the primary entity's @id. Per v3.3 §1, this lives
  // at brand["@id"]; entity["@id"] handled as a legacy fallback
  // for documents using the older brand-less shape.
  const brand = obj.brand as Record<string, unknown> | undefined;
  const entity = obj.entity as Record<string, unknown> | undefined;
  const primary = brand ?? entity;
  const primaryId = primary && typeof primary["@id"] === "string"
    ? (primary["@id"] as string)
    : null;
  if (!primaryId) {
    return "The citemap uses the v3.3 @graph extension but the primary entity is missing an @id. Per spec §1.3, every @graph node must be reachable from the primary entity, which requires the primary entity to be identifiable by @id.";
  }

  // Collect every @graph node's @id; flag any node missing one.
  // Per §1.3, nodes MUST have at minimum @type and @id.
  const graphNodeIds: string[] = [];
  const missingIdAt: number[] = [];
  graph.forEach((node, i) => {
    if (node && typeof node === "object" && !Array.isArray(node)) {
      const id = (node as Record<string, unknown>)["@id"];
      if (typeof id === "string") graphNodeIds.push(id);
      else missingIdAt.push(i);
    } else {
      missingIdAt.push(i);
    }
  });
  if (missingIdAt.length > 0) {
    const sample = missingIdAt.slice(0, 5).join(", ");
    const more = missingIdAt.length > 5 ? ", …" : "";
    return `The citemap's @graph[] contains ${missingIdAt.length} node${missingIdAt.length === 1 ? "" : "s"} without an @id (at index${missingIdAt.length === 1 ? "" : "es"} ${sample}${more}). Per spec §1.3, every @graph node must have at minimum @type and @id.`;
  }

  // Build undirected adjacency from relationships[]. Edges
  // with missing or non-string endpoints are skipped — they
  // can't participate in reachability anyway. Validators
  // SHOULD ignore unknown edge fields per §1.4; we follow the
  // same posture for malformed edges (don't fail-fast on edge
  // shape; let the orphan check speak instead).
  const rels = Array.isArray(obj.relationships) ? obj.relationships : [];
  const adjacency = new Map<string, Set<string>>();
  const addEdge = (a: string, b: string): void => {
    if (!adjacency.has(a)) adjacency.set(a, new Set());
    adjacency.get(a)!.add(b);
  };
  for (const rel of rels) {
    if (!rel || typeof rel !== "object") continue;
    const from = (rel as Record<string, unknown>).from;
    const to = (rel as Record<string, unknown>).to;
    if (typeof from === "string" && typeof to === "string" && from !== to) {
      addEdge(from, to);
      addEdge(to, from);
    }
  }

  // BFS from the primary @id, collecting every node reachable
  // through the undirected adjacency set.
  const reachable = new Set<string>([primaryId]);
  const queue: string[] = [primaryId];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    const neighbors = adjacency.get(cur);
    if (!neighbors) continue;
    for (const n of neighbors) {
      if (!reachable.has(n)) {
        reachable.add(n);
        queue.push(n);
      }
    }
  }

  // Any @graph node @id not in the reachable set is an orphan.
  const orphans = graphNodeIds.filter(id => !reachable.has(id));
  if (orphans.length > 0) {
    const sample = orphans.slice(0, 3).map(s => `"${s}"`).join(", ");
    const more = orphans.length > 3 ? ` (+${orphans.length - 3} more)` : "";
    return `The citemap's @graph[] contains ${orphans.length} orphan node${orphans.length === 1 ? "" : "s"} not reachable from the primary entity via relationships[]: ${sample}${more}. Per spec §1.3, every @graph node must be connected to the primary entity by at least one edge in relationships[] (directly or transitively).`;
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

  // Module keys — top-level fields that aren't metadata,
  // identity, or v3.3 foundational sections. After this
  // filter, what's left is actual vertical-specific module
  // blocks (localBusiness, ecommerce, software, restaurant,
  // legal, finance, medicalBusiness, etc.) — the
  // user-pickable content the citemap actually describes.
  //
  // Excludes:
  //  - Metadata: @context/@type/@graph/version/citemapVersion/
  //    $schema/generatedBy/lastVerified/lastUpdated/citemapLevel/
  //    citemap (the citemap-meta block)
  //  - Identity: brand/entity/contact/verticals/relationships
  //  - v3.3 foundational sections: citationContract/temporalRecord/
  //    trust/answerContent/policy/verification (always-on per
  //    v3.3 §3 — not "modules" the user picked)
  //  - v3.0 verifiedClaims (content-ish but emitted as a
  //    structural array, not a vertical module)
  //
  // Per v3.3 §1.4 — when `relationships` is present it's a
  // graph-extension block, not a module. Filtered.
  const METADATA_KEYS = new Set([
    // metadata
    "@context", "@type", "@graph", "version", "citemapVersion",
    "$schema", "generatedBy", "lastVerified", "lastUpdated",
    "citemapLevel", "citemap",
    // identity + structural
    "brand", "entity", "contact", "verticals", "relationships",
    // v3.3 foundational sections (always-on per spec §3)
    "citationContract", "temporalRecord", "trust", "answerContent",
    "policy", "verification",
    // v3.0 structural arrays
    "verifiedClaims",
  ]);
  const moduleKeys = Object.keys(obj).filter(k => !METADATA_KEYS.has(k));
  if (moduleKeys.length > 0) out.moduleKeys = moduleKeys;

  // Presence flags for badges. Mirror the v3.3 foundational
  // sections so the detail page can surface their presence
  // independently from the modules list.
  out.hasTrust = isObject(obj.trust) || isObject(brand?.trust);
  out.hasTemporalRecord = isObject(obj.temporalRecord) || isObject(brand?.temporalRecord);
  out.hasPolicy = isObject(obj.policy) && Object.keys(obj.policy as object).length > 0;
  out.hasVerification = isObject(obj.verification) && Object.keys(obj.verification as object).length > 0;

  // Registry token (v3.2.1 spec) — extract for Phase 4 claim
  // flow. Per spec, the field is opaque metadata to validators
  // (no inference, no scoring); we extract it solely so the
  // claim API can compare against submissions without re-parsing.
  // Absent for publishers who haven't adopted the v3.2.1 field.
  const citationContract = obj.citationContract as Record<string, unknown> | undefined;
  if (citationContract && typeof citationContract.registryToken === "string") {
    out.registryToken = citationContract.registryToken;
  }

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
