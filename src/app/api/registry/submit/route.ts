// ============================================================
// POST /api/registry/submit
//
// Accepts a citemap URL, validates it, indexes it. UPSERT
// semantics: resubmitting a URL that already exists updates the
// existing entry's lastValidatedAt rather than creating a
// duplicate.
//
// Body:
//   {
//     url: string,                  // required
//     source?: IntakeSource,        // defaults to "manual_api"
//     submittedBy?: string,         // optional email
//   }
//
// Response 200 — success path:
//   {
//     success: true,
//     data: {
//       id, status, statusMessage?, url, domain,
//       submittedAt, lastValidatedAt?, parsed?, registryUrl?
//     }
//   }
//
// Response 4xx — refusal:
//   { success: false, error: string, code?: string, retryAfter?: number }
//
// Rate limits (v0):
//   - Per IP: 10/hour
//   - Per URL: 1/hour (anti-resubmit-spam)
//
// Auth (v0, optional): when REGISTRY_SUBMIT_TOKEN env is set,
// the route requires Authorization: Bearer {token}. Studio
// passes this from its own env var. Useful while the registry
// is bootstrapping; remove the gate once spam controls mature.
// ============================================================

import { NextRequest, NextResponse } from "next/server";
import { canonicalizeUrl, hostOf } from "@/lib/canonicalize";
import {
  bumpIpRate,
  bumpUrlRate,
  findIdByUrl,
  getEntry,
  newRegistryId,
  saveEntry,
  updateEntry,
} from "@/lib/kv";
import { validate } from "@/lib/validate";
import type {
  IntakeSource,
  RegistryEntry,
  SubmissionRequest,
  SubmissionResponse,
  SubmissionError,
} from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;  // validation fetch is bounded at 10s

const MAX_PER_IP_PER_HOUR  = 10;
const MAX_PER_URL_PER_HOUR = 1;
const RECHECK_INTERVAL_DAYS_INDEXED = 7;
const RECHECK_INTERVAL_DAYS_INVALID = 30;

const VALID_INTAKE_SOURCES = new Set<IntakeSource>([
  "studio_autosubmit",
  "manual_api",
  "domain_probe",
  "crawl_mining",
  "search_probe",
]);

function err(status: number, body: SubmissionError): NextResponse {
  return NextResponse.json(body, { status });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  // Auth gate (optional, env-driven).
  const requiredToken = process.env.REGISTRY_SUBMIT_TOKEN;
  if (requiredToken) {
    const auth = req.headers.get("authorization") ?? "";
    const presented = auth.toLowerCase().startsWith("bearer ")
      ? auth.slice(7).trim()
      : "";
    if (presented !== requiredToken) {
      return err(401, { success: false, error: "Missing or invalid bearer token.", code: "unauthorized" });
    }
  }

  // Parse body.
  let body: SubmissionRequest;
  try {
    body = (await req.json()) as SubmissionRequest;
  } catch {
    return err(400, { success: false, error: "Body is not valid JSON.", code: "bad_request" });
  }

  if (!body || typeof body.url !== "string" || !body.url.trim()) {
    return err(400, { success: false, error: "Field `url` is required.", code: "bad_request" });
  }

  const canonical = canonicalizeUrl(body.url);
  if (!canonical) {
    return err(400, { success: false, error: "URL is malformed or non-http(s).", code: "bad_url" });
  }
  const domain = hostOf(canonical);
  if (!domain) {
    return err(400, { success: false, error: "Could not extract host from URL.", code: "bad_url" });
  }

  const source: IntakeSource = body.source && VALID_INTAKE_SOURCES.has(body.source)
    ? body.source
    : "manual_api";

  // Rate-limit gates. IP first (broader), URL second.
  // x-forwarded-for is what Vercel populates; fall back to a
  // string that's stable per-deployment so we never throw.
  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "unknown";
  const ipCount = await bumpIpRate(ip);
  if (ipCount > MAX_PER_IP_PER_HOUR) {
    return err(429, {
      success: false,
      error: `Submission rate limit exceeded for this IP. Try again in an hour.`,
      code: "rate_limited",
      retryAfter: 3600,
    });
  }
  const urlCount = await bumpUrlRate(canonical);
  if (urlCount > MAX_PER_URL_PER_HOUR) {
    return err(429, {
      success: false,
      error: `This URL has already been submitted recently. Try again in an hour.`,
      code: "rate_limited",
      retryAfter: 3600,
    });
  }

  // UPSERT — does this URL already have an entry?
  const existingId = await findIdByUrl(canonical);
  const now = new Date().toISOString();

  // Run validation BEFORE persisting so the entry lands in its
  // terminal state on first write. Inline for v0; Phase 5 splits
  // this off into a queue.
  const result = await validate(canonical);

  // Compute next-recheck cadence based on validation outcome.
  const recheckDays = result.status === "indexed"
    ? RECHECK_INTERVAL_DAYS_INDEXED
    : RECHECK_INTERVAL_DAYS_INVALID;
  const nextRecheckAt = new Date(Date.now() + recheckDays * 86_400_000).toISOString();

  let entry: RegistryEntry;

  if (existingId) {
    // UPSERT path — patch the existing entry's status / parsed /
    // timestamps. Preserve id, submittedAt, intakeSource of the
    // original. validationCount increments.
    const existing = await getEntry(existingId);
    if (!existing) {
      // Shouldn't happen — index pointed to a missing entry.
      // Fall through to insert path.
    } else {
      const merged = await updateEntry(existingId, {
        format: result.format,
        status: result.status,
        statusMessage: result.statusMessage,
        parsed: result.parsed,
        lastValidatedAt: now,
        nextRecheckAt,
        validationCount: (existing.validationCount ?? 0) + 1,
      });
      entry = merged ?? existing;
      return ok(entry);
    }
  }

  // Fresh insert path.
  const id = newRegistryId();
  entry = {
    id,
    url: canonical,
    domain,
    format: result.format,
    status: result.status,
    statusMessage: result.statusMessage,
    parsed: result.parsed,
    intakeSource: source,
    submittedBy: typeof body.submittedBy === "string" ? body.submittedBy : undefined,
    submittedAt: now,
    lastValidatedAt: now,
    nextRecheckAt,
    validationCount: 1,
  };
  await saveEntry(entry);
  return ok(entry);
}

function ok(entry: RegistryEntry): NextResponse {
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
      // Public detail-page URL. The Next.js registry app is
      // deployed at api.citemaps.org (Vercel); citemaps.org root
      // is the Astro spec site (GitHub Pages) which doesn't
      // serve dynamic routes. Detail pages live at
      // /[domain] (Next.js dynamic route at app/[domain]/page.tsx),
      // NOT under /registry/.
      registryUrl: `https://api.citemaps.org/${entry.domain}`,
    },
  };
  return NextResponse.json(payload, { status: 200 });
}
