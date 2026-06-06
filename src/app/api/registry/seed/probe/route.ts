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
  popDueRechecks,
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
// Phase 2c follow-on 2026-06-06 — cap on existing-entry rechecks
// per cron tick. Conservative initial value; cron's 60s maxDuration
// fits ~5-8 fetches comfortably alongside the new-domain probes
// above. Raise once registry-side telemetry confirms the workload.
const RECHECK_BATCH_SIZE = 5;
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
    // Phase 2c follow-on 2026-06-06 — recheck pass stats.
    // Distinct counters so seed-queue activity stays
    // observably separate from existing-entry recheck activity
    // in ops dashboards.
    rechecks?: {
      processed: number;
      indexed: number;
      invalid: number;
      details: Array<{
        id: string;
        url?: string;
        result: "recheck_indexed" | "recheck_invalid" | "recheck_skipped";
        message?: string;
      }>;
    };
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

  // ── Phase 2c follow-on: recheck pass ─────────────────────
  // Drain a batch of existing entries whose nextRecheckAt has
  // passed and re-validate them. This is the loop that was
  // missing in the original probe cron — nextRecheckAt was
  // being written by submit + the new-domain hit path but
  // never read, so customers who didn't manually re-submit
  // had their registry record frozen at the original
  // validation. With this pass, indexed entries auto-revalidate
  // every 7 days and invalid entries every 30 (cadences set by
  // RECHECK_INTERVAL_DAYS_*).
  //
  // The popDueRechecks helper atomically removes ids from the
  // recheck queue before processing. If revalidation succeeds,
  // saveEntry (via updateEntry) re-adds them with the new
  // nextRecheckAt score. If revalidation fails transiently
  // (network, registry-side bug), the entry drops off the
  // recheck queue and won't auto-revalidate again until the
  // next time the customer submits via Studio. Trade-off:
  // accept a one-cycle gap on transient failures rather than
  // risking an infinite-retry storm.
  const recheckIds = await popDueRechecks(RECHECK_BATCH_SIZE);
  const recheckStats = {
    processed: recheckIds.length,
    indexed: 0,
    invalid: 0,
    details: [] as Array<{
      id: string;
      url?: string;
      result: "recheck_indexed" | "recheck_invalid" | "recheck_skipped";
      message?: string;
    }>,
  };
  for (const id of recheckIds) {
    const existing = await getEntry(id);
    if (!existing) {
      // Entry was deleted between the ZRANGE and now — skip
      // silently. Not a real error; the queue is just slightly
      // out of sync with the entry set.
      recheckStats.details.push({
        id,
        result: "recheck_skipped",
        message: "Entry no longer exists; queue out of sync.",
      });
      continue;
    }
    try {
      const result = await validate(existing.url);
      const now = new Date().toISOString();
      const recheckDays = result.status === "indexed"
        ? RECHECK_INTERVAL_DAYS_INDEXED
        : RECHECK_INTERVAL_DAYS_INVALID;
      const nextRecheckAt = new Date(Date.now() + recheckDays * 86_400_000).toISOString();
      await updateEntry(id, {
        format: result.format,
        status: result.status,
        statusMessage: result.statusMessage,
        parsed: result.parsed,
        lastValidatedAt: now,
        nextRecheckAt,
        validationCount: (existing.validationCount ?? 0) + 1,
      });
      if (result.status === "indexed") recheckStats.indexed++;
      else recheckStats.invalid++;
      recheckStats.details.push({
        id,
        url: existing.url,
        result: result.status === "indexed" ? "recheck_indexed" : "recheck_invalid",
        message: result.statusMessage,
      });
    } catch (e) {
      recheckStats.invalid++;
      recheckStats.details.push({
        id,
        url: existing.url,
        result: "recheck_invalid",
        message: `Pipeline error: ${String(e)}`,
      });
    }
  }
  if (recheckStats.processed > 0) {
    report.rechecks = recheckStats;
  }

  report.queueRemaining = await seedQueueLength();
  const payload: ProbeReport = { success: true, data: report };
  return NextResponse.json(payload, { status: 200 });
}
