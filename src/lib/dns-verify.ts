// ============================================================
// DNS verification — the registry's "Verified" badge.
// Vault: decisions/registry-verified-badge-domain-anchored.md
//
// Verified = the entry's registryToken is in the live citemap
// AND a TXT record `_citemap.{registrable domain}` carries the
// same token. Nothing else — no owners, no emails, no review.
// It's a live state recomputed on every check (submit, the
// weekly recheck loop, revalidate, "Check now"), not a grant.
//
// The registrable domain comes from the Public Suffix List
// (tldts): a citemap on shop.acme.com is verified by
// _citemap.acme.com. Platform subdomains (acme.github.io,
// acme.wixsite.com …, the PSL's private section) are their own
// registrable domains with no DNS access → can be Claimed, never
// Verified.
//
// TXT lookups go over DNS-over-HTTPS (Cloudflare, Google as
// fallback): plain HTTPS works everywhere serverless does and
// skips the platform resolver's cache.
// ============================================================
import { parse } from "tldts";
import type { DomainVerification, RegistryEntry } from "./types";

const DOH = [
  "https://cloudflare-dns.com/dns-query",
  "https://dns.google/resolve",
];
const DOH_TIMEOUT_MS = 5_000;

export const RECORD_LABEL = "_citemap";

/** Registrable domain for a host, and whether it's a platform
 *  subdomain the publisher can't put DNS records on. */
export function registrableDomainOf(host: string): { domain: string | null; platform: boolean } {
  const h = host.toLowerCase().replace(/^www\./, "");
  const withPrivate = parse(h, { allowPrivateDomains: true });
  if (withPrivate.isPrivate) return { domain: withPrivate.domain ?? h, platform: true };
  const icann = parse(h);
  return { domain: icann.domain ?? null, platform: false };
}

export const recordNameFor = (registrable: string) => `${RECORD_LABEL}.${registrable}`;

/** TXT values at `name` (chunks joined), [] when there are none,
 *  or null when DNS couldn't be asked (all resolvers failed). */
export async function lookupTxt(name: string): Promise<string[] | null> {
  for (const base of DOH) {
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), DOH_TIMEOUT_MS);
      let res: Response;
      try {
        res = await fetch(`${base}?name=${encodeURIComponent(name)}&type=TXT`, {
          headers: { accept: "application/dns-json" }, signal: controller.signal, cache: "no-store",
        });
      } finally { clearTimeout(t); }
      if (!res.ok) continue;
      const j = (await res.json()) as { Status?: number; Answer?: { type?: number; data?: string }[] };
      // Status 0 = NOERROR, 3 = NXDOMAIN (no such name → no records).
      if (j.Status === 3) return [];
      if (j.Status !== 0) continue;
      return (j.Answer ?? [])
        .filter(a => a.type === 16 && typeof a.data === "string")
        .map(a => joinTxtChunks(a.data!));
    } catch { /* try the next resolver */ }
  }
  return null;
}

/** DoH returns TXT data as one or more quoted strings:
 *  "\"cmrt_abc\"" or "\"part1\" \"part2\"". */
function joinTxtChunks(data: string): string {
  const parts = data.match(/"((?:[^"\\]|\\.)*)"/g);
  if (!parts) return data.trim();
  return parts.map(p => p.slice(1, -1).replace(/\\(.)/g, "$1")).join("");
}

/** Recompute an entry's verification. `entry.parsed.registryToken`
 *  must be fresh (callers run this right after validate()). On a
 *  DNS outage the previous state is kept — a resolver hiccup never
 *  drops a badge. */
export async function checkVerification(entry: RegistryEntry): Promise<{
  verification: DomainVerification;
  transition: "gained" | "lost" | null;
}> {
  const prev = entry.verification;
  const now = new Date().toISOString();
  const { domain, platform } = registrableDomainOf(entry.domain);
  const recordName = domain && !platform ? recordNameFor(domain) : null;
  const token = entry.status === "indexed" ? entry.parsed?.registryToken : undefined;

  let result: DomainVerification["result"];
  if (!domain) result = "no-domain";
  else if (platform) result = "platform-subdomain";
  else if (!token) result = "no-token";
  else {
    const values = await lookupTxt(recordName!);
    if (values === null) result = "dns-error";
    else if (values.some(v => v.trim() === token)) result = "found";
    else result = values.length ? "mismatch" : "missing";
  }

  const verified = result === "found" || (result === "dns-error" && prev?.state === "verified");
  const wasVerified = prev?.state === "verified";
  const verification: DomainVerification = {
    state: verified ? "verified" : "unverified",
    method: "dns",
    registrableDomain: domain,
    recordName,
    result,
    lastCheckedAt: now,
    ...(prev?.firstVerifiedAt || result === "found" ? { firstVerifiedAt: prev?.firstVerifiedAt ?? now } : {}),
    ...(result === "found" ? { lastVerifiedAt: now } : prev?.lastVerifiedAt ? { lastVerifiedAt: prev.lastVerifiedAt } : {}),
    ...(!verified && (wasVerified || prev?.missingSince) ? { missingSince: prev?.missingSince ?? now } : {}),
    ...(prev?.rolloutNoticeAt ? { rolloutNoticeAt: prev.rolloutNoticeAt } : {}),
  };
  const transition = verified && !wasVerified ? "gained" : !verified && wasVerified ? "lost" : null;
  return { verification, transition };
}

/** Public, PII-free summary for API responses and pages. */
export function publicVerification(entry: RegistryEntry) {
  const v = entry.verification;
  const rd = v?.registrableDomain ?? registrableDomainOf(entry.domain).domain;
  const platform = v?.result === "platform-subdomain" || registrableDomainOf(entry.domain).platform;
  return {
    contentSource: entry.contentSource ?? "fetched",
    ...(entry.contentSource === "pushed" && entry.pushedAt ? { pushedAt: entry.pushedAt } : {}),
    verified: v?.state === "verified",
    verification: {
      method: "dns" as const,
      state: v?.state ?? "unverified",
      recordName: platform || !rd ? null : recordNameFor(rd),
      registrableDomain: rd,
      platformSubdomain: platform,
      result: v?.result ?? null,
      firstVerifiedAt: v?.firstVerifiedAt ?? null,
      lastVerifiedAt: v?.lastVerifiedAt ?? null,
      lastCheckedAt: v?.lastCheckedAt ?? null,
      missingSince: v?.missingSince ?? null,
    },
  };
}
