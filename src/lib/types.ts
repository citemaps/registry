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
  /** Profile-completeness score 0-100. Heuristic computed at
   *  validation time. */
  profileCompleteness?: number;
  /** SHA1 hash of the canonical body. Used by re-validation to
   *  detect "nothing changed" vs. "publisher updated, re-index". */
  rawHash?: string;
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
   *  (`citemaps.org/registry/{domain}` in Phase 2). */
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
