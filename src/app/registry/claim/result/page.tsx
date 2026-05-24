// ============================================================
// citemaps.org/registry/claim/result?status=...
//
// Landing page for magic-link callbacks. The verify route
// redirects here with a status query param so we can render
// friendly copy instead of returning JSON to email-clicked
// users.
//
// Status enum mirrors the verify route's redirect branches.
// ============================================================

import Link from "next/link";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Claim result · citemaps.org registry",
};

interface PageProps {
  searchParams: Promise<{ status?: string; domain?: string; reason?: string }>;
}

export default async function ClaimResultPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const status = params.status ?? "unknown";
  const domain = params.domain ?? null;
  const reason = params.reason ?? null;

  const view = mapStatusToView(status, domain, reason);

  return (
    <main className="container" style={{ paddingTop: 56, paddingBottom: 80, maxWidth: 560 }}>
      <h1 style={{ fontSize: 28, marginBottom: 16 }}>{view.heading}</h1>
      <p style={{ fontSize: 14, color: "var(--c-text)", lineHeight: 1.6, marginBottom: 16 }}>
        {view.body}
      </p>
      {view.next && (
        <div style={{ marginTop: 24 }}>
          <Link href={view.next.href} style={{
            display: "inline-block",
            padding: "10px 16px",
            background: view.success ? "#0f0f0e" : "transparent",
            color: view.success ? "#ffffff" : "var(--c-text)",
            border: view.success ? "none" : "1px solid var(--c-border)",
            textDecoration: "none",
            fontSize: 12, fontWeight: 600,
            letterSpacing: "0.02em",
            borderBottom: "none",
          }}>
            {view.next.label}
          </Link>
        </div>
      )}
    </main>
  );
}

interface View {
  heading: string;
  body: string;
  success: boolean;
  next?: { label: string; href: string };
}

function mapStatusToView(status: string, domain: string | null, reason: string | null): View {
  switch (status) {
    case "verified":
      return {
        heading: "Claim confirmed",
        body: domain
          ? `You've successfully claimed the citemaps.org registry entry for ${domain}. The Verified badge is now live on the public detail page.`
          : "You've successfully claimed this citemaps.org registry entry. The Verified badge is now live on its public detail page.",
        success: true,
        next: domain
          ? { label: `View ${domain} →`, href: `/${domain}` }
          : { label: "Browse registry →", href: "/" },
      };
    case "expired":
      return {
        heading: "Link expired",
        body: "Magic-link claims are single-use and expire 24 hours after submission. Start a new claim — the token in your citemap stays valid.",
        success: false,
        next: { label: "Start a new claim", href: "/" },
      };
    case "invalid":
      return {
        heading: "Invalid link",
        body: "This verification link is malformed. If you copied it manually, try clicking it directly from the email instead.",
        success: false,
      };
    case "already-claimed":
      return {
        heading: "Already claimed",
        body: "This entry was claimed (possibly by a parallel attempt) before your verification completed. If you believe this is in error, contact registry@citemaps.org.",
        success: false,
        next: domain
          ? { label: `View ${domain} →`, href: `/${domain}` }
          : { label: "Browse registry →", href: "/" },
      };
    case "entry-missing":
      return {
        heading: "Entry not found",
        body: "The registry entry you tried to claim has been removed. If you believe this is in error, contact registry@citemaps.org.",
        success: false,
      };
    case "token-changed":
      return {
        heading: "Token changed",
        body:
          "Between submission and verification, the token in your citemap changed (you may have re-generated it). Submit a new claim with the current token. Reason: " +
          (reason || "token mismatch"),
        success: false,
        next: { label: "Start a new claim", href: "/" },
      };
    default:
      return {
        heading: "Unknown status",
        body: "We couldn't interpret this verification result. If this looks like a bug, contact registry@citemaps.org.",
        success: false,
        next: { label: "Browse registry", href: "/" },
      };
  }
}
