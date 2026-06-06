// ============================================================
// KV storage layer for the registry.
//
// Backend: Vercel KV (Upstash Redis). Auto-populated env vars
// in Vercel deployments; locally pulled via `vercel env pull`.
//
// Key shapes:
//   reg:{id}                → JSON-stringified RegistryEntry
//   reg-by-url:{canonicalUrl} → registry ID (URL → ID lookup
//                               for UPSERT semantics)
//   reg-by-domain:{domain}  → Redis Set of registry IDs (for
//                               per-domain dedupe + Phase 2
//                               per-domain index queries)
//   reg-recent              → Redis sorted set keyed by
//                               submittedAt for chronological
//                               browsing in Phase 2
//   rate:submit:ip:{ip}     → counter w/ TTL, per-IP rate limit
//   rate:submit:url:{canonicalUrl} → counter w/ TTL, per-URL
//                                    submission rate limit
//
// TTL: registry entries don't TTL (they're the index). Rate-
// limit counters TTL to 1hr.
//
// Async wrapper: Upstash Redis client is HTTP-based, so each
// call is a single fetch — no connection pooling concerns.
// ============================================================

import { Redis } from "@upstash/redis";
import { randomUUID, randomBytes } from "crypto";
import type { RegistryEntry, PendingClaim } from "./types";

// Lazy client — instantiated on first use so import-time
// doesn't blow up when env vars are missing during build.
let _redis: Redis | null = null;
function getRedis(): Redis {
  if (_redis) return _redis;
  _redis = Redis.fromEnv();
  return _redis;
}

const ENTRY_PREFIX = "reg:";
const BY_URL_PREFIX = "reg-by-url:";
const BY_DOMAIN_PREFIX = "reg-by-domain:";
const RECENT_KEY = "reg-recent";
// Phase 2c follow-on 2026-06-06 — Bug B re-probe queue. Sorted
// set keyed by nextRecheckAt (epoch ms). The /api/registry/seed/
// probe cron drains entries with score <= now in addition to the
// new-domain seed queue, so existing indexed entries get
// re-validated on the cadence set by RECHECK_INTERVAL_DAYS_*
// at submit/probe time. Before this, nextRecheckAt was written
// on every entry but never read — so submitted entries stayed
// frozen forever unless the customer manually resubmitted.
const RECHECK_KEY = "reg-recheck-due";
const RATE_IP_PREFIX = "rate:submit:ip:";
const RATE_URL_PREFIX = "rate:submit:url:";
// ── Phase 4: claim verification ────────────────────────────
const PENDING_CLAIM_PREFIX = "claim-pending:";  // verifyToken → JSON-stringified PendingClaim
const RATE_CLAIM_IP_PREFIX = "rate:claim:ip:";    // per-IP claim submission rate limit
const PENDING_CLAIM_TTL_SECONDS = 24 * 60 * 60;   // 24h magic-link window

