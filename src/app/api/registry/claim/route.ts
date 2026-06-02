// ============================================================
// POST /api/registry/claim
//
// Phase 4 of the citemaps.org registry build — publisher
// claim flow. Two-factor verification:
//
//   1. TOKEN MATCH — claimant submits the registryToken from
//      their citemap. We re-fetch the citemap from its
//      published URL and confirm the submitted token matches
//      the live value (publisher controls the deployment).
//
//   2. EMAIL VERIFY — on token match, we send a magic-link
//      email to the submitted address. Clicking the link
//      finalizes the claim. (Claimant controls the email.)
//
// First-claim-wins. Already-claimed entries return 409.
// Token rotation (publisher loses control, regenerates with
// new token → next claim transfers) deferred to Phase 4.5.
//
// Per ADR + Brian's call: email is the source-of-truth for
// ownership. Optional accountId is recorded informationally
// for analytics — does NOT lock the claim to a Studio
// Account. Publisher can stop using Studio and the claim
// remains theirs (via the email).
//
// Spec: ~/CoWork/citemap/spec/v3.2.1-registry-token.md
// ============================================================

import { NextRequest, NextResponse } from "next/server";
import {
  findIdByUrl,
  getEntry,
  newClaimVerifyToken,
  savePendingClaim,
  bumpClaimIpRate,
} from "@/lib/kv";
import {
  verifyTokenAtUrl,
  isPlausibleToken,
} from "@/lib/claim";
import { sendClaimVerify } from "@/lib/email";
import { canonicalizeUrl } from "@/lib/canonicalize";

const MAX_CLAIMS_PER_IP_PER_HOUR = 5;
const PENDING_TTL_HOURS = 24;

export const maxDuration = 30;

interface ClaimRequest {
  /** Registry entry URL (canonicalized server-side). */
  url: string;
  /** Claimant email — destination of the magic-link verify. */
  email: string;
  /** Token published in the citemap's citationContract.registryToken. */
  token: string;
  /** Optional publisher display name — shown on registry detail
   *  page instead of the raw email after claim. */
  displayName?: string;
  /** Optional Studio AccountId when claimant was logged into
   *  Studio at submit time. Stored alongside the claim for
   *  analytics; does NOT lock the claim to the account. */
  accountId?: string;
}

export async function POST(req: NextRequest) {
  // ── Rate limit ─────────────────────────────────────────
  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0].trim() ||
    req.headers.get("x-real-ip") ||
    "unknown";
  const rateCount = await bumpClaimIpRate(ip).catch(() => 0);
  if (rateCount > MAX_CLAIMS_PER_IP_PER_HOUR) {
    return NextResponse.json(
      {
        success: false,
        error: `Too many claim attempts (${MAX_CLAIMS_PER_IP_PER_HOUR}/hour limit). Try again in a bit.`,
        code: "rate_limited",
        retryAfter: 3600,
      },
      { status: 429 },
    );
  }

  // ── Parse + validate body ──────────────────────────────
  const body = (await req.json().catch(() => ({}))) as Partial<ClaimRequest>;
  const { url, email, token, displayName, accountId } = body;

  if (!url || typeof url !== "string") {
    return NextResponse.json({ success: false, error: "Missing url." }, { status: 400 });
  }
  if (!email || typeof email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json({ success: false, error: "A valid email is required." }, { status: 400 });
  }
  if (!isPlausibleToken(token)) {
    return NextResponse.json(
      { success: false, error: "Missing or malformed registry token." },
      { status: 400 },
    );
  }
  const normalizedEmail = email.trim().toLowerCase();

  // ── Look up the registry entry ─────────────────────────
  const canonicalUrl = canonicalizeUrl(url);
  if (!canonicalUrl) {
    return NextResponse.json({ success: false, error: "Invalid URL." }, { status: 400 });
  }
  const entryId = await findIdByUrl(canonicalUrl);
  if (!entryId) {
    return NextResponse.json(
      {
        success: false,
        error: "We don't have a registry entry for this URL yet. Submit it first, then come back to claim.",
        code: "not_indexed",
      },
      { status: 404 },
    );
  }
  const entry = await getEntry(entryId);
  if (!entry) {
    return NextResponse.json(
      { success: false, error: "Registry entry missing.", code: "internal" },
      { status: 500 },
    );
  }

  // ── First-claim-wins ───────────────────────────────────
  if (entry.claimedByEmail) {
    return NextResponse.json(
      {
        success: false,
        error: "This entry is already claimed. Contact registry@citemaps.org if you believe this is in error.",
        code: "already_claimed",
        // Tell the caller WHO claimed it (privacy-safe — display
        // name only; never the email).
        claimedDisplayName: entry.claimedDisplayName,
        claimedAt: entry.claimedAt,
      },
      { status: 409 },
    );
  }

  // ── Verify token matches what's at the URL right now ───
  // The deep proof: not the entry.parsed.registryToken
  // (which could be stale from the last validation), but
  // a live re-fetch. Claim is a moment of authority.
  const matchResult = await verifyTokenAtUrl(canonicalUrl, token!.trim());
  if (!matchResult.ok) {
    return NextResponse.json(
      {
        success: false,
        error: matchResult.message,
        code: matchResult.reason,
      },
      { status: matchResult.reason === "token-mismatch" ? 403 : 400 },
    );
  }

  // ── Mint pending claim + send magic link ───────────────
  const verifyToken = newClaimVerifyToken();
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + PENDING_TTL_HOURS * 60 * 60 * 1000).toISOString();

  await savePendingClaim({
    verifyToken,
    registryEntryId: entryId,
    email: normalizedEmail,
    accountId: accountId && typeof accountId === "string" ? accountId : undefined,
    displayName:
      displayName && typeof displayName === "string" && displayName.trim()
        ? displayName.trim().slice(0, 80)
        : undefined,
    createdAt,
    expiresAt,
  });

  const verifyUrl = buildVerifyUrl(req, verifyToken);
  await sendClaimVerify({
    email: normalizedEmail,
    verifyUrl,
    domain: entry.domain,
    entityName: entry.parsed?.entityName,
    displayName:
      displayName && typeof displayName === "string" && displayName.trim()
        ? displayName.trim().slice(0, 80)
        : undefined,
    expiresAt,
  });

  return NextResponse.json({
    success: true,
    data: {
      message: `Magic link sent to ${normalizedEmail}. Click the link in the email to finalize the claim. Expires in ${PENDING_TTL_HOURS} hours.`,
      expiresAt,
    },
  });
}

/** Build the public magic-link URL. Prefers the request's
 *  forwarded host so deployments work behind Vercel without
 *  a hard-coded production URL. */
function buildVerifyUrl(req: NextRequest, verifyToken: string): string {
  const forwardedHost = req.headers.get("x-forwarded-host");
  // Default fallback is api.citemaps.org — the registry's Vercel
  // deployment. citemaps.org root is the Astro spec site (GitHub
  // Pages) which can't serve dynamic /registry/* routes.
  const host = forwardedHost || req.headers.get("host") || "api.citemaps.org";
  const protocol = req.headers.get("x-forwarded-proto") || (host.startsWith("localhost") ? "http" : "https");
  return `${protocol}://${host}/registry/claim/verify/${verifyToken}`;
}
