// ============================================================
// How a (re)validation result is applied to an existing entry.
//
// A recheck that can't reach the site (timeout, dropped connection,
// 401/403/429/5xx, firewall challenge page) says nothing about the
// citemap, so a listed entry stays listed — status and parsed data
// kept, the failure recorded — until UNREACHABLE_GRACE_CHECKS checks
// in a row have failed (≈3 weeks on the weekly cadence). A real
// content problem (404/410, broken JSON, not a citemap, shape error)
// unlists it at once, as before. Used by every recheck path: the cron,
// revalidate, verify-dns and re-submission.
// ============================================================
import type { RegistryEntry } from "./types";
import type { ValidationResult } from "./validate";

export const UNREACHABLE_GRACE_CHECKS = 3;

export function applyValidation(
  existing: RegistryEntry,
  result: ValidationResult,
  opts: { now: string; nextRecheckAt?: string },
): { patch: Partial<RegistryEntry>; kept: boolean } {
  if (result.status === "indexed") {
    return {
      kept: false,
      patch: {
        format: result.format, status: result.status, statusMessage: undefined, parsed: result.parsed,
        lastValidatedAt: opts.now, validationCount: (existing.validationCount ?? 0) + 1,
        consecutiveFailures: 0, lastCheckError: undefined, lastCheckFailedAt: undefined,
        contentSource: "fetched", pushedAt: undefined,
        ...(opts.nextRecheckAt ? { nextRecheckAt: opts.nextRecheckAt } : {}),
      },
    };
  }
  const failures = (existing.consecutiveFailures ?? 0) + 1;
  // Pushed entries exist because the site can't be reached — an
  // unreachable recheck is expected, not a strike. They stay listed while
  // the DNS record matches (enforced in verify-entry.ts) and refresh on
  // the next producer submission.
  const pushedKeep = existing.status === "indexed" && existing.contentSource === "pushed" && result.failureKind !== "content";
  const grace = pushedKeep || (existing.status === "indexed" && result.failureKind !== "content" && failures < UNREACHABLE_GRACE_CHECKS);
  if (grace) {
    // Keep it listed with its last good data; record the failure.
    return {
      kept: true,
      patch: {
        consecutiveFailures: pushedKeep ? 0 : failures, lastCheckError: result.statusMessage, lastCheckFailedAt: opts.now,
        ...(opts.nextRecheckAt ? { nextRecheckAt: opts.nextRecheckAt } : {}),
      },
    };
  }
  return {
    kept: false,
    patch: {
      format: result.format, status: result.status, statusMessage: result.statusMessage, parsed: result.parsed,
      lastValidatedAt: opts.now, validationCount: (existing.validationCount ?? 0) + 1,
      consecutiveFailures: failures, lastCheckError: result.statusMessage, lastCheckFailedAt: opts.now,
      ...(opts.nextRecheckAt ? { nextRecheckAt: opts.nextRecheckAt } : {}),
    },
  };
}
