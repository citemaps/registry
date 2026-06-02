// ============================================================
// Registry types — shared between submission API, validation
// worker, and (later) public index renderer + Studio client.
//
// The wire-format contract is the one shape that has to stay
// stable across the citemaps.org and citemaps.ai codebases.
// Both sides declare these types locally; they diverge
// gracefully as long as the JSON shape matches.
// ============================================================

/** Lifecycle status for a registry entry. Drives the response
 *  shape on /api/registry/status. */
export type RegistryStatus =
  | "queued"        // accepted, validation not yet run
  | "validating"    // worker is actively fetching/parsing
  | "indexed"       // validated, in the public index
  | "invalid"       // failed validation — see statusMessage
  | "timeout"       // fetch took too long; will re-try later
  | "blocked";      // rejected at intake (SSRF, rate limit, etc.)

/** Where the submission came from. Lets us segment the index by
 *  intake quality + run intake-specific dedupe + tune rate
 *  limits per source. */
export type IntakeSource =
  | "studio_autosubmit"  // citemaps.ai Studio publishing flow
  | "manual_api"         // direct curl / other tool
  | "domain_probe"       // Phase 3 auto-discovery worker
  | "crawl_mining"       // Phase 5 Common Crawl pipeline
  | "search_probe";      // Phase 6 search-engine API discovery

/** What format the submitted URL served. The validator detects
 *  this from Content-Type + body shape; recorded so re-validation
 *  knows what to expect. */
export type SubmissionFormat = "json" | "html" | "unknown";

/** Extracted metadata from a successfully-validated citemap.
 *  Populated only when status === "indexed". Renderers and
 *  faceted-search consumers read from this rather than re-parsing
 *  the raw body. */
export interface ParsedCitemap {
  /** Spec version declared at the root, e.g. "3.2". */
  citemapVersion?: string;
  /** Display name pulled from brand.name or top-level entity. */
  entityName?: string;
  /** schema.org @type when present (e.g. "Organization",
   *  "LocalBusiness"). */
  entityType?: string;
  /** Primary vertical key when declared (e.g. "manufacturer",
   *  "healthcare"). */
  primaryVertical?: string;
  /** All vertical keys present — supports multi-vertical entities. */
  verticals?: string[];
  /** Which top-level module sections are present. Lets the
   *  Phase 2 faceted browse show "all citemaps with a `products`
   *  section" etc. */
  moduleKeys?: string[];
  /** Convenience: did the parsed payload include a trust block?
   *  Surfaced as a badge in the Phase 2 index. */
  hasTrust?: boolean;
  /** Convenience: did it include a temporalRecord? */
  hasTemporalRecord?: boolean;
  /** v3.3 §3.2: did the payload include a non-empty `policy`
   *  foundational section? Empty {} (the always-on default)
   *  reads as false here — only meaningful when the publisher
   *  has actually set at least one sub-policy URL. */
  hasPolicy?: boolean;
  /** v3.3 §3.2: did the payload include a non-empty
   *  `verification` foundational section (graduated from
   *  optional module to foundational in v3.3)? */
  hasVerification?: boolean;
  /** Profile-completeness score 0-100. Heuristic computed at
   *  validation time. */
  profileCompleteness?: number;
  /** SHA1 hash of the canonical body. Used by re-validation to
   *  detect "nothing changed" vs. "publisher updated, re-index". */
  rawHash?: string;
  /** Publisher-set registry token from `citationContract.registryToken`
   *  per v3.2.1 spec. Used by Phase 4 claim flow to prove publisher
   *  ownership: claimant submits a token + email, we re-fetch the
   *  citemap, and compare the submitted token against this parsed
   *  value. Token is opaque metadata otherwise — no inference,
   *  no AI-grounding weight. Absent for citemaps that don't declare
   *  one (legacy / hand-authored / unaware publishers). */
  registryToken?: string;
}

