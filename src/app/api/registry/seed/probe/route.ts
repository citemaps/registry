// ============================================================
// GET /api/registry/seed/probe
//
// Vercel cron handler — runs on a fixed schedule (vercel.json),
// drains a batch of domains off the seed queue, probes each
// for a citemap at the well-known paths, and on hit feeds the
// existing validation + persistence pipeline with
// intakeSource: "domain_probe".
//
// Auth: in production Vercel cron requests include a CRON_SECRET
// header. The endpoint accepts either:
//   - Authorization: Bearer {CRON_SECRET}     (Vercel cron pattern)
//   - Authorization: Bearer {REGISTRY_SUBMIT_TOKEN}  (manual ops)
//
// Misses are silent — no registry entry written. The 30-day
// `seed:seen:{domain}` marker (set when the domain was first
// queued) prevents re-enqueueing during the window.
//
// Hit path reuses validate.ts + saveEntry/updateEntry exactly
// like the public submit route — single source of truth for the
// "fetch → parse → persist" pipeline.
// ============================================================

import { NextRequest, NextResponse } from "next/server";
import { canonicalizeUrl, hostOf } from "@/lib/canonicalize";
import {
  findIdByUrl,
  getEntry,
  newRegistryId,
  saveEntry,
  updateEntry,
} from "@/lib/kv";
import { popFromSeedQueue, probeDomain, seedQueueLength } from "@/lib/seed";
import { validate } from "@/lib/validate";
import type { RegistryEntry } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;   // batch of 10 × ~5s probe + occasional validate fetches

const BATCH_SIZE = 10;
const RECHECK_INTERVAL_DAYS_INDEXED = 7;
const RECHECK_INTERVAL_DAYS_INVALID = 30;

interface ProbeReport {
  success: true;
  data: {
    processed: number;
    hits: number;
    misses: number;
    indexed: number;
    invalid: number;
    queueRemaining: number;
    details: Array<{
      domain: string;
      result: "hit_indexed" | "hit_invalid" | "miss";
      url?: string;
      message?: string;
    }>;
  };
}

function authorize(req: NextRequest): { ok: boolean; reason?: string } {
  const cronSecret = process.env.CRON_SECRET;
  const submitToken = process.env.REGISTRY_SUBMIT_TOKEN;
  // If neither is set, allow (dev mode).
  if (!cronSecret && !submitToken) return { ok: true };

  const auth = req.headers.get("authorization") ?? "";
  const presented = auth.toLowerCase().startsWith("bearer ")
    ? auth.slice(7).trim()
    : "";
  if (cronSecret && presented === cronSecret) return { ok: true };
  if (submitToken && presented === submitToken) return { ok: true };
  return { ok: false, reason: "Missing or invalid bearer token." };
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = authorize(req);
  if (!auth.ok) {
    return NextResponse.json(
      { success: false, error: auth.reason ?? "Unauthorized." },
      { status: 401 },
    );
  }

  const domains = await popFromSeedQueue(BATCH_SIZE);
  const report: ProbeReport["data"] = {
    processed: domains.length,
    hits: 0,
    misses: 0,
    indexed: 0,
    invalid: 0,
    queueRemaining: 0,
    details: [],
  };

  for (const domain of domains) {
    const probe = await probeDomain(domain);
    if (!probe.url) {
      report.misses++;
      report.details.push({ domain, result: "miss" });
      continue;
    }
    report.hits++;

    // Feed the existing pipeline — canonicalize → validate →
    // upsert. Reuses every guard / parser in validate.ts so the
    // probe-discovered entries land in the same shape as
    // submission-API entries.
    const canonical = canonicalizeUrl(probe.url);
    if (!canonical) {
      report.invalid++;
      report.details.push({ domain, result: "hit_invalid", url: probe.url, message: "URL did not canonicalize." });
      continue;
    }
    const host = hostOf(canonical) ?? domain;

    try {
      const result = await validate(canonical);
      const now = new Date().toISOString();
      const recheckDays = result.status === "indexed"
        ? RECHECK_INTERVAL_DAYS_INDEXED
        : RECHECK_INTERVAL_DAYS_INVALID;
      const nextRecheckAt = new Date(Date.now() + recheckDays * 86_400_000).toISOString();

      const existingId = await findIdByUrl(canonical);
      if (existingId) {
        const existing = await getEntry(existingId);
        if (existing) {
          await updateEntry(existingId, {
            format: result.format,
            status: result.status,
            statusMessage: result.statusMessage,
            parsed: result.parsed,
            lastValidatedAt: now,
            nextRecheckAt,
            validationCount: (existing.validationCount ?? 0) + 1,
          });
          if (result.status === "indexed") report.indexed++;
          else report.invalid++;
          report.details.push({
            domain,
            result: result.status === "indexed" ? "hit_indexed" : "hit_invalid",
            url: canonical,
            message: result.statusMessage,
          });
          continue;
        }
      }

      const entry: RegistryEntry = {
        id: newRegistryId(),
        url: canonical,
        domain: host,
        format: result.format,
        status: result.status,
        statusMessage: result.statusMessage,
        parsed: result.parsed,
        intakeSource: "domain_probe",
        submittedAt: now,
        lastValidatedAt: now,
        nextRecheckAt,
        validationCount: 1,
      };
      await saveEntry(entry);
      if (result.status === "indexed") report.indexed++;
      else report.invalid++;
      report.details.push({
        domain,
        result: result.status === "indexed" ? "hit_indexed" : "hit_invalid",
        url: canonical,
        message: result.statusMessage,
      });
    } catch (e) {
      report.invalid++;
      report.details.push({
        domain,
        result: "hit_invalid",
        url: canonical,
        message: `Pipeline error: ${String(e)}`,
      });
    }
  }

  report.queueRemaining = await seedQueueLength();
  const payload: ProbeReport = { success: true, data: report };
  return NextResponse.json(payload, { status: 200 });
}
