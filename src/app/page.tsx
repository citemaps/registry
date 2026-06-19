// ============================================================
// citemaps.org registry — public index page
//
// Lists recently-indexed citemap entries. Server-rendered so
// search engines + AI engine crawlers can ingest the catalog
// directly. v0.5 is chronological-only — no faceted browse,
// no pagination beyond a single "next page" link. Phase 2 v1
// adds vertical/status filters + full pagination + search.
//
// Filter strategy: fetch a generous window (200) then filter to
// status === "indexed" client-side (here server-side at render
// time). At current scale (dozens to hundreds of entries) this
// is cheaper than maintaining a separate indexed-only sorted
// set. When the index grows past ~10k entries, refactor to a
// dedicated index.
// ============================================================

import Link from "next/link";
import { listRecentIds, getEntriesByIds } from "@/lib/kv";
import type { RegistryEntry } from "@/lib/types";
import { RegistryGraph, GraphLegend } from "@/components/RegistryGraph";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;
const FETCH_OVERSAMPLE = 4;  // fetch 4x to leave room for non-indexed filtering

interface PageProps {
  searchParams: Promise<{ page?: string }>;
}

export default async function RegistryIndexPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const pageParam = parseInt(params.page ?? "1", 10);
  const page = Number.isFinite(pageParam) && pageParam >= 1 ? pageParam : 1;
  const offset = (page - 1) * PAGE_SIZE;

  // Oversample then filter. Most entries should be indexed in
  // healthy bootstrap; rate-limit-blocked + invalid submissions
  // are minority.
  const ids = await listRecentIds(PAGE_SIZE * FETCH_OVERSAMPLE, offset);
  const allEntries = await getEntriesByIds(ids);
  const indexed = allEntries.filter(e => e.status === "indexed").slice(0, PAGE_SIZE);

  return (
    <>
      <SiteHeader />
      <main className="container" style={{ paddingTop: 32, paddingBottom: 80 }}>
        <section style={{ marginBottom: 40 }}>
          <div className="eyebrow" style={{ marginBottom: 8 }}>Registry</div>
          <h1 style={{ marginBottom: 12 }}>Every citemap on the open web</h1>
          <p style={{ color: "var(--c-text-muted)", fontSize: 16, maxWidth: 640 }}>
            The neutral catalog of entities that publish a <code>citemap.json</code> file.
            Submitted by Studio users, manual API callers, and (soon) discovered via crawl.
            Free to browse, free to submit.
          </p>
        </section>

        <section>
          <header style={{
            display: "flex", justifyContent: "space-between", alignItems: "baseline",
            marginBottom: 16, paddingBottom: 12, borderBottom: "1px solid var(--c-border)",
          }}>
            <h2 style={{ fontSize: 14, fontWeight: 500, color: "var(--c-text-muted)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
              Recently indexed
            </h2>
            <span style={{ fontSize: 12, color: "var(--c-text-dim)" }}>
              showing {indexed.length} {indexed.length === 1 ? "entry" : "entries"}
            </span>
          </header>

          {indexed.length === 0 ? (
            <EmptyState page={page} />
          ) : (
            <>
              <div style={{
                position: "sticky", top: 0, zIndex: 5, background: "var(--c-bg)",
                padding: "8px 0 10px", marginBottom: 6, borderBottom: "1px solid var(--c-border)",
              }}>
                <GraphLegend />
              </div>
              <div style={{
                display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(248px, 1fr))",
                gap: 14, alignItems: "stretch",
              }}>
                {indexed.map(entry => <EntryCard key={entry.id} entry={entry} />)}
              </div>
            </>
          )}

          {indexed.length === PAGE_SIZE && (
            <div style={{ marginTop: 32, textAlign: "center" }}>
              <Link
                href={`/?page=${page + 1}`}
                style={{ fontSize: 14, color: "var(--c-text-muted)" }}
              >
                Older entries →
              </Link>
            </div>
          )}
          {page > 1 && (
            <div style={{ marginTop: 16, textAlign: "center" }}>
              <Link
                href={page > 2 ? `/?page=${page - 1}` : "/"}
                style={{ fontSize: 14, color: "var(--c-text-muted)" }}
              >
                ← Newer entries
              </Link>
            </div>
          )}
        </section>
      </main>
      <SiteFooter />
    </>
  );
}

