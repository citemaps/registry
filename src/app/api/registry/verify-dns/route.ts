// ============================================================
// POST /api/registry/verify-dns   { domain } or { url }
//
// "Check now": re-fetch the citemap (fresh registryToken), then look
// up `_citemap.{registrable domain}` and recompute the Verified state.
// Public and unauthenticated — it only re-runs the same checks the
// weekly recheck loop runs, and returns PII-free state. Rate-limited
// per IP and per entry.
// decisions/registry-verified-badge-domain-anchored.md
// ============================================================
import { NextRequest, NextResponse } from "next/server";
import { canonicalizeUrl } from "@/lib/canonicalize";
import { bumpIpRate, bumpUrlRate, findIdByUrl, getEntryByDomain, updateEntry, getEntry } from "@/lib/kv";
import { validate } from "@/lib/validate";
import { applyValidation } from "@/lib/recheck";
import { refreshVerification } from "@/lib/verify-entry";
import { publicVerification } from "@/lib/dns-verify";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const MAX_PER_IP_PER_HOUR = 30;
const MAX_PER_ENTRY_PER_HOUR = 12;

export async function POST(req: NextRequest) {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0].trim() || req.headers.get("x-real-ip") || "unknown";
  if ((await bumpIpRate(`dns:${ip}`).catch(() => 0)) > MAX_PER_IP_PER_HOUR) {
    return NextResponse.json({ success: false, error: "Too many checks — try again in a bit.", code: "rate_limited" }, { status: 429 });
  }
  const body = (await req.json().catch(() => ({}))) as { domain?: string; url?: string };
  let id: string | null = null;
  if (typeof body.url === "string") {
    const c = canonicalizeUrl(body.url);
    if (c) id = await findIdByUrl(c);
  }
  if (!id && typeof body.domain === "string") {
    const d = body.domain.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    id = (await getEntryByDomain(d))?.id ?? null;
  }
  if (!id) return NextResponse.json({ success: false, error: "No registry entry for that domain yet.", code: "not_found" }, { status: 404 });

  const entry = await getEntry(id);
  if (!entry) return NextResponse.json({ success: false, error: "No registry entry for that domain yet.", code: "not_found" }, { status: 404 });
  if ((await bumpUrlRate(`dns:${entry.url}`).catch(() => 0)) > MAX_PER_ENTRY_PER_HOUR) {
    return NextResponse.json({ success: false, error: "This entry was checked many times this hour — try again later.", code: "rate_limited" }, { status: 429 });
  }

  // Fresh token first: Verified needs the token live in the citemap.
  const r = await validate(entry.url);
  await updateEntry(id, applyValidation(entry, r, { now: new Date().toISOString() }).patch);
  const fresh = await refreshVerification(id);
  if (!fresh) return NextResponse.json({ success: false, error: "Registry entry missing." }, { status: 500 });

  return NextResponse.json({
    success: true,
    data: {
      id: fresh.id, domain: fresh.domain, status: fresh.status,
      hasToken: !!fresh.parsed?.registryToken,
      ...publicVerification(fresh),
    },
  });
}
