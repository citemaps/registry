// ============================================================
// Seed queue + probe — auto-discovery worker for Phase 3 of the
// citemaps.org-registry ADR.
//
// Mechanism:
//   1. Studio (citemaps.ai) observes external domains in user
//      Property data — competitors[], NAP listings, storefronts,
//      Outreach targets, Citation Monitor cited domains.
//   2. Studio POSTs those domains to /api/registry/seed in
//      fire-and-forget batches.
//   3. /api/registry/seed pushes each new domain onto a Redis
//      list `seed:queue` and sets a 30-day `seed:seen:{domain}`
//      TTL marker so the same domain isn't re-enqueued during
//      the window.
//   4. A Vercel cron hits /api/registry/seed/probe every N
//      minutes — drains a batch from the queue, probes each
//      domain at the known citemap paths, and on hit feeds the
//      existing validate.ts + saveEntry pipeline with
//      intakeSource: "domain_probe".
//   5. Misses are silent — no registry row written. The 30-day
//      `seen` marker keeps us from retrying the same domain
//      uselessly during the window.
//
// Zero marginal cost — no paid APIs, no external dependencies
// beyond Upstash Redis (already provisioned for the registry).
// Self-reinforcing — every Studio interaction enriches the
// seed corpus.
// ============================================================

import { Redis } from "@upstash/redis";

const SEED_QUEUE_KEY    = "seed:queue";
const SEED_SEEN_PREFIX  = "seed:seen:";
const SEED_SEEN_TTL_SEC = 30 * 86_400;   // 30 days

// Lazy client — same pattern as kv.ts.
let _redis: Redis | null = null;
function getRedis(): Redis {
  if (_redis) return _redis;
  _redis = Redis.fromEnv();
  return _redis;
}

/** Enqueue a domain for auto-discovery probing. Idempotent
 *  inside the 30-day window: if `seed:seen:{domain}` already
 *  exists, returns false and skips the LPUSH. Otherwise sets
 *  the marker + pushes the domain.
 *
 *  Returns true when newly queued, false when already seen. */
export async function pushToSeedQueue(domain: string): Promise<boolean> {
  const norm = domain.toLowerCase().trim();
  if (!norm) return false;
  const seenKey = `${SEED_SEEN_PREFIX}${norm}`;
  const r = getRedis();
  // SET with NX (only set if absent) + EX (TTL). Upstash returns
  // "OK" on set, null when NX prevented the set.
  const setResult = await r.set(seenKey, "1", { nx: true, ex: SEED_SEEN_TTL_SEC });
  if (!setResult) return false;
  await r.lpush(SEED_QUEUE_KEY, norm);
  return true;
}

/** Pop up to N domains off the queue (FIFO when paired with
 *  LPUSH). Used by the probe cron handler. */
export async function popFromSeedQueue(n: number): Promise<string[]> {
  if (n <= 0) return [];
  const r = getRedis();
  const items: string[] = [];
  // Upstash supports RPOP with count in newer versions; we loop
  // for portability + bounded latency per call.
  for (let i = 0; i < n; i++) {
    const d = await r.rpop<string>(SEED_QUEUE_KEY);
    if (!d) break;
    items.push(d);
  }
  return items;
}

/** Length of the queue — for the probe handler to report depth. */
export async function seedQueueLength(): Promise<number> {
  const len = await getRedis().llen(SEED_QUEUE_KEY);
  return typeof len === "number" ? len : 0;
}

// ── Probe ─────────────────────────────────────────────────────

/** Standard discovery paths checked per domain in order.
 *  First reachable path wins — validate.ts will do the full
 *  fetch + parse on whichever URL we return. */
const PROBE_PATHS = [
  "/citemap.json",
  "/citemap.html",
  "/citemap",
  "/.well-known/citemap",
] as const;

const PROBE_TIMEOUT_MS = 5_000;
const PROBE_USER_AGENT = "CiteMapsRegistry-Probe/0.1 (+https://citemaps.org)";

export interface ProbeResult {
  domain: string;
  /** Canonical URL of the found citemap, or null on miss. */
  url: string | null;
  /** Path that matched, when url is non-null. */
  matchedPath?: string;
  /** HTTP status of the matched response, when url is non-null. */
  status?: number;
}

/** Probe a single domain — tries each known citemap path with a
 *  short timeout. Returns the first URL that returns 200 OK,
 *  or null when all paths miss/error. */
export async function probeDomain(domain: string): Promise<ProbeResult> {
  for (const path of PROBE_PATHS) {
    const url = `https://${domain}${path}`;
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
      let res: Response;
      try {
        res = await fetch(url, {
          method: "GET",
          signal: controller.signal,
          redirect: "follow",
          headers: {
            "Accept": "application/json, text/html, application/ld+json",
            "User-Agent": PROBE_USER_AGENT,
          },
        });
      } finally {
        clearTimeout(timeoutId);
      }
      if (res.ok) {
        return { domain, url, matchedPath: path, status: res.status };
      }
      // 404 / 5xx on this path — continue to next.
    } catch {
      // Timeout, DNS failure, TLS error, connection refused —
      // try next path. Domain-level failures (no DNS at all)
      // will burn one timeout per path; acceptable v1 cost.
    }
  }
  return { domain, url: null };
}
