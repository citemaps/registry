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
import { listRecentIds, getEntriesByIds, updateEntry } from "@/lib/kv";
import { validate } from "@/lib/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const PAGE = 50;

export async function POST(req: NextRequest) {
  const required = process.env.REGISTRY_SUBMIT_TOKEN;
  if (required) {
    const auth = req.headers.get("authorization") ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    if (token !== required) {
      return NextResponse.json({ success: false, error: "Unauthorized." }, { status: 401 });
    }
  }

  const max = Math.min(Number(req.nextUrl.searchParams.get("max") || "500"), 2000);

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
    } catch (err) {
      failed++;
      items.push({ domain: e.domain, error: String(err) });
    }
  }

  return NextResponse.json({ success: true, total: entries.length, revalidated, changed, failed, items });
}
