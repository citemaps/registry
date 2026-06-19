// ============================================================
// Claim flow helpers — re-fetch a citemap from its published
// URL and compare against the submitted registry token.
//
// Why re-fetch instead of trusting the stored parsed value:
// the parsed value was extracted whenever the validation
// worker last ran (could be days ago). Claim is a moment of
// proof — we want the freshest source of truth. Same fetch
// shape as validate.ts to keep behavior consistent (SSRF
// gate, timeout, body cap, format detection, HTML extraction).
//
// Returns a discriminated result so the API route can map
// directly onto user-facing messages.
// ============================================================

import { hostOf, isPrivateHost } from "./canonicalize";

const FETCH_TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 1_048_576;
// Real browser UA + a trailing CiteMapsRegistry identifier (2026-06-19).
// Empirically chosen against SiteGround's WAF: a bare bot UA and the
// Googlebot-style "Mozilla/5.0 (compatible; …Bot…)" pattern both get 403'd
// (the latter as fake-bot anti-spoofing), but a genuine browser UA passes.
// The trailing product token keeps us honest + lets publishers allowlist
// "CiteMapsRegistry" deliberately. Keep the two registry libs in sync.
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 CiteMapsRegistry/1.0 (+https://citemaps.org/registry)";

/** WAF / anti-bot block detection. A managed-WP firewall typically answers a
 *  non-browser fetch with a 403 (or 401/406/429/503), or a 200 HTML
 *  "challenge" page — not the citemap. Distinguish that from a URL that simply
 *  isn't a citemap, so we can tell the publisher to allowlist us rather than
 *  send them chasing a file that's actually fine. */
function looksLikeFirewallBlock(status: number, contentType: string, body: string): boolean {
  if (status === 401 || status === 403 || status === 406 || status === 429 || status === 503) return true;
  if (contentType.includes("text/html") || contentType.includes("application/xhtml")) {
    const b = body.slice(0, 2000).toLowerCase();
    return /access denied|forbidden|web application firewall|are you human|captcha|security check|cloudflare|attention required|request blocked|bot (?:detection|protection)|sucuri|incapsula|imunify/.test(b);
  }
  return false;
}

const FIREWALL_BLOCK_MESSAGE =
  "We reached your site, but a security firewall (common on SiteGround and other managed-WordPress hosts) blocked our verification request. Allowlist the registry crawler — its User-Agent contains \"CiteMapsRegistry\" — or temporarily relax bot/WAF protection for /citemap.json, then try claiming again.";

/** Recommended token format per v3.2.1 spec. Other formats
 *  are accepted by the registry but flagged as info-only —
 *  for the strict equality compare in claim, format is
 *  irrelevant (we compare bytes). */
const TOKEN_FORMAT_RE = /^cmrt_[a-f0-9]{16}$/;

export type ClaimMatchResult =
  | { ok: true; foundToken: string }
  | {
      ok: false;
      reason:
        | "unreachable"
        | "blocked"
        | "not-found"
        | "not-a-citemap"
        | "no-token-in-citemap"
        | "token-mismatch";
      message: string;
    };

/** Verify that the URL still serves a citemap containing the
 *  expected token. Returns ok=true on byte-exact match. */
export async function verifyTokenAtUrl(
  url: string,
  expectedToken: string,
): Promise<ClaimMatchResult> {
  const host = hostOf(url);
  if (!host || isPrivateHost(host)) {
    return {
      ok: false,
      reason: "unreachable",
      message: "This URL isn't publicly reachable — claims require a public citemap deployment.",
    };
  }

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
          "Accept-Language": "en-US,en;q=0.9",
          "User-Agent": USER_AGENT,
        },
        redirect: "follow",
      });
    } finally {
      clearTimeout(timeoutId);
    }
    if (!response.ok) {
      // A firewall/anti-bot block (403 etc.) is NOT a missing file — say so,
      // so the publisher allowlists us instead of re-checking a fine citemap.
      if (looksLikeFirewallBlock(response.status, (response.headers.get("content-type") ?? "").toLowerCase(), "")) {
        return { ok: false, reason: "blocked", message: FIREWALL_BLOCK_MESSAGE };
      }
      return {
        ok: false,
        reason: "not-found",
        message: `The citemap URL returned ${response.status}. Make sure it's still published at this location.`,
      };
    }
    body = await response.text();
    if (body.length > MAX_BODY_BYTES) {
      return {
        ok: false,
        reason: "not-a-citemap",
        message: "Citemap response too large to verify safely.",
      };
    }
  } catch (err) {
    const name = (err as { name?: string } | undefined)?.name ?? "";
    return {
      ok: false,
      reason: "unreachable",
      message:
        name === "AbortError"
          ? "Verification request timed out. Try again in a moment."
          : "Couldn't reach the citemap URL. Check the domain is publicly reachable.",
    };
  }

  // Parse — same detection logic as validate.ts.
  let citemap: Record<string, unknown> | null = null;
  const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
  if (contentType.includes("application/json") || contentType.includes("application/ld+json")) {
    try { citemap = JSON.parse(body) as Record<string, unknown>; } catch { /* fall through */ }
  } else if (contentType.includes("text/html") || contentType.includes("application/xhtml")) {
    citemap = extractCitemapFromHtml(body);
  } else {
    const trimmed = body.trimStart();
    if (trimmed.startsWith("{")) {
      try { citemap = JSON.parse(body) as Record<string, unknown>; } catch { /* fall through */ }
    } else if (trimmed.startsWith("<")) {
      citemap = extractCitemapFromHtml(body);
    }
  }

  if (!citemap) {
    // A 200 HTML "challenge" page (anti-bot interstitial) parses to no citemap
    // just like a real non-citemap page would — disambiguate so we don't blame
    // the publisher's (fine) citemap for what's actually a firewall block.
    if (looksLikeFirewallBlock(response.status, contentType, body)) {
      return { ok: false, reason: "blocked", message: FIREWALL_BLOCK_MESSAGE };
    }
    return {
      ok: false,
      reason: "not-a-citemap",
      message: "URL didn't return a parseable citemap (JSON or HTML companion with embedded JSON-LD).",
    };
  }

  const citationContract = citemap.citationContract as Record<string, unknown> | undefined;
  const foundToken =
    citationContract && typeof citationContract.registryToken === "string"
      ? citationContract.registryToken
      : null;

  if (!foundToken) {
    return {
      ok: false,
      reason: "no-token-in-citemap",
      message:
        "This citemap doesn't include a citationContract.registryToken yet. Regenerate the citemap from your producer (or add the field manually) so the token is published, then try claiming again.",
    };
  }

  // Strict byte-exact compare. Whitespace + casing differences
  // mean a different token — publishers control the value, so
  // any drift is the publisher's choice.
  if (foundToken !== expectedToken) {
    return {
      ok: false,
      reason: "token-mismatch",
      message:
        "The token you submitted doesn't match the token published in the citemap at this URL. Make sure you copied the current token from your producer (CitemapStudioTab in Studio, or the citationContract.registryToken field in your hand-authored file).",
    };
  }

  return { ok: true, foundToken };
}

