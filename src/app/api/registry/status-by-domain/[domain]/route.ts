// ============================================================
// GET /api/registry/status-by-domain/{domain}
//
// Phase 4 — Studio's "Claim this entry" card on CitemapStudioTab
// polls this to decide whether to render the claim CTA or the
// "✓ Claimed" confirmation. The Studio always knows the domain
// (Property.domain) but not the registry entry id, so a
// domain-keyed lookup avoids round-trip persistence of the
// submission id on Property records.
//
// Status is public — same data shape as /status/{id}, including
// the Phase 4 claim signals. Returns 404 when the domain has
// never been submitted. Domain is normalized lowercase +
// strip-protocol on the caller side, but we also defensively
// trim + lowercase here.
//
// Single-domain query — list-most-recent semantics live on the
// public detail page at citemaps.org/{domain}, not here.
// ============================================================

import { NextRequest, NextResponse } from "next/server";
import { getEntryByDomain } from "@/lib/kv";
import type { SubmissionResponse, SubmissionError } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ domain: string }> },
): Promise<NextResponse> {
  const { domain: rawDomain } = await params;
  const domain = String(rawDomain || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/$/, "");
  if (!domain) {
    return NextResponse.json<SubmissionError>(
      { success: false, error: "Path param `domain` is required.", code: "bad_request" },
      { status: 400 },
    );
  }

  const entry = await getEntryByDomain(domain);
  if (!entry) {
    return NextResponse.json<SubmissionError>(
      { success: false, error: "No registry entry for this domain.", code: "not_found" },
      { status: 404 },
    );
  }

  const payload: SubmissionResponse = {
    success: true,
    data: {
      id: entry.id,
      status: entry.status,
      statusMessage: entry.statusMessage,
      url: entry.url,
      domain: entry.domain,
      submittedAt: entry.submittedAt,
      lastValidatedAt: entry.lastValidatedAt,
      parsed: entry.parsed,
      // Public detail-page URL at api.citemaps.org/{domain}
      // (Next.js dynamic route on the registry's Vercel app).
      // citemaps.org root is the Astro spec site (GitHub Pages).
      registryUrl: `https://api.citemaps.org/${entry.domain}`,
      ...(entry.claimedByEmail
        ? {
            claimed: true,
            claimedAt: entry.claimedAt,
            claimedDisplayName: entry.claimedDisplayName,
          }
        : {}),
    },
  };
  return NextResponse.json(payload, { status: 200 });
}
