// ============================================================
// Citemap content files (2026-11-22). A citemap can list Media in
// separate files: `contentFiles: [{ type, url, count, year?, lastUpdated }]`,
// each a `"@type": "CitemapContentFile"` holding its type's brand rows
// (brand.publications / video / podcasts / speaking), @graph nodes and
// relationships, under the same @ids as the main file. Concatenating the
// arrays gives the one-file record back.
// CiteMaps vault decisions/citemap-size-and-content-splits.md
//
// The registry follows them during validation so counts and the graph
// cover the whole record. Bounded: https + public hosts only, size cap
// per file, a wall-clock budget, and a failed file is skipped (the main
// file alone still lists).
// ============================================================
import { hostOf, isPrivateHost } from "./canonicalize";

const MAX_FILES = 40;
const MAX_FILE_BYTES = 2_097_152; // 2 MB
const PER_FILE_TIMEOUT_MS = 6_000;
const BUDGET_MS = 10_000;
const PARALLEL = 6;
const MEDIA_BRAND_KEYS = ["publications", "video", "podcasts", "speaking", "products"]; // products: 2026-11-23

type Doc = Record<string, unknown>;
type Row = Record<string, unknown>;

export function mergeContentFiles(main: Doc, files: Doc[]): Doc {
  const out: Doc = { ...main, brand: { ...((main.brand as Doc) ?? {}) } };
  const brand = out.brand as Doc;
  const graph = [...((main["@graph"] as Row[]) ?? [])];
  const rels = [...((main.relationships as Row[]) ?? [])];
  const seenNode = new Set(graph.map(n => n?.["@id"]).filter(Boolean));
  const relKey = (r: Row) => `${r?.from}|${r?.type}|${r?.to}`;
  const seenRel = new Set(rels.map(relKey));
  for (const f of files) {
    if (!f || typeof f !== "object" || f["@type"] !== "CitemapContentFile") continue;
    const fb = (f.brand ?? {}) as Doc;
    for (const key of MEDIA_BRAND_KEYS) {
      const rows = fb[key];
      if (!Array.isArray(rows)) continue;
      const have = Array.isArray(brand[key]) ? (brand[key] as Row[]) : [];
      const ids = new Set(have.map(r => r?.id).filter(Boolean));
      brand[key] = [...have, ...(rows as Row[]).filter(r => !(r?.id && ids.has(r.id)))];
    }
    for (const n of (f["@graph"] as Row[] | undefined) ?? []) {
      if (n?.["@id"] && seenNode.has(n["@id"])) continue;
      seenNode.add(n?.["@id"]); graph.push(n);
    }
    for (const r of (f.relationships as Row[] | undefined) ?? []) {
      const k = relKey(r);
      if (seenRel.has(k)) continue;
      seenRel.add(k); rels.push(r);
    }
  }
  if (graph.length) out["@graph"] = graph;
  if (rels.length) out.relationships = rels;
  return out;
}

export interface FollowResult { doc: Doc; listed: number; read: number; failed: number }

export async function followContentFiles(main: Doc, userAgent: string): Promise<FollowResult> {
  const refs = Array.isArray(main.contentFiles) ? (main.contentFiles as Row[]) : [];
  const urls = [...new Set(refs.map(r => (typeof r?.url === "string" ? r.url : "")))]
    .filter(u => {
      if (!/^https:\/\//i.test(u)) return false;
      const h = hostOf(u);
      return !!h && !isPrivateHost(h);
    })
    .slice(0, MAX_FILES);
  const started = Date.now();
  const docs: Doc[] = [];
  let failed = refs.length - urls.length;
  for (let i = 0; i < urls.length; i += PARALLEL) {
    if (Date.now() - started > BUDGET_MS) { failed += urls.length - i; break; }
    await Promise.all(urls.slice(i, i + PARALLEL).map(async url => {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), PER_FILE_TIMEOUT_MS);
      try {
        const res = await fetch(url, { signal: controller.signal, headers: { Accept: "application/json", "User-Agent": userAgent }, redirect: "follow" });
        const finalHost = hostOf(res.url || url);
        if (!res.ok || !finalHost || isPrivateHost(finalHost)) { failed++; return; }
        const text = await res.text();
        if (text.length > MAX_FILE_BYTES) { failed++; return; }
        const d = JSON.parse(text);
        if (d?.["@type"] !== "CitemapContentFile") { failed++; return; }
        docs.push(d);
      } catch {
        failed++;
      } finally {
        clearTimeout(t);
      }
    }));
  }
  return { doc: docs.length ? mergeContentFiles(main, docs) : main, listed: refs.length, read: docs.length, failed };
}
