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
// Real browser UA + trailing CiteMapsRegistry identifier (2026-06-19).
// Empirically chosen against SiteGround's WAF: a bare bot UA and the
// Googlebot-style "Mozilla/5.0 (compatible; …Bot…)" pattern both get 403'd;
// a genuine browser UA passes. Trailing product token keeps us honest +
// allowlistable by name. Mirror of src/lib/claim.ts — keep in sync.
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 CiteMapsRegistry/1.0 (+https://citemaps.org/registry)";

/** Append a unique cache-busting query parameter to a URL. The
 *  param name `_citemap_rv` is unlikely to collide with anything
 *  application-side; the value is the current timestamp.
 *
 *  Why this is necessary: a sizable share of customer hosts
 *  (shared hosting like TigerTech / Bluehost / SiteGround,
 *  managed-WordPress like WP Engine / Kinsta / Flywheel,
 *  Cloudflare-in-front-of-anything) cache static JSON responses
 *  server-side. Default TTLs can be hours. Without a cache-buster
 *  the registry will validate against whatever the cache is
 *  pinning — often the customer's PREVIOUS publish, not the
 *  current one. Symptom: customer re-publishes, registry stays
 *  pinned to the old hash, lastValidatedAt updates but parsed
 *  fields don't.
 *
 *  Why this works: every caching layer in the chain keys on the
 *  full request URL including query string. A unique query param
 *  per request = always a cache miss = always re-fetched from
 *  origin disk. The static-file server (Apache / nginx / etc.)
 *  ignores the query string for static paths so the bytes
 *  returned are identical to what the canonical URL serves.
 *  Net effect: the customer's caching layer keeps caching what
 *  it wants for the rest of the internet, but our validator
 *  always sees the latest published file.
 *
 *  Use ONLY for fetches of citemap-bearing URLs the customer
 *  controls (their own domain + the §1.7 counter-party domains).
 *  Do NOT use for platform-page fetches (YouTube / Vimeo /
 *  podcast-host backlink checks) — those URLs are on external
 *  platforms whose query-string handling varies and may be
 *  defensive against arbitrary params.
 */
function withCacheBuster(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    u.searchParams.set("_citemap_rv", String(Date.now()));
    return u.toString();
  } catch {
    // Unparseable URL — leave it; the fetch will fail downstream
    // with a regular bad-URL error, which is the right outcome.
    return rawUrl;
  }
}

// ── v3.3 §1.7 cross-document verification budgets ───────────
// Per-fetch budget kept tight (8s) since the orchestrator fans
// out in parallel batches and any one slow counter-party can
// hold a slot. Overall budget caps the whole verification pass
// at 25s so total validation time stays inside the submission
// route's await window even on pathological citemaps with many
// cross-doc edges. MAX_PARALLEL_FETCHES caps concurrency to
// prevent a single citemap from saturating outbound sockets.
const CROSS_FETCH_TIMEOUT_MS   = 8_000;
const VERIFY_OVERALL_BUDGET_MS = 25_000;
const MAX_PARALLEL_FETCHES     = 8;

// ── Video Phase 2c: channelOf cross-fetch verification ──────
// Custom-type URI minted by Studio's relationships helper at
// /Users/minime/CoWork/CiteMaps/citemaps-src/src/lib/citemap/
// relationships.ts (VIDEO_EDGE.channelOf). Both ends share the
// same origin (channel @id under {primary-origin}/#channel-{id}
// and `to` = selfId), so channelOf edges are intra-document by
// construction — they never appear in the §1.7 cross-doc edge
// set. Phase 2c adds an orthogonal verification path: fetch the
// MediaChannel @graph node's `url` field (the actual platform
// URL, e.g. https://youtube.com/@entitygraph) and confirm it
// backlinks to the primary entity's domain. Opus 4.8 addendum §4.
const CHANNEL_OF_TYPE = "https://citemaps.org/ext/v1/types/channelOf";
// Tighter per-fetch budget than cross-doc since platform HTML
// pages (YouTube about-tab + similar) are typically larger than
// citemap.json + slower to render. 6s keeps the channelOf pass
// inside the overall 25s verify budget even with ~4 channels to
// verify in parallel. Channel pages can be html-heavy; raise the
// body cap to 2 MB so we don't truncate before the link section
// loads.
const CHANNEL_FETCH_TIMEOUT_MS = 6_000;
const CHANNEL_MAX_BODY_BYTES   = 2_097_152; // 2 MB
// Freshness window per v3.3 §1.7 step 3: "fresh (< 6 months
// old)". 180 days = 6 × 30; slightly conservative vs calendar
// months but stable across month-length variation.
const FRESHNESS_WINDOW_MS = 180 * 24 * 60 * 60 * 1000;

