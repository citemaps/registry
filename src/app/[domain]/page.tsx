// ============================================================
// citemaps.org registry — per-domain detail page
//
// Renders the most-recently-indexed citemap entry for a domain.
// URL shape: registry.citemaps.org/{domain}
//
// SSR + searchable by crawlers + AI engine ingestion path.
// Returns 404 when the domain has no indexed entries.
//
// v0.5 renders the parsed metadata fields directly. Phase 2 v1
// will reuse the Studio renderCitemapAsBodyHtml helper for full
// JSON-LD-equivalent rendering (requires extracting the
// renderer into a shared package or duplicating into the
// registry app).
// ============================================================

import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { getEntryByDomain } from "@/lib/kv";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ domain: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { domain } = await params;
  const entry = await getEntryByDomain(domain).catch(() => null);
  if (!entry) {
    return { title: `${domain} · citemaps.org registry` };
  }
  const name = entry.parsed?.entityName ?? domain;
  return {
    title: `${name} · citemaps.org registry`,
    description:
      `Registry entry for ${name}. Citemap.json indexed at citemaps.org, validated ${entry.lastValidatedAt ?? entry.submittedAt}.`,
    openGraph: {
      title: `${name} · citemaps.org registry`,
      description: `Citemap.json indexed at citemaps.org.`,
      url: `https://registry.citemaps.org/${domain}`,
      type: "article",
    },
  };
}

