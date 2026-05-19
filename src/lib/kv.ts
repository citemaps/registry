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
import { randomUUID } from "crypto";
import type { RegistryEntry } from "./types";

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
const RATE_IP_PREFIX = "rate:submit:ip:";
const RATE_URL_PREFIX = "rate:submit:url:";

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
  await pipeline.exec();
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
export async function listRecentIds(limit = 50): Promise<string[]> {
  const r = getRedis();
  // ZRANGE with REV gives newest-first by score
  const ids = await r.zrange<string[]>(RECENT_KEY, 0, limit - 1, { rev: true });
  return ids ?? [];
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