// ── Atoms ─────────────────────────────────────────────────────

function SiteHeader() {
  return (
    <header style={{
      borderBottom: "1px solid var(--c-border)",
      background: "var(--c-bg-elevated)",
    }}>
      <div className="container" style={{
        display: "flex", justifyContent: "space-between", alignItems: "center",
        padding: "18px 24px",
      }}>
        <Link href="/" style={{
          display: "flex", alignItems: "center", gap: 10,
          borderBottom: "none", color: "var(--c-text)",
        }}>
          <span className="eyebrow" style={{ fontSize: 12, letterSpacing: "0.08em" }}>
            citemaps.org
          </span>
          <span style={{ color: "var(--c-text-dim)" }}>/</span>
          <span style={{ fontWeight: 500, fontSize: 14 }}>registry</span>
        </Link>
        <nav style={{ display: "flex", gap: 24, alignItems: "center" }}>
          <a href="https://citemaps.org" style={{
            fontSize: 13, color: "var(--c-text-muted)", borderBottom: "none",
          }}>Spec docs</a>
          <a href="https://github.com/citemaps/registry" style={{
            fontSize: 13, color: "var(--c-text-muted)", borderBottom: "none",
          }}>Source</a>
        </nav>
      </div>
    </header>
  );
}

function SiteFooter() {
  return (
    <footer style={{
      borderTop: "1px solid var(--c-border)",
      background: "var(--c-bg-elevated)",
      padding: "40px 0 60px",
    }}>
      <div className="container" style={{ display: "grid", gap: 28 }}>
        <div>
          <h3 style={{ fontSize: 14, marginBottom: 12 }}>Submit a citemap</h3>
          <p style={{ fontSize: 13, color: "var(--c-text-muted)", marginBottom: 12 }}>
            Anyone can register a publicly-hosted citemap. The validator fetches the URL,
            checks the shape, and indexes it within ~10 seconds.
          </p>
          <pre style={{ fontSize: 12 }}>{`curl -X POST https://api.citemaps.org/api/registry/submit \\
  -H 'Content-Type: application/json' \\
  -d '{"url": "https://your-domain.com/citemap.json"}'`}</pre>
        </div>
        <div style={{
          display: "flex", justifyContent: "space-between", alignItems: "center",
          paddingTop: 20, borderTop: "1px solid var(--c-border)",
          fontSize: 12, color: "var(--c-text-dim)",
        }}>
          <span>citemaps.org registry · open infrastructure</span>
          <span>
            <a href="https://citemaps.org" style={{
              color: "var(--c-text-dim)", borderBottom: "none", marginRight: 16,
            }}>citemaps.org</a>
            <a href="https://api.citemaps.org" style={{
              color: "var(--c-text-dim)", borderBottom: "none",
            }}>API</a>
          </span>
        </div>
      </div>
    </footer>
  );
}

function EmptyState({ page }: { page: number }) {
  return (
    <div style={{
      padding: 48, textAlign: "center", background: "var(--c-bg-elevated)",
      border: "1px solid var(--c-border)", borderRadius: 8,
    }}>
      <p style={{ color: "var(--c-text-muted)" }}>
        {page === 1
          ? "No indexed citemaps yet. Be the first to submit one."
          : "No more entries past this point."}
      </p>
    </div>
  );
}

