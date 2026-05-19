// ============================================================
// POST /api/registry/seed
//
// Phase 3 auto-discovery seed intake. Accepts a batch of
// domains observed by Studio (citemaps.ai) and enqueues each
// for the probe worker. Idempotent inside the 30-day window
// via the `seed:seen:{domain}` TTL marker maintained by
// pushToSeedQueue.
//
// Body:
//   {
//     domains: string[],   // required, hostnames (not full URLs)
//     source?: string,     // free-text tag for telemetry
//                          // (e.g. "competitors", "outreach",
//                          //  "citation_monitor")
//   }
//
// Response 200:
//   {
//     success: true,
//     data: { queued: number, skipped: number, total: number }
//   }
//
// Auth: requires Authorization: Bearer {REGISTRY_SUBMIT_TOKEN}
// — same env var Studio uses for the submit route. Without it
// the endpoint is open by intent (dev mode) but the live
// deployment always has it set.
// ============================================================

import { NextRequest, NextResponse } from "next/server";
import { hostOf, isPrivateHost } from "@/lib/canonicalize";
import { pushToSeedQueue } from "@/lib/seed";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 10;

const MAX_DOMAINS_PER_BATCH = 50;

interface SeedRequest {
  domains?: unknown;
  source?: unknown;
}

interface SeedResponseOk {
  success: true;
  data: { queued: number; skipped: number; total: number; source?: string };
}
interface SeedResponseErr {
  success: false;
  error: string;
  code?: string;
}

function err(status: number, body: SeedResponseErr): NextResponse {
  return NextResponse.json(body, { status });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  // Auth gate (mandatory in prod; soft in dev when env unset).
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

  let body: SeedRequest;
  try {
    body = (await req.json()) as SeedRequest;
  } catch {
    return err(400, { success: false, error: "Body is not valid JSON.", code: "bad_request" });
  }

  if (!body || !Array.isArray(body.domains)) {
    return err(400, { success: false, error: "Field `domains` (array) is required.", code: "bad_request" });
  }

  const raw = body.domains as unknown[];
  if (raw.length > MAX_DOMAINS_PER_BATCH) {
    return err(400, {
      success: false,
      error: `Batch too large: ${raw.length} domains (max ${MAX_DOMAINS_PER_BATCH}).`,
      code: "batch_too_large",
    });
  }

  const source = typeof body.source === "string" ? body.source.slice(0, 64) : undefined;

  // Normalize, validate, enqueue.
  let queued = 0;
  let skipped = 0;
  for (const item of raw) {
    if (typeof item !== "string") { skipped++; continue; }
    // Accept full URLs OR bare hostnames — extract host either way.
    let domain: string | null;
    if (item.startsWith("http://") || item.startsWith("https://")) {
      domain = hostOf(item);
    } else {
      // Treat as a hostname directly; sanity-check with URL parse.
      try {
        domain = hostOf(`https://${item}`);
      } catch {
        domain = null;
      }
    }
    if (!domain) { skipped++; continue; }
    if (isPrivateHost(domain)) { skipped++; continue; }
    // Reject obviously invalid: no dot, or all-numeric (IP-ish).
    if (!domain.includes(".") || /^[\d.]+$/.test(domain)) { skipped++; continue; }

    try {
      const wasNew = await pushToSeedQueue(domain);
      if (wasNew) queued++;
      else skipped++;
    } catch {
      // KV error on one domain shouldn't kill the batch.
      skipped++;
    }
  }

  const response: SeedResponseOk = {
    success: true,
    data: { queued, skipped, total: raw.length, source },
  };
  return NextResponse.json(response, { status: 200 });
}