/** v3.3 §2.5 inverse-edge taxonomy.
 *
 *  For each forward edge type, the array lists relationship-row
 *  types that would constitute a valid inverse claim in the
 *  counter-party's citemap. An inverse-type row with `to` set
 *  to OUR primary @id confirms the forward edge.
 *
 *  Types omitted (or with empty arrays) have no reciprocal
 *  emission pattern in practice — `franchiseOf`, `founderOf`,
 *  `sellsAt` per §2.5, plus `memberOf` (orgs rarely publish
 *  per-member edges). For these, verification falls back to
 *  the inline mirror check only (which is also weak for them),
 *  so they almost always stay unverified. That's the documented
 *  spec outcome — not a bug.
 *
 *  Symmetric types (`affiliatedWith`, `sameAs`) list themselves
 *  as their own inverse — schema.org treats both as bidirectional
 *  assertions of relationship.
 */
const INVERSE_EDGE_TYPES: Record<string, string[]> = {
  // ── §2.1 schema.org-native ──
  parentOrganizationOf: ["subOrganizationOf"],
  subOrganizationOf:    ["parentOrganizationOf"],
  memberOf:             [],
  worksFor:             ["practitionerAt"],
  affiliatedWith:       ["affiliatedWith"],
  founderOf:            [],
  sameAs:               ["sameAs"],
  // ── §2.2 CiteMaps extensions ──
  franchiseOf:          [],
  locationOf:           ["locationOf"],
  practitionerAt:       ["worksFor"],
  predecessorOf:        ["successorOf"],
  successorOf:          ["predecessorOf"],
  // operatesAs handled separately — auto-verified self-edge
  sellsAt:              [],
};

/** v3.3 §1.6 inline-mirror schema.org property map.
 *
 *  For each schema.org-native forward edge type, the array
 *  lists property names on the counter-party's brand/entity
 *  object whose inclusion of OUR primary @id also confirms the
 *  edge (per §1.6's MUST emit both inline + relationships[] row).
 *
 *  Used as a fallback when the counter-party's relationships[]
 *  doesn't carry an inverse-type row — for example a v3.2-era
 *  producer that emits inline schema.org properties but hasn't
 *  adopted the v3.3 relationships[] block.
 *
 *  Extension types (§2.2) have no schema.org inline mirror —
 *  this map only covers the §2.1 set.
 */
