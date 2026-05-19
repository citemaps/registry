// ============================================================
// URL canonicalization for registry dedup keys.
//
// Two URLs that resolve to "the same citemap" must produce the
// same canonical form, otherwise the registry double-counts.
// Conservative rules — we don't want to merge entries that
// publishers consider distinct.
//
// Rules:
//   1. Lowercase scheme + host
//   2. Strip default ports (:80 for http, :443 for https)
//   3. Strip "www." prefix from host
//   4. Strip URL fragment (#anchor)
//   5. Strip tracking query params: utm_*, gclid, fbclid, mc_*,
//      _ga, ref, source — these never change the citemap content
//   6. Sort remaining query params alphabetically for stability
//   7. Trim trailing slash on path UNLESS path is "/"
//   8. Reject non-http(s) schemes
//   9. Reject hosts that resolve to localhost / private IPs
//      (SSRF defense) — done in validate.ts not here, but
//      noted for completeness
//
// Returns null when the URL is unparseable or non-http(s).
// ============================================================

const TRACKING_PARAM_PATTERNS: RegExp[] = [
  /^utm_/i,
  /^mc_/i,
  /^_ga$/i,
  /^gclid$/i,
  /^fbclid$/i,
  /^msclkid$/i,
  /^yclid$/i,
  /^dclid$/i,
  /^ref$/i,
  /^source$/i,
  /^_hsenc$/i,
  /^_hsmi$/i,
];

function isTrackingParam(key: string): boolean {
  return TRACKING_PARAM_PATTERNS.some(re => re.test(key));
}

export function canonicalizeUrl(input: string): string | null {
  if (!input || typeof input !== "string") return null;
  let parsed: URL;
  try {
    parsed = new URL(input.trim());
  } catch {
    return null;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;

  // Lowercase scheme + host, drop default ports
  parsed.protocol = parsed.protocol.toLowerCase();
  let host = parsed.hostname.toLowerCase();
  if (host.startsWith("www.")) host = host.slice(4);

  // Strip tracking params + sort the rest
  const params = new URLSearchParams();
  const sortedKeys = Array.from(parsed.searchParams.keys())
    .filter(k => !isTrackingParam(k))
    .sort();
  for (const key of sortedKeys) {
    // Preserve the first value per key (URLSearchParams dedupes
    // duplicates naturally in this construction style).
    const value = parsed.searchParams.get(key);
    if (value !== null) params.set(key, value);
  }

  // Path trimming — drop trailing slash unless root
  let pathname = parsed.pathname;
  if (pathname.length > 1 && pathname.endsWith("/")) {
    pathname = pathname.slice(0, -1);
  }

  const portSuffix = (() => {
    if (!parsed.port) return "";
    if (parsed.protocol === "http:"  && parsed.port === "80")  return "";
    if (parsed.protocol === "https:" && parsed.port === "443") return "";
    return `:${parsed.port}`;
  })();

  const query = params.toString();
  return `${parsed.protocol}//${host}${portSuffix}${pathname}${query ? "?" + query : ""}`;
}

/** Extract the bare host (lowercased, www-stripped) from any
 *  canonicalized or raw URL. Used for per-domain rate limits
 *  and per-domain index display. */
export function hostOf(url: string): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    let host = u.hostname.toLowerCase();
    if (host.startsWith("www.")) host = host.slice(4);
    return host;
  } catch {
    return null;
  }
}

/** Block local + private network targets — SSRF defense for the
 *  validation fetcher. Returns true when the host should be
 *  rejected. */
export function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "localhost" || h === "127.0.0.1" || h === "0.0.0.0" || h === "::1") return true;
  // IPv4 private ranges
  if (/^10\./.test(h)) return true;
  if (/^192\.168\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(h)) return true;
  if (/^169\.254\./.test(h)) return true; // link-local
  // IPv6 private / link-local — broad strokes
  if (h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80:")) return true;
  // Cloud metadata endpoints — AWS / GCP / Azure / DO
  if (h === "169.254.169.254" || h === "metadata.google.internal") return true;
  return false;
}