function EntryCard({ entry }: { entry: RegistryEntry }) {
  const submittedAgo = formatRelative(entry.submittedAt);
  const verticals = entry.parsed?.verticals ?? [];
  const completeness = entry.parsed?.profileCompleteness ?? null;
  const graph = entry.parsed?.graph;

  return (
    <Link
      href={`/${entry.domain}`}
      style={{
        display: "flex", flexDirection: "column", gap: 10, padding: 18,
        background: "var(--c-bg-elevated)", border: "1px solid var(--c-border)",
        borderRadius: 8, color: "var(--c-text)",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{
            fontSize: 12, color: "var(--c-text-dim)", fontFamily: "var(--font-geist-mono)",
            marginBottom: 3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          }}>
            {entry.domain}
          </div>
          <div style={{
            fontWeight: 500, fontSize: 16,
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          }}>
            {entry.parsed?.entityName ?? entry.domain}
          </div>
        </div>
        {completeness !== null && (
          <div style={{ flexShrink: 0 }}><CompletenessRing value={completeness} /></div>
        )}
      </div>

      <div style={{ display: "flex", justifyContent: "center" }}>
        <RegistryGraph model={graph} size={148} />
      </div>
      <div style={{ fontSize: 11, color: "var(--c-text-muted)", textAlign: "center" }}>
        {graph
          ? `${graph.total} node${graph.total === 1 ? "" : "s"}${graph.overflow ? ` · +${graph.overflow} more` : ""}`
          : "no graph nodes yet"}
      </div>

      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {entry.claimedByEmail && (
          <span style={{
            fontSize: 11, fontFamily: "var(--font-geist-mono)",
            background: "#0f0f0e", color: "#ffffff",
            padding: "3px 8px", borderRadius: 4,
            display: "inline-flex", alignItems: "center", gap: 4,
          }}>
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="20 6 9 17 4 12" />
            </svg>
            Verified
          </span>
        )}
        <span className="badge badge-indexed">Indexed</span>
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, fontSize: 12, color: "var(--c-text-muted)" }}>
        {verticals.length > 0 ? verticals.slice(0, 3).map(v => (
          <span key={v} style={{
            background: "var(--c-bg-subtle)", padding: "2px 8px",
            borderRadius: 3, fontFamily: "var(--font-geist-mono)",
          }}>{v}</span>
        )) : (
          <span style={{ fontStyle: "italic", color: "var(--c-text-dim)" }}>
            no verticals declared
          </span>
        )}
        {entry.parsed?.citemapVersion && (
          <span style={{
            background: "var(--c-bg-subtle)", padding: "2px 8px",
            borderRadius: 3, fontFamily: "var(--font-geist-mono)",
          }}>v{entry.parsed.citemapVersion}</span>
        )}
      </div>

      <div style={{ fontSize: 12, color: "var(--c-text-dim)", marginTop: "auto" }}>
        submitted {submittedAgo}
      </div>
    </Link>
  );
}

function CompletenessRing({ value }: { value: number }) {
  const size = 32;
  const stroke = 2.5;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const offset = c - (value / 100) * c;
  const tone =
    value >= 70 ? "var(--c-status-indexed)" :
    value >= 40 ? "var(--c-status-invalid)" :
    "var(--c-text-dim)";
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-label={`Completeness ${value}%`}>
      <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="var(--c-border)" strokeWidth={stroke} />
      <circle
        cx={size/2} cy={size/2} r={r} fill="none"
        stroke={tone} strokeWidth={stroke} strokeLinecap="round"
        strokeDasharray={c} strokeDashoffset={offset}
        transform={`rotate(-90 ${size/2} ${size/2})`}
      />
      <text x={size/2} y={size/2 + 4} textAnchor="middle"
        fontSize={10} fontFamily="var(--font-geist-mono)" fill="var(--c-text)">
        {value}
      </text>
    </svg>
  );
}

function formatRelative(iso?: string): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  const diff = Date.now() - t;
  const min = Math.round(diff / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day}d ago`;
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