const INLINE_MIRROR_PROPS: Record<string, string[]> = {
  parentOrganizationOf: ["subOrganization"],
  subOrganizationOf:    ["parentOrganization"],
  memberOf:             ["member"],
  worksFor:             ["employee"],
  affiliatedWith:       ["affiliation"],
  founderOf:            ["founder"],
  sameAs:               ["sameAs"],
};

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

  // Fetch with timeout + size cap. The canonical `url` stays
  // unchanged in storage / responses — only the actual outbound
  // request URL gets the cache-buster (see withCacheBuster
  // docstring for the customer-host caching rationale).
  const fetchUrl = withCacheBuster(url);
  let response: Response;
  let body: string;
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      response = await fetch(fetchUrl, {
        method: "GET",
        signal: controller.signal,
        headers: {
          "Accept": "application/json, text/html, application/ld+json",
          "Accept-Language": "en-US,en;q=0.9",
          "User-Agent": USER_AGENT,
          // Belt-and-suspenders: explicit no-cache request
          // headers. Most caching layers honor URL uniqueness
          // over these headers, but a few proxies (Cloudflare
          // with certain page-rule configs) also respect
          // Cache-Control on the request. Cheap insurance.
          "Cache-Control": "no-cache, no-store, must-revalidate",
          "Pragma": "no-cache",
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

  // v3.3 §1.7 cross-document verification pass. Runs after
  // shape validation; never blocks indexing per §1.7 step 4.
  // No-ops when the document has no cross-doc relationships.
  // Bounded by VERIFY_OVERALL_BUDGET_MS so a slow counter-party
  // can't extend the submission route's await window indefinitely.
  try {
    const verify = await verifyCrossDocumentEdges(citemapJson);
    if (verify.totalCrossDoc > 0 || verify.verifiedSelf > 0) {
      parsed.crossDocEdgeCount = verify.totalCrossDoc;
      parsed.verifiedEdgeCount = verify.verified;
      parsed.verifiedSelfEdgeCount = verify.verifiedSelf;
    }
  } catch {
    // Verification failure MUST NOT block indexing per §1.7
    // step 4. Swallow silently — the absence of verification
    // fields on parsed is itself the signal that we tried and
    // couldn't complete the pass.
  }

  // Video Phase 2c (2026-06-06) — channelOf cross-fetch
  // verification. Orthogonal to §1.7 cross-doc verification
  // because channelOf edges are intra-document (both endpoints
  // mint under the primary's origin). Instead we fetch each
  // MediaChannel node's platform URL (the youtube.com / vimeo /
  // etc. page) and confirm it backlinks to the primary's
  // domain. Same swallow-on-failure rule per §1.7 step 4 —
  // an unverified channelOf edge stays valid published signal.
  try {
    const channelVerify = await verifyChannelOwnership(citemapJson);
    if (channelVerify.totalChannelOf > 0) {
      parsed.channelOwnershipEdgeCount = channelVerify.totalChannelOf;
      parsed.verifiedChannelOwnershipEdgeCount = channelVerify.verified;
    }
  } catch {
    // Same posture as cross-doc: never block indexing on a
    // verification failure.
  }

  return {
    ok: true,
    format,
    status: "indexed",
    parsed,
  };
}

// ── v3.3 §1.7 cross-document verification ─────────────────

/** Orchestrate cross-document edge verification per v3.3 §1.7.
 *
 *  Walks relationships[], classifies each edge as:
 *    - operatesAs self-edge → auto-verified (§2.5)
 *    - local (both endpoints in this document) → not counted
 *      (verification within a single document is trivial; v1
 *      scope is cross-document only)
 *    - cross-document (`to` is absolute http(s) URL outside
 *      local @id set) → fetch counter-party + check inverse
 *
 *  Counter-party fetches are deduped by URL (multiple edges to
 *  the same target reuse a single fetch), run in parallel
 *  batches capped at MAX_PARALLEL_FETCHES, and time-budgeted
 *  by VERIFY_OVERALL_BUDGET_MS. Fetch failures and missing
 *  inverse edges leave the per-edge verified state at false
 *  per §1.7 step 4; this function only returns aggregate
 *  counts.
 */
async function verifyCrossDocumentEdges(
  obj: Record<string, unknown>,
): Promise<{ totalCrossDoc: number; verified: number; verifiedSelf: number }> {
  const rels = Array.isArray(obj.relationships) ? obj.relationships : [];
  if (rels.length === 0) {
    return { totalCrossDoc: 0, verified: 0, verifiedSelf: 0 };
  }

  // Identify primary @id — required to know what counter-party
  // inverse edges should point AT to confirm us.
  const brand = obj.brand as Record<string, unknown> | undefined;
  const entity = obj.entity as Record<string, unknown> | undefined;
  const primary = brand ?? entity;
  const primaryId = primary && typeof primary["@id"] === "string"
    ? (primary["@id"] as string)
    : null;
  if (!primaryId) {
    return { totalCrossDoc: 0, verified: 0, verifiedSelf: 0 };
  }

  // Local @id set: primary + every @graph node @id. Edges with
  // `to` in this set are local (intra-document); edges with `to`
  // not in this set AND matching isAbsoluteHttpUrl are cross-doc.
  const localIds = new Set<string>([primaryId]);
  const graph = Array.isArray(obj["@graph"]) ? obj["@graph"] : [];
  for (const node of graph) {
    if (node && typeof node === "object" && !Array.isArray(node)) {
      const id = (node as Record<string, unknown>)["@id"];
      if (typeof id === "string") localIds.add(id);
    }
  }

  let verifiedSelf = 0;
  const crossDocEdges: Array<{ to: string; type: string }> = [];

  for (const rel of rels) {
    if (!rel || typeof rel !== "object") continue;
    const r = rel as Record<string, unknown>;
    const from = r.from;
    const to = r.to;
    const type = r.type;
    if (typeof from !== "string" || typeof to !== "string" || typeof type !== "string") {
      continue;
    }

    // §2.5 operatesAs self-edge → intrinsically self-verifying.
    // No fetch needed; the primary is asserting about itself.
    if (from === to && type === "operatesAs") {
      verifiedSelf++;
      continue;
    }

    // Skip local edges — both endpoints inside this document.
    // Verification within a single document is trivially true
    // (the producer asserts both sides); not in v1 scope.
    if (localIds.has(to)) continue;

    // Cross-document: must be an absolute http(s) URL. URN /
    // relative / opaque @id schemes can't be fetched, so they
    // stay unverified by definition.
    if (!isAbsoluteHttpUrl(to)) continue;

    crossDocEdges.push({ to, type });
  }

  if (crossDocEdges.length === 0) {
    return { totalCrossDoc: 0, verified: 0, verifiedSelf };
  }

  // Dedupe counter-party fetches by URL (fragment-stripped, so
  // multiple edges pointing at different fragments of the same
  // document share one fetch). Typical case: a citemap with 3
  // edges all pointing at parent corp's #org / #parent-org /
  // similar share a single document.
  const targetUrls = Array.from(new Set(crossDocEdges.map(e => stripFragment(e.to))));

  // Overall budget controller — fires once we exceed
  // VERIFY_OVERALL_BUDGET_MS regardless of how many fetches
  // are still in flight. Each crossFetchCitemap call subscribes
  // to this signal and aborts when fired.
  const overallController = new AbortController();
  const overallTimeout = setTimeout(
    () => overallController.abort(),
    VERIFY_OVERALL_BUDGET_MS,
  );

  try {
    const counterParties = new Map<
      string,
      { json: Record<string, unknown>; lastModified: string | null } | null
    >();

    // Parallel batches — fan out MAX_PARALLEL_FETCHES at a time
    // to bound concurrent outbound sockets.
    for (let i = 0; i < targetUrls.length; i += MAX_PARALLEL_FETCHES) {
      if (overallController.signal.aborted) break;
      const batch = targetUrls.slice(i, i + MAX_PARALLEL_FETCHES);
      const results = await Promise.all(
        batch.map(async (url) => ({
          url,
          result: await crossFetchCitemap(url, overallController.signal),
        })),
      );
      for (const { url, result } of results) counterParties.set(url, result);
    }

    let verified = 0;
    for (const edge of crossDocEdges) {
      const cp = counterParties.get(stripFragment(edge.to));
      if (!cp) continue;  // fetch failed / blocked / timed out
      if (!isCounterPartyFresh(cp.json, cp.lastModified)) continue;
      if (!findInverseEdge(cp.json, primaryId, edge.type)) continue;
      verified++;
    }

    return { totalCrossDoc: crossDocEdges.length, verified, verifiedSelf };
  } finally {
    clearTimeout(overallTimeout);
  }
}

// ── Video Phase 2c: channelOf cross-fetch verification ─────

/** Verify channelOf edges by fetching each MediaChannel node's
 *  platform URL and checking for a backlink to the primary
 *  entity's domain. Per Opus 4.8 video addendum §4:
 *
 *    "A channel-backlink to the DNS-verified citemap is a
 *    stronger ownership signal than the YouTube verified
 *    badge — anyone who controls the channel can place the
 *    backlink; only the domain owner can place the citemap."
 *
 *  Verification model is intentionally simple — substring match
 *  on the primary's hostname in the page HTML. Catches the
 *  common case (channel About tab + description listing the
 *  website URL) without committing to a brittle parse of every
 *  platform's specific HTML shape. False negatives (legit
 *  ownership claim where the channel page doesn't expose the
 *  link in HTML — SPA-rendered after JS) leave the edge
 *  unverified, same as cross-doc fetch failures.
 *
 *  Returns aggregate counts only; per-edge verified state is
 *  computed by the validator at read time from these aggregates
 *  + the relationships[] structure.
 */
async function verifyChannelOwnership(
  obj: Record<string, unknown>,
): Promise<{ totalChannelOf: number; verified: number }> {
  const rels = Array.isArray(obj.relationships) ? obj.relationships : [];
  if (rels.length === 0) {
    return { totalChannelOf: 0, verified: 0 };
  }

  // Identify primary entity's domain — the backlink target.
  // Pull from brand.url (preferred) or brand.domain (fallback).
  // Without a parseable primary domain we have nothing to
  // verify against; return early.
  const brand = obj.brand as Record<string, unknown> | undefined;
  const entity = obj.entity as Record<string, unknown> | undefined;
  const primary = brand ?? entity;
  if (!primary) {
    return { totalChannelOf: 0, verified: 0 };
  }
  const primaryUrl = typeof primary.url === "string" ? primary.url : "";
  const primaryDomain = typeof primary.domain === "string" ? primary.domain : "";
  const primaryHost = primaryDomain.trim() || hostOf(primaryUrl);
  if (!primaryHost) {
    return { totalChannelOf: 0, verified: 0 };
  }
  // Normalize: strip www. + lowercase for the substring match.
  // YouTube/etc. pages often show the URL without the www. prefix
  // even when the canonical includes it (and vice versa). Match
  // on the bare host portion to maximize legitimate hits.
  const needle = primaryHost.toLowerCase().replace(/^www\./, "");
  if (!needle || needle.length < 4) {
    // Defensive — a sub-4-char hostname needle would false-positive
    // on virtually any HTML page. Skip entirely.
    return { totalChannelOf: 0, verified: 0 };
  }

  // Index @graph nodes by @id so each channelOf edge can find
  // its MediaChannel node + read the platform `url`. Channel
  // nodes are minted by Studio's relationships helper as
  // multi-typed ["Organization", <MediaChannel ext URL>] with
  // the platform URL on node.url. Edges with no resolvable @id
  // (validator missed an orphan; or hand-authored row with bad
  // from) get skipped — no node, no fetch target.
  const graph = Array.isArray(obj["@graph"]) ? obj["@graph"] : [];
  const nodeById = new Map<string, Record<string, unknown>>();
  for (const node of graph) {
    if (node && typeof node === "object" && !Array.isArray(node)) {
      const id = (node as Record<string, unknown>)["@id"];
      if (typeof id === "string") {
        nodeById.set(id, node as Record<string, unknown>);
      }
    }
  }

  // Collect channelOf edges + their fetchable channel URLs.
  // Dedupe by URL so multiple channelOf edges pointing at the
  // same channel (shouldn't happen per the catalog model but
  // defensive) share a single fetch.
  const claims: Array<{ url: string }> = [];
  const seenUrls = new Set<string>();
  for (const rel of rels) {
    if (!rel || typeof rel !== "object") continue;
    const r = rel as Record<string, unknown>;
    if (r.type !== CHANNEL_OF_TYPE) continue;
    const from = typeof r.from === "string" ? r.from : "";
    if (!from) continue;
    const channelNode = nodeById.get(from);
    if (!channelNode) continue;
    const channelUrl = typeof channelNode.url === "string" ? channelNode.url.trim() : "";
    if (!channelUrl || !isAbsoluteHttpUrl(channelUrl)) continue;
    if (seenUrls.has(channelUrl)) continue;
    seenUrls.add(channelUrl);
    claims.push({ url: channelUrl });
  }

  if (claims.length === 0) {
    return { totalChannelOf: 0, verified: 0 };
  }

  // Overall budget — shares the VERIFY_OVERALL_BUDGET_MS ceiling
  // with cross-doc verification. In practice these run
  // sequentially (cross-doc first, then channelOf), so the
  // channelOf pass effectively gets whatever budget remains. We
  // re-arm a fresh controller here because the cross-doc
  // controller has already cleared; the orchestrator's outer
  // try/catch ensures total await time stays bounded by the
  // submission route's request timeout regardless.
  const overallController = new AbortController();
  const overallTimeout = setTimeout(
    () => overallController.abort(),
    VERIFY_OVERALL_BUDGET_MS,
  );

  try {
    let verified = 0;
    // Parallel batches — same cap as cross-doc fetches to bound
    // concurrent outbound sockets across both verification passes
    // running back-to-back.
    for (let i = 0; i < claims.length; i += MAX_PARALLEL_FETCHES) {
      if (overallController.signal.aborted) break;
      const batch = claims.slice(i, i + MAX_PARALLEL_FETCHES);
      const results = await Promise.all(
        batch.map(async (c) => fetchAndCheckBacklink(c.url, needle, overallController.signal)),
      );
      verified += results.filter(Boolean).length;
    }

    return { totalChannelOf: claims.length, verified };
  } finally {
    clearTimeout(overallTimeout);
  }
}

/** Fetch a channel URL with SSRF + timeout + body-cap guards
 *  and check whether the response HTML contains the primary
 *  entity's hostname. Returns true when the backlink is found,
 *  false on any fetch failure / not-found.
 *
 *  Match is case-insensitive substring on the host needle (already
 *  lowercased + www-stripped by caller). Doesn't try to
 *  distinguish "link to our site" from "mention of our domain in
 *  unrelated context" — for ownership-claim verification the
 *  signal is "domain owner placed a reference," which the
 *  substring captures with very low false-positive risk (a
 *  channel page mentioning an arbitrary other domain in passing
 *  is rare).
 */
async function fetchAndCheckBacklink(
  url: string,
  needle: string,
  parentSignal: AbortSignal,
): Promise<boolean> {
  // SSRF gate — same posture as crossFetchCitemap. Channel URLs
  // SHOULD be public platforms (YouTube, Vimeo, podcast hosts),
  // but a malicious citemap could mint a MediaChannel node
  // pointing at internal infra. Block before any TCP connect.
  const host = hostOf(url);
  if (!host || isPrivateHost(host)) return false;

  // Per-fetch controller — aborts on either the per-fetch
  // timeout OR the parent overall-budget signal, whichever
  // fires first.
  const controller = new AbortController();
  const fetchTimeout = setTimeout(() => controller.abort(), CHANNEL_FETCH_TIMEOUT_MS);
  const onParentAbort = () => controller.abort();
  if (parentSignal.aborted) {
    clearTimeout(fetchTimeout);
    return false;
  }
  parentSignal.addEventListener("abort", onParentAbort);

  try {
    const response = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      headers: {
        // Channel pages are HTML; accept html primarily but allow
        // a broad set so platforms that vary by accept header
        // don't 406 us.
        "Accept": "text/html, application/xhtml+xml, */*;q=0.8",
        "User-Agent": USER_AGENT,
      },
      redirect: "follow",
    });
    if (!response.ok) return false;

    // Body-cap with channel-specific limit (2 MB vs cross-doc's
    // 1 MB) — platform HTML is typically larger because of
    // inline scripts + tracking pixels + JSON blobs.
    const contentLength = parseInt(response.headers.get("content-length") ?? "0", 10);
    if (contentLength > CHANNEL_MAX_BODY_BYTES) return false;
    const body = await response.text();
    if (body.length > CHANNEL_MAX_BODY_BYTES) return false;

    // Substring match on the lowercased needle. Platform HTML
    // (YouTube, Vimeo, podcast hosts) typically renders the
    // owner's website in About-tab + description as either an
    // <a href> or a plain-text URL. Either form contains the
    // hostname as a substring.
    return body.toLowerCase().includes(needle);
  } catch {
    // AbortError / network error / non-2xx — all unverified.
    return false;
  } finally {
    clearTimeout(fetchTimeout);
    parentSignal.removeEventListener("abort", onParentAbort);
  }
}

