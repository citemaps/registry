// ============================================================
// POST /api/registry/revalidate
//
// Admin tool: re-run validate() on every indexed entry against its STORED url
// and re-save the parsed record. One call refreshes the whole index after a
// parser/schema change (e.g. the entity-graph adapter) — no need to know or
// re-submit individual URLs.
//
// Auth: bearer REGISTRY_SUBMIT_TOKEN, same gate as /submit. When that env is
// unset, the endpoint is open (matches submit's posture).
//
// Query: ?max=N (default 500, cap 2000) bounds how many entries to process in
// one call — each entry does a live fetch, so a very large index should be
// chunked across calls (or moved to a queue later). Returns a per-entry summary.
// ============================================================
import { NextRequest, NextResponse } from "next/server";
import { listRecentIds, getEntriesByIds, updateEntry, deleteEntry } from "@/lib/kv";
import { validate } from "@/lib/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const PAGE = 50;

export async function POST(req: NextRequest) {
  // Mirror /submit's gate exactly (case-insensitive "bearer "), and trim both
  // sides so stray whitespace/newlines in the env value or header can't cause a
  // spurious 401.
  const required = (process.env.REGISTRY_SUBMIT_TOKEN ?? "").trim();
  if (required) {
    const auth = req.headers.get("authorization") ?? "";
    const presented = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
    if (presented !== required) {
      return NextResponse.json({ success: false, error: "Missing or invalid bearer token." }, { status: 401 });
    }
  }

  const max = Math.min(Number(req.nextUrl.searchParams.get("max") || "500"), 2000);
  // ?prune=true → after revalidating, collapse duplicate entries per domain to
  // a single best (indexed + has-graph + most complete), deleting the rest.
  const prune = req.nextUrl.searchParams.get("prune") === "true";

  // Collect ids (paged) up to max.
  const ids: string[] = [];
  for (let offset = 0; ids.length < max; offset += PAGE) {
    const page = await listRecentIds(PAGE, offset);
    if (page.length === 0) break;
    ids.push(...page);
    if (page.length < PAGE) break;
  }
  const entries = await getEntriesByIds(ids.slice(0, max));

  const items: Array<Record<string, unknown>> = [];
  let revalidated = 0;
  let changed = 0;
  let failed = 0;
  // Fresh per-entry facts for the prune pass (status etc. after revalidation).
  const validated: Array<{ id: string; domain: string; status: string; hasGraph: boolean; completeness: number; validatedMs: number }> = [];

  for (const e of entries) {
    if (!e?.url) continue;
    try {
      const r = await validate(e.url);
      const now = new Date().toISOString();
      const recheckDays = r.status === "indexed" ? 30 : 7;
      await updateEntry(e.id, {
        format: r.format,
        status: r.status,
        statusMessage: r.statusMessage,
        parsed: r.parsed,
        lastValidatedAt: now,
        nextRecheckAt: new Date(Date.now() + recheckDays * 86_400_000).toISOString(),
        validationCount: (e.validationCount ?? 0) + 1,
      });
      revalidated++;
      const before = e.parsed?.graph?.total ?? null;
      const after = r.parsed?.graph?.total ?? null;
      if (before !== after || e.status !== r.status) changed++;
      items.push({ domain: e.domain, status: r.status, graphNodes: after });
      validated.push({
        id: e.id, domain: e.domain, status: r.status,
        hasGraph: !!r.parsed?.graph, completeness: r.parsed?.profileCompleteness ?? 0,
        validatedMs: Date.now(),
      });
    } catch (err) {
      failed++;
      items.push({ domain: e.domain, error: String(err) });
      validated.push({ id: e.id, domain: e.domain, status: "error", hasGraph: false, completeness: -1, validatedMs: 0 });
    }
  }

  // ── Prune duplicates per domain ────────────────────────────────
  let pruned = 0;
  const prunedItems: Array<Record<string, unknown>> = [];
  if (prune) {
    const byDomain = new Map<string, typeof validated>();
    for (const v of validated) {
      const list = byDomain.get(v.domain) ?? [];
      list.push(v);
      byDomain.set(v.domain, list);
    }
    // Keeper rank: indexed first, then has-graph, then completeness, then most recent.
    const rank = (v: (typeof validated)[number]) =>
      (v.status === "indexed" ? 1_000_000 : 0) + (v.hasGraph ? 10_000 : 0) + v.completeness * 100;
    for (const [domain, list] of byDomain) {
      if (list.length <= 1) continue;
      list.sort((a, b) => rank(b) - rank(a) || b.validatedMs - a.validatedMs);
      for (const loser of list.slice(1)) {
        if (await deleteEntry(loser.id)) {
          pruned++;
          prunedItems.push({ domain, id: loser.id, status: loser.status });
        }
      }
    }
  }

  return NextResponse.json({ success: true, total: entries.length, revalidated, changed, failed, pruned, prunedItems, items });
}
