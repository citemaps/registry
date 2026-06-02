// ============================================================
// Email — minimal Resend wrapper for citemaps.org registry.
//
// Currently sends a single template: the claim-verify magic
// link. Kept separate from any larger email infrastructure
// because citemaps.org is operationally independent from
// citemaps.ai (different deployment, different env, different
// domain) — duplicating ~50 lines beats coupling the two
// codebases for a single email type.
//
// Env: RESEND_API_KEY (set in Vercel project settings).
// Sender domain must be verified in Resend for citemaps.org.
// ============================================================

import { Resend } from "resend";

let _resend: Resend | null = null;
function getResend(): Resend | null {
  if (_resend) return _resend;
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    console.warn("[email] RESEND_API_KEY not set — email sends will no-op");
    return null;
  }
  _resend = new Resend(key);
  return _resend;
}

// Sender — must match a Resend-verified domain. citemaps.org
// owns its own sender to keep registry communications
// visually + DNS-separated from any Studio email.
const FROM = "citemaps.org Registry <registry@notifications.citemaps.org>";

// ── Email atom set (compact; matches citemaps.ai email shape
// so the two senders feel like the same product family) ────
const css = {
  wrap:   "max-width:560px;margin:0 auto;font-family:'Geist',-apple-system,BlinkMacSystemFont,sans-serif;color:#0f0f0e;background:#ffffff",
  header: "padding:32px 40px 16px;border-bottom:1px solid #e2e2dc",
  body:   "padding:32px 40px",
  h1:     "font-size:24px;font-weight:800;letter-spacing:-0.01em;margin:0 0 8px",
  rule:   "border:none;border-top:1px solid #e2e2dc;margin:0 0 24px",
  p:      "font-size:14px;line-height:1.6;color:#3a3a34;margin:0 0 16px",
  btn:    "display:inline-block;padding:12px 24px;background:#0f0f0e;color:#ffffff;text-decoration:none;font-size:13px;font-weight:600;letter-spacing:0.02em;margin-top:8px",
  databox:"background:#fafaf7;border:1px solid #e2e2dc",
  row:    "display:flex;justify-content:space-between;border-bottom:1px solid #e2e2dc",
  lbl:    "font-size:12px;color:#6b6b64;text-transform:uppercase;letter-spacing:0.06em",
  val:    "font-size:13px;color:#0f0f0e;font-family:'JetBrains Mono',monospace",
  small:  "font-size:11px;color:#9a9a90;line-height:1.55",
  logo:   "color:#0f0f0e;text-decoration:none;font-size:14px;font-weight:800;letter-spacing:-0.01em",
};

const logo = `<a href="https://citemaps.org" style="${css.logo}">citemaps.org</a>`;

function footer(): string {
  return `<div style="padding:20px 40px;border-top:1px solid #e2e2dc;text-align:center;">
    <p style="${css.small}">citemaps.org — the canonical index of citemap.json files on the open web.</p>
  </div>`;
}

/** Send the magic-link verify email for a pending registry
 *  claim. Click confirms ownership + finalizes the claim. */
export async function sendClaimVerify({
  email,
  verifyUrl,
  domain,
  entityName,
  displayName,
  expiresAt,
}: {
  email: string;
  /** Full URL: https://api.citemaps.org/registry/claim/verify/{clm_*}.
   *  Constructed in route.ts:buildVerifyUrl from the inbound
   *  request's host header so it matches the deployment URL
   *  (api.citemaps.org in prod, localhost in dev). */
  verifyUrl: string;
  /** Domain being claimed — shown for at-a-glance recognition. */
  domain: string;
  /** Display name from the parsed citemap (e.g. "Western Filament"). */
  entityName?: string;
  /** Optional display name the publisher set during the claim form. */
  displayName?: string;
  /** ISO timestamp the magic link expires. */
  expiresAt: string;
}) {
  const resend = getResend();
  if (!resend) return;

  const expiry = new Date(expiresAt).toLocaleString("en-US", {
    year: "numeric", month: "long", day: "numeric",
    hour: "numeric", minute: "2-digit", timeZoneName: "short",
    timeZone: "America/Los_Angeles",
  });

  const subject = `Confirm your citemaps.org claim for ${domain}`;
  const subjectName = entityName ? `${entityName} (${domain})` : domain;

  try {
    await resend.emails.send({
      from: FROM, to: email,
      subject,
      html: `
        <div style="${css.wrap}">
          <div style="${css.header}">${logo}</div>
          <div style="${css.body}">
            <h1 style="${css.h1}">Confirm your registry claim</h1>
            <hr style="${css.rule}">
            <p style="${css.p}">Someone (presumably you) is claiming the citemap entry for <strong>${subjectName}</strong> on citemaps.org.</p>
            <p style="${css.p}">If that's you, click below to confirm. The link is single-use and expires in 24 hours.</p>
            <a href="${verifyUrl}" style="${css.btn}">Confirm claim →</a>
            <div style="${css.databox};padding:0;margin-top:24px;">
              <div style="${css.row};padding:12px 20px;"><span style="${css.lbl}">Domain</span><span style="${css.val}">${domain}</span></div>
              ${entityName ? `<div style="${css.row};padding:12px 20px;"><span style="${css.lbl}">Entity</span><span style="${css.val}">${entityName}</span></div>` : ""}
              ${displayName ? `<div style="${css.row};padding:12px 20px;"><span style="${css.lbl}">Display name</span><span style="${css.val}">${displayName}</span></div>` : ""}
              <div style="${css.row};padding:12px 20px;border-bottom:none;"><span style="${css.lbl}">Expires</span><span style="${css.val}">${expiry}</span></div>
            </div>
            <p style="${css.small};margin-top:24px;">If you didn't initiate this claim, ignore this email — without confirmation the claim will simply expire. The token in your citemap stays unchanged either way.</p>
          </div>
          ${footer()}
        </div>`,
    });
    console.log(`[email] Claim verify → ${email} (domain: ${domain})`);
  } catch (e) { console.error("[email] Claim verify failed:", e); }
}
