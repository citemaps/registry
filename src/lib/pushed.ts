// ============================================================
// Producer-submitted ("pushed") citemaps.
//
// Some hosts' firewalls drop the registry's fetch outright. An
// authenticated producer (Studio, holding REGISTRY_SUBMIT_TOKEN) can
// then send the citemap content with the submission. The registry
// lists it only when the content's registryToken matches the
// `_citemap.{registrable domain}` TXT record — the domain owner
// vouching for that token. The token itself is public, so the push
// must come from an authenticated producer; DNS alone isn't a secret.
// Such entries are labelled "submitted by the publisher's tool", not
// "fetched from the site".
// decisions/registry-verified-badge-domain-anchored.md (pushed content)
// ============================================================
import { validateObject, type ValidationResult } from "./validate";
import { registrableDomainOf, recordNameFor, lookupTxt } from "./dns-verify";

const MAX_PUSH_BYTES = 1_048_576;

export async function evaluatePushedContent(domain: string, content: unknown): Promise<
  { ok: true; result: ValidationResult } | { ok: false; message: string }
> {
  if (!content || typeof content !== "object" || Array.isArray(content)) {
    return { ok: false, message: "The submitted citemap content isn't a JSON object." };
  }
  if (JSON.stringify(content).length > MAX_PUSH_BYTES) {
    return { ok: false, message: "The submitted citemap content is too large." };
  }
  const result = await validateObject(content as Record<string, unknown>, "json");
  if (result.status !== "indexed") {
    return { ok: false, message: `The submitted citemap content isn't valid: ${result.statusMessage ?? "shape error"}` };
  }
  const token = result.parsed?.registryToken;
  if (!token) return { ok: false, message: "The submitted citemap has no registryToken, so the domain can't vouch for it." };

  const { domain: rd, platform } = registrableDomainOf(domain);
  if (!rd || platform) return { ok: false, message: `${domain} has no DNS of its own, so a submitted citemap can't be verified.` };
  const name = recordNameFor(rd);
  const values = await lookupTxt(name);
  if (values === null) return { ok: false, message: "DNS couldn't be checked just now — try again in a minute." };
  if (!values.some(v => v.trim() === token)) {
    return {
      ok: false,
      message: `The site can't be reached, so the registry can list the citemap submitted by your tool only once the domain vouches for it: add a DNS TXT record ${name} with the value ${token}.`,
    };
  }
  return { ok: true, result };
}