/** Generate a fresh registry ID — `reg_{16-char hex}`. */
export function newRegistryId(): string {
  return `reg_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

/** Read one registry entry by ID. */
export async function getEntry(id: string): Promise<RegistryEntry | null> {
  const raw = await getRedis().get<string | RegistryEntry>(`${ENTRY_PREFIX}${id}`);
  if (!raw) return null;
  // Upstash Redis auto-deserializes JSON; depending on how the
  // entry was written (set vs setjson), the read may already be
  // an object. Handle both.
  if (typeof raw === "string") {
    try { return JSON.parse(raw) as RegistryEntry; } catch { return null; }
  }
  return raw as RegistryEntry;
}

/** Look up an entry's ID by its canonical URL. Returns null if
 *  no entry exists for that URL. Used for UPSERT semantics so
 *  resubmitting the same URL updates the existing row rather
 *  than creating a new one. */
export async function findIdByUrl(canonicalUrl: string): Promise<string | null> {
  const id = await getRedis().get<string>(`${BY_URL_PREFIX}${canonicalUrl}`);
  return typeof id === "string" ? id : null;
}

/** Persist a registry entry. UPSERT semantics — writes the
 *  entry hash + the URL→ID lookup + domain set entry + recent-
 *  ordered set entry in one pipeline call. */
export async function saveEntry(entry: RegistryEntry): Promise<void> {
  const r = getRedis();
  // Pipeline → one HTTP round-trip even for multiple writes.
  const pipeline = r.pipeline();
  pipeline.set(`${ENTRY_PREFIX}${entry.id}`, JSON.stringify(entry));
  pipeline.set(`${BY_URL_PREFIX}${entry.url}`, entry.id);
  pipeline.sadd(`${BY_DOMAIN_PREFIX}${entry.domain}`, entry.id);
  // ZADD with score = submittedAt (epoch ms) for chronological
  // ordering. Re-adding an existing member updates its score —
  // fine since the score is the original submission time
  // (immutable per entry).
  const submittedScore = Date.parse(entry.submittedAt) || Date.now();
  pipeline.zadd(RECENT_KEY, { score: submittedScore, member: entry.id });
  // Phase 2c follow-on — also ZADD to the recheck-due sorted set
  // keyed by nextRecheckAt. Re-adding an existing member updates
  // its score, which is exactly what we want when updateEntry
  // pushes nextRecheckAt forward after a successful revalidation.
  // Entries with no nextRecheckAt (theoretically shouldn't happen
  // — submit + probe routes both set it — but defensive) are
  // skipped here; they just won't get auto-re-validated.
  if (entry.nextRecheckAt) {
    const recheckScore = Date.parse(entry.nextRecheckAt);
    if (Number.isFinite(recheckScore)) {
      pipeline.zadd(RECHECK_KEY, { score: recheckScore, member: entry.id });
    }
  }
  await pipeline.exec();
}

/** Pop entries whose nextRecheckAt has passed. Atomic-ish:
 *  ZRANGEBYSCORE to get due ids, then ZREM to clear them so a
 *  concurrent cron tick (shouldn't happen with Vercel cron, but
 *  defensive) doesn't pick up the same id twice. Capped at
 *  `max` ids per call so the cron's overall maxDuration budget
 *  is respected.
 *
 *  Important: removal from the sorted set happens BEFORE
 *  revalidation runs. If the revalidation succeeds, saveEntry
 *  (called via updateEntry) re-adds the entry with the new
 *  nextRecheckAt score. If revalidation FAILS for a transient
 *  reason (network, registry-side bug), the entry is dropped
 *  from the recheck queue — it'll still get re-added the next
 *  time the customer submits via Studio, but won't be
 *  auto-rechecked again until then. Trade-off accepted for v1:
 *  a stuck transient error becomes a one-cycle gap, not an
 *  infinite retry storm. */
export async function popDueRechecks(max: number): Promise<string[]> {
  const r = getRedis();
  const now = Date.now();
  // Upstash Redis zrange with byScore option returns members
  // with score in [min, max]. We want everything from earliest
  // up to and including now.
  const due = await r.zrange<string[]>(RECHECK_KEY, 0, now, {
    byScore: true,
    offset: 0,
    count: max,
  });
  if (!Array.isArray(due) || due.length === 0) return [];
  // Remove the ids we're about to process. ZREM is variadic but
  // we pipeline it to keep it as one round-trip.
  const pipeline = r.pipeline();
  for (const id of due) pipeline.zrem(RECHECK_KEY, id);
  await pipeline.exec();
  return due;
}

/** Patch fields on an existing entry. Reads the whole entry,
 *  merges the patch, writes back. Used by the validation worker
 *  to update status + parsed metadata after the inline check
 *  completes. */
export async function updateEntry(
  id: string,
  patch: Partial<RegistryEntry>,
): Promise<RegistryEntry | null> {
  const existing = await getEntry(id);
  if (!existing) return null;
  const merged: RegistryEntry = { ...existing, ...patch };
  await saveEntry(merged);
  return merged;
}

// ── Rate limiting ───────────────────────────────────────────

/** Per-IP submission rate limit. Returns the current count after
 *  incrementing. v1 caller compares against MAX_PER_IP_PER_HOUR. */
export async function bumpIpRate(ip: string): Promise<number> {
  const key = `${RATE_IP_PREFIX}${ip}`;
  const r = getRedis();
  const count = await r.incr(key);
  if (count === 1) {
    // First hit — set TTL so the counter resets in an hour.
    await r.expire(key, 3600);
  }
  return count;
}

/** Per-URL submission rate limit. Prevents spam-resubmits of the
 *  same URL. */
export async function bumpUrlRate(canonicalUrl: string): Promise<number> {
  const key = `${RATE_URL_PREFIX}${canonicalUrl}`;
  const r = getRedis();
  const count = await r.incr(key);
  if (count === 1) {
    await r.expire(key, 3600);
  }
  return count;
}

/** Read a window of recent registry IDs — used by Phase 2
 *  index page + the dev /list endpoint. Returns newest-first. */
export async function listRecentIds(limit = 50, offset = 0): Promise<string[]> {
  const r = getRedis();
  // ZRANGE with REV gives newest-first by score
  const ids = await r.zrange<string[]>(RECENT_KEY, offset, offset + limit - 1, { rev: true });
  return ids ?? [];
}

/** Resolve the most-recently-indexed entry for a given domain.
 *  Used by the public detail page at registry.citemaps.org/{domain}.
 *
 *  Walks the per-domain Set, hydrates the candidate entries,
 *  filters to status === "indexed", and returns the newest by
 *  lastValidatedAt. Returns null when:
 *    - no entries exist for the domain
 *    - none are currently indexed (all are invalid/timeout/etc)
 *
 *  Per-domain sets are unordered, so this fetches all entries
 *  for the domain. v0.5 acceptable scale (1-10 entries per
 *  domain typical; multi-citemap-per-domain case is rare). When
 *  scale demands, switch to a per-domain sorted set keyed by
 *  lastValidatedAt. */
export async function getEntryByDomain(domain: string): Promise<RegistryEntry | null> {
  if (!domain) return null;
  const r = getRedis();
  const ids = await r.smembers<string[]>(`${BY_DOMAIN_PREFIX}${domain}`);
  if (!ids || ids.length === 0) return null;

  const entries: RegistryEntry[] = [];
  for (const id of ids) {
    const entry = await getEntry(id);
    if (entry && entry.status === "indexed") entries.push(entry);
  }
  if (entries.length === 0) return null;

  // Newest-first by lastValidatedAt (fall back to submittedAt
  // for entries that somehow lack a lastValidatedAt).
  entries.sort((a, b) => {
    const ta = Date.parse(a.lastValidatedAt ?? a.submittedAt) || 0;
    const tb = Date.parse(b.lastValidatedAt ?? b.submittedAt) || 0;
    return tb - ta;
  });
  return entries[0];
}

// ── Phase 4: claim verification ────────────────────────────

/** Generate a fresh claim verification token — `clm_{32-hex}`.
 *  Long because it's a single-use magic-link nonce that lives
 *  in a URL — guess-resistance matters more than human-readability. */
export function newClaimVerifyToken(): string {
  return `clm_${randomBytes(16).toString("hex")}`;
}

/** Save a pending claim with 24h TTL. The verifyToken is the
 *  primary key; the magic-link URL embeds it. */
export async function savePendingClaim(claim: PendingClaim): Promise<void> {
  const r = getRedis();
  await r.set(
    `${PENDING_CLAIM_PREFIX}${claim.verifyToken}`,
    JSON.stringify(claim),
    { ex: PENDING_CLAIM_TTL_SECONDS },
  );
}

/** Read a pending claim by verify token. Returns null when
 *  the token is unknown, malformed, or expired (Redis TTL
 *  evicts after the 24h window). */
export async function getPendingClaim(verifyToken: string): Promise<PendingClaim | null> {
  const raw = await getRedis().get<string | PendingClaim>(
    `${PENDING_CLAIM_PREFIX}${verifyToken}`,
  );
  if (!raw) return null;
  if (typeof raw === "string") {
    try { return JSON.parse(raw) as PendingClaim; } catch { return null; }
  }
  return raw as PendingClaim;
}

/** Delete a pending claim after successful verification. Single-
 *  use semantics — verify URL works exactly once. */
export async function deletePendingClaim(verifyToken: string): Promise<void> {
  await getRedis().del(`${PENDING_CLAIM_PREFIX}${verifyToken}`);
}

/** Per-IP claim submission rate limit. Stricter than submit
 *  (claim sends emails and is more abuse-sensitive). Returns
 *  current count after incrementing. */
export async function bumpClaimIpRate(ip: string): Promise<number> {
  const key = `${RATE_CLAIM_IP_PREFIX}${ip}`;
  const r = getRedis();
  const count = await r.incr(key);
  if (count === 1) {
    await r.expire(key, 3600);
  }
  return count;
}

/** Fetch the full entries for a list of IDs. Used by the dev
 *  /list endpoint + Phase 2 public index page. */
export async function getEntriesByIds(ids: string[]): Promise<RegistryEntry[]> {
  if (ids.length === 0) return [];
  const r = getRedis();
  // Pipeline reads for efficiency.
  const pipeline = r.pipeline();
  for (const id of ids) pipeline.get(`${ENTRY_PREFIX}${id}`);
  const results = await pipeline.exec<Array<string | RegistryEntry | null>>();
  const entries: RegistryEntry[] = [];
  for (const raw of results) {
    if (!raw) continue;
    if (typeof raw === "string") {
      try { entries.push(JSON.parse(raw) as RegistryEntry); } catch { /* skip */ }
    } else {
      entries.push(raw as RegistryEntry);
    }
  }
  return entries;
}