/** SSRF-guarded counter-party citemap fetch. Mirrors the
 *  primary validate() fetch posture: hostOf + isPrivateHost
 *  gate, AbortController timeout, capped body read. Closes
 *  Finding B (the §1.7 cross-fetch surface that the original
 *  single-URL SSRF gate doesn't cover).
 *
 *  Returns null on any failure — bad URL, private host,
 *  network error, timeout, non-2xx, non-citemap body. Caller
 *  treats null as "stays unverified" per §1.7 step 4.
 *
 *  Honors the parent overall-budget signal: aborts immediately
 *  when the verification pass's outer budget fires, so a slow
 *  counter-party can't extend the overall pass beyond
 *  VERIFY_OVERALL_BUDGET_MS.
 */
async function crossFetchCitemap(
  url: string,
  parentSignal: AbortSignal,
): Promise<{ json: Record<string, unknown>; lastModified: string | null } | null> {
  // SSRF gate — same posture as validate()'s primary fetch.
  // Catches localhost / 127.0.0.1 / 10.x / 192.168.x / 169.254.x
  // (link-local + cloud metadata) / IPv6 private. A malicious
  // citemap could list relationships[].to pointing at internal
  // infra; this gate stops the fetch before any TCP connect.
  const host = hostOf(url);
  if (!host || isPrivateHost(host)) return null;

  // Strip fragment for fetch — the @id may include #org or
  // similar but the fetchable URL is the document itself.
  const fetchUrl = stripFragment(url);

  // Per-fetch controller — aborts on either the per-fetch
  // timeout OR the parent overall-budget signal, whichever
  // fires first.
  const controller = new AbortController();
  const fetchTimeout = setTimeout(() => controller.abort(), CROSS_FETCH_TIMEOUT_MS);
  const onParentAbort = () => controller.abort();
  if (parentSignal.aborted) {
    clearTimeout(fetchTimeout);
    return null;
  }
  parentSignal.addEventListener("abort", onParentAbort);

  try {
    // Cache-bust the counter-party fetch too — §1.7 reciprocity
    // checks against a stale cached version of the counter-party
    // citemap would mark valid reciprocal edges as unverified
    // (or vice versa) for hours after a counter-party publishes.
    // Same rationale as the primary validate() fetch above.
    const response = await fetch(withCacheBuster(fetchUrl), {
      method: "GET",
      signal: controller.signal,
      headers: {
        "Accept": "application/json, application/ld+json, text/html",
        "User-Agent": USER_AGENT,
        "Cache-Control": "no-cache, no-store, must-revalidate",
        "Pragma": "no-cache",
      },
      redirect: "follow",
    });
    if (!response.ok) return null;

    const lastModified = response.headers.get("last-modified");
    const body = await readBodyCapped(response);
    const contentType = (response.headers.get("content-type") ?? "").toLowerCase();

    let parsed: Record<string, unknown> | null = null;
    if (contentType.includes("application/json") || contentType.includes("application/ld+json")) {
      try {
        parsed = JSON.parse(body) as Record<string, unknown>;
      } catch {
        return null;
      }
    } else if (contentType.includes("text/html") || contentType.includes("application/xhtml")) {
      parsed = extractCitemapFromHtml(body);
    } else {
      // Sniff
      const trimmed = body.trimStart();
      if (trimmed.startsWith("{")) {
        try {
          parsed = JSON.parse(body) as Record<string, unknown>;
        } catch {
          return null;
        }
      } else if (trimmed.startsWith("<")) {
        parsed = extractCitemapFromHtml(body);
      }
    }

    if (!parsed || !isCitemapShape(parsed)) return null;
    return { json: parsed, lastModified };
  } catch {
    // AbortError / network error / readBodyCapped throw on
    // oversized body — all treated as "fetch failed, stays
    // unverified" per §1.7 step 4.
    return null;
  } finally {
    clearTimeout(fetchTimeout);
    parentSignal.removeEventListener("abort", onParentAbort);
  }
}

