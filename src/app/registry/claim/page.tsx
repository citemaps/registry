// ============================================================
// citemaps.org/registry/claim?id={entryId}
//
// Claim form. Two-factor proof:
//   1. Submit registryToken from your citemap → server re-
//      fetches the citemap + confirms the token matches
//   2. Magic-link email → click to finalize
//
// All friendly user-facing errors live here; the API route
// returns code + message, this page maps them onto inline
// callouts in plain English.
//
// Auto-pre-fills `url` + entity context when ?id={entryId}
// is present (link from per-domain detail page). Manual entry
// supported when arriving without ID.
// ============================================================

"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";

interface PrefillData {
  url?: string;
  domain?: string;
  entityName?: string;
  hasRegistryToken?: boolean;
  alreadyClaimed?: boolean;
  claimedDisplayName?: string;
}

type SendState =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "sent"; email: string; expiresAt: string }
  | { kind: "error"; message: string; code?: string };

export default function ClaimPage() {
  const params = useSearchParams();
  const entryId = params?.get("id") ?? null;

  const [prefill, setPrefill] = useState<PrefillData | null>(null);
  const [prefillLoading, setPrefillLoading] = useState<boolean>(!!entryId);

  const [url, setUrl] = useState("");
  const [email, setEmail] = useState("");
  const [token, setToken] = useState("");
  const [displayName, setDisplayName] = useState("");

  const [send, setSend] = useState<SendState>({ kind: "idle" });

  // Pre-fill from entry lookup when id is present
  useEffect(() => {
    if (!entryId) return;
    let cancelled = false;
    fetch(`/api/registry/status/${entryId}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((json) => {
        if (cancelled) return;
        if (json?.success) {
          const data = json.data ?? {};
          setPrefill({
            url: data.url,
            domain: data.domain,
            entityName: data.parsed?.entityName,
            hasRegistryToken: !!data.parsed?.registryToken,
            alreadyClaimed: !!data.claimedByEmail,
            claimedDisplayName: data.claimedDisplayName,
          });
          if (data.url) setUrl(data.url);
        }
      })
      .catch(() => { /* ignore */ })
      .finally(() => { if (!cancelled) setPrefillLoading(false); });
    return () => { cancelled = true; };
  }, [entryId]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (send.kind === "sending") return;
    if (!url.trim() || !email.trim() || !token.trim()) {
      setSend({ kind: "error", message: "URL, email, and token are required." });
      return;
    }
    setSend({ kind: "sending" });
    try {
      const res = await fetch("/api/registry/claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: url.trim(),
          email: email.trim(),
          token: token.trim(),
          displayName: displayName.trim() || undefined,
        }),
      });
      const json = await res.json();
      if (res.ok && json.success) {
        setSend({
          kind: "sent",
          email: email.trim(),
          expiresAt: json.data?.expiresAt ?? "",
        });
      } else {
        setSend({
          kind: "error",
          message: json?.error ?? "Claim submission failed.",
          code: json?.code,
        });
      }
    } catch {
      setSend({
        kind: "error",
        message: "Network error — try again in a moment.",
      });
    }
  };

  // Render claimed-state when prefill says so
  if (prefill?.alreadyClaimed) {
    return (
      <main className="container" style={{ paddingTop: 48, paddingBottom: 80, maxWidth: 560 }}>
        <h1 style={{ fontSize: 28, marginBottom: 12 }}>Already claimed</h1>
        <p style={{ color: "var(--c-text-muted)", fontSize: 14, lineHeight: 1.6 }}>
          This entry has already been claimed
          {prefill.claimedDisplayName ? <> by <strong>{prefill.claimedDisplayName}</strong></> : null}.
          If you believe this is in error, contact{" "}
          <a href="mailto:registry@citemaps.org">registry@citemaps.org</a>.
        </p>
        <Link href={prefill.domain ? `/${prefill.domain}` : "/"} style={{ display: "inline-block", marginTop: 20, fontSize: 13 }}>
          ← Back to registry
        </Link>
      </main>
    );
  }

  if (send.kind === "sent") {
    return (
      <main className="container" style={{ paddingTop: 48, paddingBottom: 80, maxWidth: 560 }}>
        <h1 style={{ fontSize: 28, marginBottom: 12 }}>Check your email</h1>
        <p style={{ color: "var(--c-text)", fontSize: 14, lineHeight: 1.6, marginBottom: 8 }}>
          We sent a confirmation link to <strong>{send.email}</strong>. Click it within 24 hours to finalize the claim.
        </p>
        <p style={{ color: "var(--c-text-muted)", fontSize: 12, lineHeight: 1.6 }}>
          Don't see it? Check spam, or wait a minute and try again. The token in your citemap stays valid either way.
        </p>
      </main>
    );
  }

  return (
    <main className="container" style={{ paddingTop: 48, paddingBottom: 80, maxWidth: 560 }}>
      <nav style={{ marginBottom: 28, fontSize: 13, color: "var(--c-text-muted)" }}>
        <Link href={prefill?.domain ? `/${prefill.domain}` : "/"} style={{ color: "var(--c-text-muted)", borderBottom: "none" }}>
          ← {prefill?.domain ?? "Registry"}
        </Link>
      </nav>

      <h1 style={{ fontSize: 28, marginBottom: 12 }}>Claim registry entry</h1>
      {prefill?.entityName ? (
        <p style={{ color: "var(--c-text-muted)", fontSize: 14, lineHeight: 1.6, marginBottom: 28 }}>
          Claiming the entry for <strong>{prefill.entityName}</strong> ({prefill.domain}).
        </p>
      ) : (
        <p style={{ color: "var(--c-text-muted)", fontSize: 14, lineHeight: 1.6, marginBottom: 28 }}>
          Prove you control this citemap by submitting the matching token + verifying your email.
        </p>
      )}

      {prefill && !prefillLoading && !prefill.hasRegistryToken && (
        <Callout tone="warn">
          This citemap doesn't include a <code>citationContract.registryToken</code> yet.
          Regenerate it from a v3.2.1-aware producer (CiteMaps Studio auto-emits one) or add the field
          manually, then come back to claim.
        </Callout>
      )}

      <form onSubmit={handleSubmit} style={{ display: "grid", gap: 16 }}>
        <Field label="Citemap URL" hint="The public URL where your citemap.json (or HTML companion) lives.">
          <input
            type="url"
            required
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://yourdomain.com/citemap.json"
            style={inputStyle}
          />
        </Field>
        <Field label="Registry token" hint={<>From <code>citationContract.registryToken</code> in your citemap. Looks like <code>cmrt_…</code>.</>}>
          <input
            type="text"
            required
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="cmrt_a1b2c3d4e5f67890"
            style={{ ...inputStyle, fontFamily: "var(--font-geist-mono)" }}
          />
        </Field>
        <Field label="Your email" hint="We send a one-time confirmation link here. The email is the claim's source of truth.">
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@yourdomain.com"
            style={inputStyle}
          />
        </Field>
        <Field label="Display name (optional)" hint="Shown on the public detail page as 'Claimed by X'. Defaults to your email's local-part.">
          <input
            type="text"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="e.g. Western Filament, Inc."
            maxLength={80}
            style={inputStyle}
          />
        </Field>

        {send.kind === "error" && (
          <Callout tone="error">{send.message}</Callout>
        )}

        <button
          type="submit"
          disabled={send.kind === "sending"}
          style={{
            padding: "12px 20px",
            background: "#0f0f0e",
            color: "#ffffff",
            border: "none",
            fontSize: 13,
            fontWeight: 600,
            letterSpacing: "0.02em",
            cursor: send.kind === "sending" ? "wait" : "pointer",
            opacity: send.kind === "sending" ? 0.6 : 1,
            justifySelf: "start",
          }}
        >
          {send.kind === "sending" ? "Verifying token…" : "Send confirmation link →"}
        </button>
      </form>

      <p style={{ marginTop: 32, fontSize: 11, color: "var(--c-text-muted)", lineHeight: 1.6 }}>
        Two-factor proof: (1) we re-fetch your citemap at the URL above and confirm the
        token you submitted matches the published value (proves you control the deployment);
        (2) the magic link confirms you control the email. Both are required.
      </p>
    </main>
  );
}

// ── Atoms ──────────────────────────────────────────────────

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "10px 12px",
  border: "1px solid var(--c-border)",
  background: "#ffffff",
  color: "var(--c-text)",
  fontSize: 13,
  fontFamily: "inherit",
  outline: "none",
  boxSizing: "border-box",
};

function Field({ label, hint, children }: { label: string; hint?: React.ReactNode; children: React.ReactNode }) {
  return (
    <label style={{ display: "grid", gap: 6 }}>
      <span style={{ fontSize: 13, fontWeight: 600, color: "var(--c-text)" }}>{label}</span>
      {hint && <span style={{ fontSize: 11, color: "var(--c-text-muted)", lineHeight: 1.5 }}>{hint}</span>}
      {children}
    </label>
  );
}

function Callout({ tone, children }: { tone: "warn" | "error"; children: React.ReactNode }) {
  const bg = tone === "error" ? "rgba(220,38,38,0.06)" : "rgba(234,179,8,0.08)";
  const border = tone === "error" ? "#dc2626" : "#eab308";
  const fg = tone === "error" ? "#dc2626" : "#854d0e";
  return (
    <div style={{
      padding: "10px 14px",
      background: bg,
      borderLeft: `3px solid ${border}`,
      color: fg,
      fontSize: 12,
      lineHeight: 1.55,
    }}>
      {children}
    </div>
  );
}