/** Validate that a submitted token is at least syntactically
 *  plausible — quick rejection of empty strings, gross typos.
 *  Doesn't reject non-standard formats (per v3.2.1 spec, other
 *  formats are accepted) — only obvious garbage. */
export function isPlausibleToken(token: string | undefined | null): boolean {
  if (!token || typeof token !== "string") return false;
  if (token.length < 8 || token.length > 256) return false;
  // Disallow whitespace + control chars (token is meant to live
  // in a JSON string + a URL query param at various points).
  if (/[\s\x00-\x1f]/.test(token)) return false;
  return true;
}

/** Convenience: was the token in the recommended cmrt_-format? */
export function isStandardTokenFormat(token: string): boolean {
  return TOKEN_FORMAT_RE.test(token);
}

// ── HTML extraction (mirror of validate.ts) ────────────────

function extractCitemapFromHtml(html: string): Record<string, unknown> | null {
  const pattern = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html)) !== null) {
    const blockRaw = match[1].trim();
    if (!blockRaw) continue;
    try {
      const parsed = JSON.parse(blockRaw) as Record<string, unknown>;
      if (isCitemapShape(parsed)) return parsed;
      const graph = (parsed as { "@graph"?: unknown[] })["@graph"];
      if (Array.isArray(graph)) {
        for (const node of graph) {
          if (node && typeof node === "object" && isCitemapShape(node as Record<string, unknown>)) {
            return node as Record<string, unknown>;
          }
        }
      }
    } catch { continue; }
  }
  return null;
}

function isCitemapShape(obj: Record<string, unknown>): boolean {
  const type = obj["@type"] ?? obj.type;
  if (typeof type === "string") return type.toLowerCase() === "citemap";
  if (Array.isArray(type)) return type.some(t => typeof t === "string" && t.toLowerCase() === "citemap");
  return false;
}