/** §1.7 inverse-edge detection. Returns true when the
 *  counter-party citemap asserts a relationship pointing back
 *  at our primary @id that's compatible with the forward
 *  edge's type — either as a relationships[] row of an inverse
 *  type (§2.5) or as an inline schema.org mirror property
 *  (§1.6) for the seven §2.1 native types. */
function findInverseEdge(
  counterParty: Record<string, unknown>,
  ourPrimaryId: string,
  forwardType: string,
): boolean {
  // 1. relationships[] row of an inverse type pointing at us.
  const inverses = INVERSE_EDGE_TYPES[forwardType] ?? [];
  if (inverses.length > 0) {
    const rels = Array.isArray(counterParty.relationships)
      ? counterParty.relationships
      : [];
    for (const rel of rels) {
      if (!rel || typeof rel !== "object") continue;
      const r = rel as Record<string, unknown>;
      const to = r.to;
      const type = r.type;
      if (typeof to !== "string" || typeof type !== "string") continue;
      if (to === ourPrimaryId && inverses.includes(type)) return true;
    }
  }

  // 2. Inline schema.org mirror property on the counter-party's
  // brand/entity object. Per §1.6, schema.org-native types MUST
  // be mirrored inline AND in relationships[]; this branch
  // catches v3.2-era producers who emit inline only.
  const mirrors = INLINE_MIRROR_PROPS[forwardType] ?? [];
  if (mirrors.length === 0) return false;
  const cpBrand = counterParty.brand as Record<string, unknown> | undefined;
  const cpEntity = counterParty.entity as Record<string, unknown> | undefined;
  const cpSource = cpBrand ?? cpEntity;
  if (!cpSource) return false;
  for (const prop of mirrors) {
    if (referencesId(cpSource[prop], ourPrimaryId)) return true;
  }

  return false;
}

