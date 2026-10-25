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
  const merged = await updateEntry(id, { verification });
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