export default async function DomainDetailPage({ params }: PageProps) {
  const { domain } = await params;
  const entry = await getEntryByDomain(domain);
  if (!entry) notFound();

  const name = entry.parsed?.entityName ?? domain;
  const verticals = entry.parsed?.verticals ?? [];
  const moduleKeys = entry.parsed?.moduleKeys ?? [];
  const version = entry.parsed?.citemapVersion;
  const completeness = entry.parsed?.profileCompleteness ?? null;
  // Phase 4 verification state — drives the Verified badge in
  // the header + the Claim CTA / Claimed-by card in the aside.
  const isClaimed = !!entry.claimedByEmail;
  const canBeClaimed = !isClaimed && !!entry.parsed?.registryToken;
  const claimDisplay =
    entry.claimedDisplayName ??
    (entry.claimedByEmail ? entry.claimedByEmail.split("@")[0] : null);

  return (
    <>
      <SiteHeader />
      <main className="container" style={{ paddingTop: 32, paddingBottom: 80 }}>
        <nav style={{ marginBottom: 28, fontSize: 13, color: "var(--c-text-muted)" }}>
          <Link href="/" style={{ color: "var(--c-text-muted)", borderBottom: "none" }}>
            ← Registry
          </Link>
        </nav>

        <header style={{
          display: "grid", gap: 12, marginBottom: 32,
          paddingBottom: 24, borderBottom: "1px solid var(--c-border)",
        }}>
          <div className="eyebrow">{entry.domain}</div>
          <h1 style={{ fontSize: 32, marginTop: 4 }}>{name}</h1>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 8 }}>
            <span className="badge badge-indexed">Indexed</span>
            {isClaimed && (
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
            {version && (
              <span style={{
                fontSize: 11, fontFamily: "var(--font-geist-mono)",
                background: "var(--c-bg-subtle)", padding: "3px 8px", borderRadius: 4,
              }}>citemap v{version}</span>
            )}
            {verticals.slice(0, 6).map(v => (
              <span key={v} style={{
                fontSize: 11, fontFamily: "var(--font-geist-mono)",
                background: "var(--c-bg-subtle)", padding: "3px 8px", borderRadius: 4,
              }}>{v}</span>
            ))}
          </div>
        </header>

        <div style={{
          display: "grid",
          gridTemplateColumns: "minmax(0, 2fr) minmax(0, 1fr)",
          gap: 32,
        }}>
          <section style={{ display: "grid", gap: 24 }}>
            <Card title="Source URL">
              <div style={{
                fontFamily: "var(--font-geist-mono)", fontSize: 13,
                wordBreak: "break-all", color: "var(--c-text)",
              }}>
                {entry.url}
              </div>
              <div style={{ marginTop: 10 }}>
                <a href={entry.url} target="_blank" rel="noopener noreferrer" style={{
                  fontSize: 13, color: "var(--c-text-muted)",
                }}>
                  View original ↗
                </a>
              </div>
            </Card>

            {moduleKeys.length > 0 && (
              <Card title="Modules present">
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {moduleKeys.map(k => (
                    <span key={k} style={{
                      fontSize: 12, fontFamily: "var(--font-geist-mono)",
                      background: "var(--c-bg-subtle)", padding: "4px 10px",
                      borderRadius: 4, color: "var(--c-text)",
                    }}>{k}</span>
                  ))}
                </div>
              </Card>
            )}

            <Card title="Submission">
              <KvRow label="Intake source" value={intakeLabel(entry.intakeSource)} />
              <KvRow label="Submitted" value={formatDate(entry.submittedAt)} />
              {entry.lastValidatedAt && (
                <KvRow label="Last validated" value={formatDate(entry.lastValidatedAt)} />
              )}
              <KvRow label="Validation count" value={String(entry.validationCount ?? 1)} />
              {entry.format && (
                <KvRow label="Format" value={entry.format} mono />
              )}
            </Card>
          </section>

          <aside style={{ display: "grid", gap: 24 }}>
            {completeness !== null && (
              <Card title="Completeness">
                <CompletenessRingLarge value={completeness} />
                <p style={{
                  fontSize: 12, color: "var(--c-text-muted)", marginTop: 12,
                  lineHeight: 1.5,
                }}>
                  Heuristic score across the citemap's high-value fields
                  (trust, temporal record, sameAs, services, products, team,
                  citation contract).
                </p>
              </Card>
            )}

            <Card title="Trust signals">
              <SignalRow label="trust block" present={entry.parsed?.hasTrust ?? false} />
              <SignalRow label="temporal record" present={entry.parsed?.hasTemporalRecord ?? false} />
            </Card>

            {/* Phase 4 — Verification / Claim card */}
            {isClaimed ? (
              <Card title="Verified by publisher">
                {claimDisplay && (
                  <KvRow label="Claimed by" value={claimDisplay} />
                )}
                {entry.claimedAt && (
                  <KvRow label="Verified" value={formatDate(entry.claimedAt)} />
                )}
                <p style={{
                  fontSize: 11, color: "var(--c-text-muted)",
                  marginTop: 10, lineHeight: 1.55,
                }}>
                  The publisher proved ownership via the registry-token
                  field in their citemap + a magic-link email confirmation.
                </p>
              </Card>
            ) : canBeClaimed ? (
              <Card title="Claim this entry">
                <p style={{
                  fontSize: 13, color: "var(--c-text)",
                  margin: 0, lineHeight: 1.55,
                }}>
                  This citemap publishes a registry token. If you control{" "}
                  <strong>{entry.domain}</strong>, you can claim this entry.
                </p>
                <Link href={`/registry/claim?id=${entry.id}`} style={{
                  display: "inline-block",
                  marginTop: 12,
                  padding: "8px 14px",
                  background: "#0f0f0e",
                  color: "#ffffff",
                  textDecoration: "none",
                  fontSize: 12, fontWeight: 600,
                  letterSpacing: "0.02em",
                  borderBottom: "none",
                }}>
                  Claim →
                </Link>
              </Card>
            ) : (
              <Card title="Not yet claimable">
                <p style={{
                  fontSize: 12, color: "var(--c-text-muted)",
                  margin: 0, lineHeight: 1.55,
                }}>
                  This citemap doesn't include a{" "}
                  <code style={{ fontSize: 11 }}>citationContract.registryToken</code>{" "}
                  yet. Once the publisher adds one (or regenerates from a v3.2.1-aware
                  producer like CiteMaps Studio), this entry becomes claimable.
                </p>
              </Card>
            )}

            <Card title="Identity">
              <KvRow label="Entry ID" value={entry.id} mono />
              {entry.parsed?.rawHash && (
                <KvRow
                  label="Content hash"
                  value={`${entry.parsed.rawHash.slice(0, 12)}…`}
                  mono
                />
              )}
            </Card>
          </aside>
        </div>
      </main>
      <SiteFooter domain={entry.domain} />
    </>
  );
}