/** Walk a schema.org property value looking for a reference to
 *  the target @id. Handles the common JSON-LD shapes: bare
 *  string ID, object with `@id`, or array of either. */
function referencesId(value: unknown, targetId: string): boolean {
  if (!value) return false;
  if (typeof value === "string") return value === targetId;
  if (Array.isArray(value)) return value.some(v => referencesId(v, targetId));
  if (typeof value === "object") {
    const id = (value as Record<string, unknown>)["@id"];
    return typeof id === "string" && id === targetId;
  }
  return false;
}

/** §1.7 step 3 freshness gate. Counter-party must be < 6
 *  months old by one of: top-level `lastVerified`, top-level
 *  `lastUpdated`, `citationContract.lastUpdated`, the most
 *  recent `temporalRecord.events[].date`, or HTTP
 *  `Last-Modified` header.
 *
 *  Returns false when no date signal can be parsed — a
 *  counter-party that can't prove freshness stays unverified
 *  per §1.7 step 4 (conservative: absence of evidence is not
 *  evidence of freshness). */
function isCounterPartyFresh(
  counterParty: Record<string, unknown>,
  lastModified: string | null,
): boolean {
  const candidates: Array<string | undefined> = [];

  // Top-level fields the spec explicitly cites
  if (typeof counterParty.lastVerified === "string") {
    candidates.push(counterParty.lastVerified as string);
  }
  if (typeof counterParty.lastUpdated === "string") {
    candidates.push(counterParty.lastUpdated as string);
  }

  // citationContract.lastUpdated — most commonly populated by
  // the citemaps.ai emitter even when the top-level isn't.
  const cc = counterParty.citationContract as Record<string, unknown> | undefined;
  if (cc && typeof cc.lastUpdated === "string") {
    candidates.push(cc.lastUpdated as string);
  }

  // temporalRecord — pull the most recent event date if events
  // are present. Per §3, temporalRecord is always-on but may be
  // an empty array.
  const tr = counterParty.temporalRecord;
  if (Array.isArray(tr)) {
    const dates = tr
      .map(ev => (ev && typeof ev === "object" ? (ev as Record<string, unknown>).date : null))
      .filter((d): d is string => typeof d === "string");
    if (dates.length > 0) {
      const sorted = [...dates].sort();
      candidates.push(sorted[sorted.length - 1]);  // latest
    }
  } else if (tr && typeof tr === "object") {
    const trObj = tr as Record<string, unknown>;
    if (typeof trObj.lastVerified === "string") candidates.push(trObj.lastVerified as string);
    if (typeof trObj.lastUpdated === "string") candidates.push(trObj.lastUpdated as string);
  }

  // HTTP Last-Modified — final fallback per §1.7.
  if (lastModified) candidates.push(lastModified);

  const now = Date.now();
  for (const raw of candidates) {
    if (!raw) continue;
    const ts = Date.parse(raw);
    if (Number.isNaN(ts)) continue;
    if (now - ts < FRESHNESS_WINDOW_MS) return true;
  }
  return false;
}

