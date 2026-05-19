// ============================================================
// GET /api/registry/status/{id}
//
// Returns the current state of a registry submission. Studio
// polls this after fire-and-forget submit; later phases use it
// for status badges + the public detail page's "last validated"
// timestamp.
//
// Always 200 on a real ID (the entry's own status field carries
// the lifecycle state). 404 when the ID doesn't exist — caller
// can distinguish "not yet submitted" from "submitted but
// invalid."
// ============================================================

import { NextRequest, NextResponse } from "next/server";
import { getEntry } from "@/lib/kv";
import type { SubmissionResponse, SubmissionError } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  if (!id || typeof id !== "string") {
    return NextResponse.json<SubmissionError>(
      { success: false, error: "Path param `id` is required.", code: "bad_request" },
      { status: 400 },
    );
  }

  const entry = await getEntry(id);
  if (!entry) {
    return NextResponse.json<SubmissionError>(
      { success: false, error: "Registry entry not found.", code: "not_found" },
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
      registryUrl: `https://citemaps.org/registry/${entry.domain}`,
    },
  };
  return NextResponse.json(payload, { status: 200 });
}
