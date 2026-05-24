// ============================================================
// GET /api/registry/claim/verify/{verifyToken}
//
// Magic-link callback for Phase 4 claim verification. Click-
// to-confirm endpoint — finalizes the claim by:
//
//   1. Looking up the pending claim by verify token (single-
//      use; TTL'd at 24h)
//   2. Re-checking the registry entry is still unclaimed
//      (race protection against simultaneous claims of the
//      same entry)
//   3. Re-verifying the token still matches the citemap at
//      its URL (defends against publisher rotating the token
//      between submit and verify)
//   4. Stamping the entry with claimedByEmail + claimedAt +
//      optional claimedByAccountId + claimedDisplayName
//   5. Deleting the pending-claim record (single-use)
//   6. Redirecting to a friendly confirmation page
//
// All failure modes redirect to a static result page with a
// query param explaining what happened — easier for users
// landing from email clients than seeing JSON.
// ============================================================

import { NextRequest, NextResponse } from "next/server";
import {
  getPendingClaim,
  deletePendingClaim,
  getEntry,
  updateEntry,
} from "@/lib/kv";
import { verifyTokenAtUrl } from "@/lib/claim";

export const maxDuration = 30;

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  const redirectBase = buildRedirectBase(req);

  if (!token || !/^clm_[a-f0-9]{32}$/.test(token)) {
    return NextResponse.redirect(`${redirectBase}/registry/claim/result?status=invalid`);
  }

  const pending = await getPendingClaim(token);
  if (!pending) {
    // Expired (24h TTL) or already-consumed.
    return NextResponse.redirect(`${redirectBase}/registry/claim/result?status=expired`);
  }

  const entry = await getEntry(pending.registryEntryId);
  if (!entry) {
    // Entry vanished between submit and verify — unlikely
    // but possible if an admin manually deleted it.
    await deletePendingClaim(token);
    return NextResponse.redirect(`${redirectBase}/registry/claim/result?status=entry-missing`);
  }

  // Race: another verify call may have already finalized
  // the claim. First-claim-wins still holds.
  if (entry.claimedByEmail) {
    await deletePendingClaim(token);
    return NextResponse.redirect(`${redirectBase}/registry/claim/result?status=already-claimed`);
  }

  // Re-verify token still matches the live citemap. Publisher
  // could have rotated between submit + verify; if so, the
  // claim is no longer valid against the original submitted
  // token. (Phase 4.5 will handle rotation gracefully.)
  // Use the stored expected token from the entry's parsed data
  // when available, otherwise fall through (we'd already
  // matched at submit time; this is the defensive re-check).
  const expectedToken = entry.parsed?.registryToken;
  if (expectedToken) {
    const matchResult = await verifyTokenAtUrl(entry.url, expectedToken);
    if (!matchResult.ok) {
      await deletePendingClaim(token);
      return NextResponse.redirect(
        `${redirectBase}/registry/claim/result?status=token-changed&reason=${encodeURIComponent(matchResult.reason)}`,
      );
    }
  }

  // ── Finalize claim ─────────────────────────────────────
  const claimedAt = new Date().toISOString();
  await updateEntry(pending.registryEntryId, {
    claimedByEmail: pending.email,
    claimedByAccountId: pending.accountId,
    claimedAt,
    claimedDisplayName: pending.displayName,
  });
  await deletePendingClaim(token);

  // Redirect to confirmation with the domain for friendly copy
  return NextResponse.redirect(
    `${redirectBase}/registry/claim/result?status=verified&domain=${encodeURIComponent(entry.domain)}`,
  );
}

function buildRedirectBase(req: NextRequest): string {
  const forwardedHost = req.headers.get("x-forwarded-host");
  const host = forwardedHost || req.headers.get("host") || "citemaps.org";
  const protocol = req.headers.get("x-forwarded-proto") || (host.startsWith("localhost") ? "http" : "https");
  return `${protocol}://${host}`;
}