function isAbsoluteHttpUrl(s: string): boolean {
  return /^https?:\/\//i.test(s);
}

function stripFragment(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    return u.toString();
  } catch {
    return url;
  }
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

  // Verticals — CANONICAL location is brand.taxonomy.{primaryVertical,
  // additionalVerticals} (v3.2+ taxonomy object, what the generator emits).
  // Fall back to the legacy root/brand `verticals[]` array for older citemaps.
  // (Without the taxonomy path the registry showed "no verticals declared" for
  // every modern entry — the data was there, just under brand.taxonomy.)
  const taxonomy = (brand?.taxonomy ?? obj.taxonomy) as Record<string, unknown> | undefined;
  const taxoVerticals: string[] = [];
  if (taxonomy) {
    if (typeof taxonomy.primaryVertical === "string" && taxonomy.primaryVertical) {
      taxoVerticals.push(taxonomy.primaryVertical);
    }
    if (Array.isArray(taxonomy.additionalVerticals)) {
      for (const v of taxonomy.additionalVerticals) if (typeof v === "string" && v) taxoVerticals.push(v);
    }
  }
  const legacyRaw = (obj.verticals ?? brand?.verticals ?? []) as unknown;
  const legacyVerticals = Array.isArray(legacyRaw)
    ? legacyRaw.filter((v): v is string => typeof v === "string")
    : [];
  const vs = taxoVerticals.length > 0 ? taxoVerticals : legacyVerticals;
  if (vs.length > 0) {
    out.verticals = vs;
    out.primaryVertical = vs[0];
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
    [(Array.isArray(obj.verticals) && (obj.verticals as unknown[]).length > 0)
      || (isObject(source?.taxonomy) && typeof (source!.taxonomy as Record<string, unknown>).primaryVertical === "string"), 5],
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