/** The full registry entry as persisted in KV. */
export interface RegistryEntry {
  /** Stable ID — `reg_{16-char hex}` from crypto.randomUUID. */
  id: string;
  /** Canonicalized URL (scheme + host + path; query params
   *  preserved if meaningful, strip-list documented in
   *  canonicalize.ts). Used as the dedupe key. */
  url: string;
  /** Bare host extracted from url, lowercased + www-stripped.
   *  Drives per-domain rate limiting + display URL structure
   *  (`api.citemaps.org/{domain}` — the registry's Vercel app
   *  serves the detail page at /[domain]; citemaps.org root is
   *  the Astro spec site on GitHub Pages and can't serve
   *  dynamic routes). */
  domain: string;
  /** Detected format from the validation fetch. */
  format: SubmissionFormat;
  /** Current lifecycle status. */
  status: RegistryStatus;
  /** Human-readable message when status is invalid/timeout/blocked.
   *  Surfaced in the status response so Studio can show the
   *  publisher what went wrong. */
  statusMessage?: string;
  /** Extracted metadata when status === "indexed". */
  parsed?: ParsedCitemap;
  /** Where the submission came from. */
  intakeSource: IntakeSource;
  /** Optional email of the submitter when the intake source
   *  provides one (Studio passes the property owner email). Not
   *  surfaced publicly until Phase 4 verification. */
  submittedBy?: string;
  /** ISO submission timestamp. */
  submittedAt: string;
  /** ISO timestamp of last successful validation. */
  lastValidatedAt?: string;
  /** ISO timestamp of next scheduled re-validation. Driven by
   *  status: indexed = weekly, invalid = monthly, stale = quarterly. */
  nextRecheckAt?: string;
  /** Number of times this entry has been re-validated. Increments
   *  on each successful re-check; resets on UPSERT from a new
   *  submission. */
  validationCount: number;
  // ── Phase 4: verification + claim ──────────────────────────
  // Set when a publisher successfully completes the claim flow
  // (token match in citemap + magic-link verify on email). Email
  // is the source-of-truth for ownership; accountId is recorded
  // when the claimant was logged into Studio at claim time but
  // is NOT used to gate access — claim survives if the publisher
  // stops using Studio. (Phase 4 of citemaps-org-registry ADR.)
  /** Email that successfully claimed this entry. Source of truth
   *  for ownership. Set on successful magic-link verify. */
  claimedByEmail?: string;
  /** Optional Studio AccountId recorded at claim time when the
   *  claimant was logged into Studio. Informational only — not
   *  used to gate edit access or transfer. */
  claimedByAccountId?: string;
  /** ISO timestamp of successful claim. */
  claimedAt?: string;
  /** Display name the publisher set during claim — shown on the
   *  registry detail page as "Claimed by X" instead of the raw
   *  email (privacy). Optional; falls back to email's local-part
   *  when absent. */
  claimedDisplayName?: string;
}

/** Pending magic-link claim verification. One row per outstanding
 *  claim attempt; consumed on successful verify. TTL'd at 24h. */
export interface PendingClaim {
  /** Single-use verification token (NOT the citemap's registry
   *  token — this is the email-verify nonce). `clm_{32-hex}`. */
  verifyToken: string;
  /** Registry entry being claimed. */
  registryEntryId: string;
  /** Claimant email — destination of the magic-link email. */
  email: string;
  /** Optional Studio AccountId when claimant was logged into
   *  Studio at submit time. */
  accountId?: string;
  /** Display name the publisher set during the claim form. */
  displayName?: string;
  /** ISO timestamp of submit. */
  createdAt: string;
  /** ISO timestamp the magic link expires (24h after createdAt). */
  expiresAt: string;
}

/** Inbound payload for POST /api/registry/submit. */
export interface SubmissionRequest {
  /** The citemap URL to register. Must be http(s); private/local
   *  hosts rejected as SSRF risk. */
  url: string;
  /** Where the submission originates. Defaults to "manual_api"
   *  when omitted. */
  source?: IntakeSource;
  /** Optional submitter email. Stored opaquely; not surfaced
   *  publicly until Phase 4 verification. */
  submittedBy?: string;
}

/** Response shape for POST /api/registry/submit + GET
 *  /api/registry/status/{id}. */
export interface SubmissionResponse {
  success: true;
  data: {
    id: string;
    status: RegistryStatus;
    statusMessage?: string;
    url: string;
    domain: string;
    submittedAt: string;
    lastValidatedAt?: string;
    parsed?: ParsedCitemap;
    /** Future Phase 2: public index URL for this entry.
     *  Always returned so callers can pre-empt the eventual link
     *  surface. */
    registryUrl?: string;
    /** Phase 4 claim signals — only present when the entry is
     *  already claimed by a verified publisher. Studio + other
     *  external callers use these to render a "✓ Claimed" state
     *  instead of a "Claim this entry" CTA. Email is intentionally
     *  *not* leaked — only the boolean + display name. */
    claimed?: boolean;
    claimedAt?: string;
    claimedDisplayName?: string;
  };
}

/** Error response — used for 4xx + 5xx. */
export interface SubmissionError {
  success: false;
  error: string;
  /** Optional structured detail for clients to act on (e.g.
   *  "rate_limited" with retryAfter seconds). */
  code?: string;
  retryAfter?: number;
}
