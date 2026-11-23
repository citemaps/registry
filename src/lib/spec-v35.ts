// ============================================================
// citemap v3.5 helpers for the registry (2026-11-23).
// Same rules as @citemap/validator 0.5.x (spec/v3.5.md):
//  - §3.2 the 16 graduated edge types are the same type as
//    https://citemaps.org/ext/v1/types/{name}; compare by short name.
//  - §9 citemap level computed from the file alone (0 = Level 1 not met).
// ============================================================

export const EXT_PREFIX = "https://citemaps.org/ext/v1/types/";

const GRADUATED = new Set([
  "brand", "manufacturer", "makesOffer", "creator", "about", "recordedIn", "authored", "featuredIn", "mentionedIn",
  "publishedOn", "channelOf", "producedAt", "featuring", "client", "agency", "partner",
]);

/** Short name for a graduated type given in either form; anything else unchanged. */
export function normalizeEdgeType(t: string): string {
  if (t.startsWith(EXT_PREFIX)) {
    const short = t.slice(EXT_PREFIX.length);
    if (GRADUATED.has(short)) return short;
  }
  return t;
}

type Doc = Record<string, unknown>;
const isObj = (v: unknown): v is Doc => !!v && typeof v === "object" && !Array.isArray(v);
const nonEmpty = (v: unknown) => typeof v === "string" && v.trim().length > 0;
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

export type CitemapLevel = 0 | 1 | 2 | 3;

/** v3.5 §9.2. Run on the joined record (content files merged). */
export function computeCitemapLevel(doc: Doc): CitemapLevel {
  const b = isObj(doc.brand) ? doc.brand : {};
  const cc = isObj(doc.citationContract) ? doc.citationContract : {};
  const hasPhone = arr(b.locations).some(l => isObj(l) && nonEmpty(l.phone));
  const l1 = nonEmpty(b.name) && nonEmpty(b.url)
    && (nonEmpty(b.aiSummary) || nonEmpty(cc.shortDescription))
    && (nonEmpty(b.email) || hasPhone || nonEmpty(cc.contactForCorrections))
    && nonEmpty(doc.lastVerified);
  if (!l1) return 0;
  if (!arr(doc.answerContent).length || !(nonEmpty(cc.preferredName) || nonEmpty(cc.shortDescription))) return 1;
  const claim = arr(doc.verifiedClaims).some(c => isObj(c) && nonEmpty(c.type ?? c.claimType) && nonEmpty(c.identifier));
  return claim ? 3 : 2;
}