// ── Atoms (lifted from index page in v1; inlined here for v0.5) ─────

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

function SiteFooter({ domain }: { domain: string }) {
  return (
    <footer style={{
      borderTop: "1px solid var(--c-border)",
      background: "var(--c-bg-elevated)",
      padding: "40px 0 60px",
    }}>
      <div className="container" style={{ display: "grid", gap: 28 }}>
        <div>
          <h3 style={{ fontSize: 14, marginBottom: 12 }}>API access</h3>
          <p style={{ fontSize: 13, color: "var(--c-text-muted)", marginBottom: 12 }}>
            Fetch this entry's full registry record as JSON:
          </p>
          <pre style={{ fontSize: 12 }}>{`curl https://api.citemaps.org/api/registry/status/{id}`}</pre>
        </div>
        <div style={{
          display: "flex", justifyContent: "space-between", alignItems: "center",
          paddingTop: 20, borderTop: "1px solid var(--c-border)",
          fontSize: 12, color: "var(--c-text-dim)",
        }}>
          <span>citemaps.org registry · open infrastructure</span>
          <span>
            <a href={`https://${domain}`} style={{
              color: "var(--c-text-dim)", borderBottom: "none",
            }}>{domain} ↗</a>
          </span>
        </div>
      </div>
    </footer>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{
      background: "var(--c-bg-elevated)", border: "1px solid var(--c-border)",
      borderRadius: 8, padding: 18,
    }}>
      <h3 style={{
        fontSize: 11, fontWeight: 500, letterSpacing: "0.06em",
        textTransform: "uppercase", color: "var(--c-text-muted)", marginBottom: 12,
      }}>{title}</h3>
      {children}
    </section>
  );
}

function KvRow({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div style={{
      display: "flex", justifyContent: "space-between", gap: 12,
      padding: "6px 0", borderBottom: "1px solid var(--c-border)",
      fontSize: 13,
    }}>
      <span style={{ color: "var(--c-text-muted)" }}>{label}</span>
      <span style={{
        color: "var(--c-text)", textAlign: "right",
        fontFamily: mono ? "var(--font-geist-mono)" : "inherit",
        wordBreak: "break-all",
      }}>{value}</span>
    </div>
  );
}

function SignalRow({ label, present }: { label: string; present: boolean }) {
  return (
    <div style={{
      display: "flex", justifyContent: "space-between", padding: "6px 0",
      borderBottom: "1px solid var(--c-border)", fontSize: 13,
    }}>
      <span style={{ color: "var(--c-text-muted)" }}>{label}</span>
      <span style={{
        color: present ? "var(--c-status-indexed)" : "var(--c-text-dim)",
        fontWeight: 500,
      }}>
        {present ? "Present" : "Absent"}
      </span>
    </div>
  );
}

function CompletenessRingLarge({ value }: { value: number }) {
  const size = 96;
  const stroke = 6;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const offset = c - (value / 100) * c;
  const tone =
    value >= 70 ? "var(--c-status-indexed)" :
    value >= 40 ? "var(--c-status-invalid)" :
    "var(--c-text-dim)";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="var(--c-border)" strokeWidth={stroke} />
        <circle
          cx={size/2} cy={size/2} r={r} fill="none"
          stroke={tone} strokeWidth={stroke} strokeLinecap="round"
          strokeDasharray={c} strokeDashoffset={offset}
          transform={`rotate(-90 ${size/2} ${size/2})`}
        />
        <text x={size/2} y={size/2 + 7} textAnchor="middle"
          fontSize={22} fontWeight={500} fontFamily="var(--font-geist-mono)"
          fill="var(--c-text)">
          {value}
        </text>
      </svg>
      <span style={{ fontSize: 12, color: "var(--c-text-muted)" }}>
        out of 100
      </span>
    </div>
  );
}

function intakeLabel(source: string): string {
  return ({
    studio_autosubmit: "Studio auto-submit",
    manual_api: "Manual API",
    domain_probe: "Domain probe",
    crawl_mining: "Crawl mining",
    search_probe: "Search probe",
  } as Record<string, string>)[source] ?? source;
}

function formatDate(iso?: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-US", {
    year: "numeric", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit",
  });
}
