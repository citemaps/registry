// Recompute an entry's DNS verification, persist it, and send the claim
// contact a notice when the badge is gained or lost. Called right after
// validate() everywhere an entry is (re)validated, so the token compared
// against DNS is the one live in the citemap.
import { getEntry, updateEntry } from "./kv";
import { checkVerification } from "./dns-verify";
import { sendVerificationNotice } from "./email";
import type { RegistryEntry } from "./types";

export async function refreshVerification(id: string, opts: { notify?: boolean } = {}): Promise<RegistryEntry | null> {
  const entry = await getEntry(id);
  if (!entry) return null;
  const { verification, transition } = await checkVerification(entry);
  let merged = await updateEntry(id, { verification });
  // A pushed entry is listed only on the DNS record's say-so.
  if (merged && merged.contentSource === "pushed" && merged.status === "indexed"
      && verification.state !== "verified" && verification.result !== "dns-error") {
    merged = await updateEntry(id, {
      status: "invalid",
      statusMessage: `Listed from content submitted by the publisher's tool (the site can't be reached by the registry); the ${verification.recordName ?? "_citemap"} DNS record no longer matches, so it's unlisted until the record is back.`,
    });
  }
  if ((opts.notify ?? true) && transition && entry.claimedByEmail && verification.recordName) {
    await sendVerificationNotice({
      email: entry.claimedByEmail,
      domain: entry.domain,
      entityName: entry.parsed?.entityName,
      kind: transition,
      recordName: verification.recordName,
      token: entry.parsed?.registryToken ?? "",
    }).catch(e => console.error("[verify] notice failed:", e));
  }
  return merged;
}
