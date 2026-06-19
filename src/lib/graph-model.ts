// ============================================================
// Registry entity-graph model — a compact, render-ready graph derived from a
// citemap, for the per-entry visualization on the registry.
// ADR decisions/registry-entity-graph-viz.md (+ density-grouping addendum).
//
// Built from the INLINE catalog (brand.products / publications / team / …),
// which is richer than @graph for this: it carries the category taxonomy +
// publication content-types that let dense types collapse into category HUBS
// instead of a swarm of dots ("6 product categories" reads better than "34
// products"). Falls back to @graph for citemaps that ship no inline catalog.
// ============================================================

export type RegistryGraphNodeType =
  | "person" | "product" | "brand" | "service" | "location" | "channel" | "publication" | "other";

export interface RegistryGraphNode {
  label: string;
  type: RegistryGraphNodeType;
  /** Present when this node is a category hub representing `count` members. */
  count?: number;
  /** Hub members (capped) — for the detail-page hub-expand. */
  members?: string[];
}

export interface RegistryGraphModel {
  /** Capped render list — individuals (sparse types) or category hubs (dense). */
  nodes: RegistryGraphNode[];
  /** Real per-type item counts (pre-grouping) — drives the card summary. */
  counts: Partial<Record<RegistryGraphNodeType, number>>;
  /** Total items across all types (pre-grouping). */
  total: number;
  /** Items not represented by a rendered node (rare; hubs absorb members). */
  overflow: number;
}

const GROUP_THRESHOLD = 8; // above this, collapse a type into category hubs
const NODE_CAP = 60;
const TYPE_PRIORITY: RegistryGraphNodeType[] = [
  "person", "brand", "product", "service", "publication", "location", "channel", "other",
];

function asArray(x: unknown): Record<string, unknown>[] {
  return Array.isArray(x) ? x.filter((i): i is Record<string, unknown> => !!i && typeof i === "object") : [];
}
function strOf(o: Record<string, unknown>, ...keys: string[]): string {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}
function categoryNameMap(categories: unknown): Map<string, string> {
  const m = new Map<string, string>();
  for (const c of asArray(categories)) {
    if (typeof c.id === "string") m.set(c.id, strOf(c, "name") || c.id);
  }
  return m;
}
/** Primary category for an item: first categoryId → its name, else a type field. */
function primaryCategory(cats: Map<string, string>, fallbackKeys: string[]) {
  return (it: Record<string, unknown>): string => {
    const cids = Array.isArray(it.categoryIds) ? it.categoryIds : [];
    const first = cids.find((c): c is string => typeof c === "string" && c.length > 0);
    if (first) return cats.get(first) ?? first;
    return strOf(it, ...fallbackKeys) || "Uncategorized";
  };
}
const HUB_MEMBER_CAP = 24; // member labels stored per hub (detail-page expand)

function groupHubs(
  type: RegistryGraphNodeType,
  items: Record<string, unknown>[],
  keyFn: (it: Record<string, unknown>) => string,
  labelKeys: string[],
): RegistryGraphNode[] {
  const counts = new Map<string, number>();
  const members = new Map<string, string[]>();
  for (const it of items) {
    const k = keyFn(it) || "Other";
    counts.set(k, (counts.get(k) ?? 0) + 1);
    const m = members.get(k) ?? [];
    if (m.length < HUB_MEMBER_CAP) {
      const lbl = strOf(it, ...labelKeys);
      if (lbl) m.push(lbl);
    }
    members.set(k, m);
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([label, count]) => ({ type, label: `${label} (${count})`, count, members: members.get(label) ?? [] }));
}

export function graphModelFromCitemap(citemap: unknown): RegistryGraphModel | undefined {
  if (!citemap || typeof citemap !== "object") return undefined;
  const obj = citemap as Record<string, unknown>;
  const brand = obj.brand && typeof obj.brand === "object" ? (obj.brand as Record<string, unknown>) : {};

  const nodes: RegistryGraphNode[] = [];
  const counts: Partial<Record<RegistryGraphNodeType, number>> = {};

  const addType = (
    type: RegistryGraphNodeType,
    items: unknown,
    labelKeys: string[],
    groupKeyFn?: (it: Record<string, unknown>) => string,
  ) => {
    const list = asArray(items);
    if (list.length === 0) return;
    counts[type] = list.length;
    if (groupKeyFn && list.length > GROUP_THRESHOLD) {
      nodes.push(...groupHubs(type, list, groupKeyFn, labelKeys));
    } else {
      for (const it of list) nodes.push({ type, label: strOf(it, ...labelKeys) || type });
    }
  };

  const prodCats = categoryNameMap(brand.productCategories);
  const svcCats = categoryNameMap(brand.serviceCategories);

  addType("person", brand.team, ["name"]);
  addType("brand", brand.subBrands, ["name"]);
  addType("location", brand.locations, ["name", "city", "type"]);
  addType("channel", brand.channels, ["name"]);
  addType("product", brand.products, ["name"], primaryCategory(prodCats, ["productType", "category"]));
  addType("service", brand.services, ["name"], primaryCategory(svcCats, ["category"]));
  addType("publication", brand.publications, ["title", "name"], (p) => strOf(p, "contentType") || "other");

  // Fallback: a citemap with @graph nodes but no inline catalog.
  if (nodes.length === 0) return graphModelFromAtGraph(obj);

  nodes.sort((a, b) => TYPE_PRIORITY.indexOf(a.type) - TYPE_PRIORITY.indexOf(b.type));
  const total = Object.values(counts).reduce((s, n) => s + (n ?? 0), 0);
  const capped = nodes.slice(0, NODE_CAP);
  const rendered = capped.reduce((s, n) => s + (n.count ?? 1), 0);
  return { nodes: capped, counts, total, overflow: Math.max(0, total - rendered) };
}

// ── @graph fallback (no inline catalog) ─────────────────────────────
function classifyAtGraphType(rawType: unknown): RegistryGraphNodeType | null {
  const names = (Array.isArray(rawType) ? rawType : [rawType])
    .filter((t): t is string => typeof t === "string")
    .map((t) => t.split("/").pop() || t);
  const has = (n: string) => names.some((x) => x === n);
  if (names.some((x) => x.includes("MediaChannel"))) return "channel";
  if (has("Person")) return "person";
  if (has("Product") || has("ProductGroup")) return "product";
  if (has("Brand")) return "brand";
  if (has("Service")) return "service";
  if (has("Place")) return "location";
  if (has("Organization")) return null;
  return "other";
}
function graphModelFromAtGraph(obj: Record<string, unknown>): RegistryGraphModel | undefined {
  const graph = Array.isArray(obj["@graph"]) ? (obj["@graph"] as unknown[]) : [];
  const nodes: RegistryGraphNode[] = [];
  const counts: Partial<Record<RegistryGraphNodeType, number>> = {};
  for (const raw of graph) {
    if (!raw || typeof raw !== "object") continue;
    const n = raw as Record<string, unknown>;
    const type = classifyAtGraphType(n["@type"]);
    if (!type) continue;
    counts[type] = (counts[type] ?? 0) + 1;
    nodes.push({ type, label: strOf(n, "name") || type });
  }
  if (nodes.length === 0) return undefined;
  nodes.sort((a, b) => TYPE_PRIORITY.indexOf(a.type) - TYPE_PRIORITY.indexOf(b.type));
  const total = nodes.length;
  const capped = nodes.slice(0, NODE_CAP);
  return { nodes: capped, counts, total, overflow: Math.max(0, total - capped.length) };
}

/** Canonical type → color (mid-ramp hex, works in light + dark). Shared by the
 *  renderer + the legend so they never drift. */
export const REGISTRY_GRAPH_COLORS: Record<RegistryGraphNodeType | "entity", string> = {
  person: "#378ADD",
  product: "#1D9E75",
  brand: "#7F77DD",
  service: "#D4537E",
  publication: "#BA7517",
  location: "#639922",
  channel: "#D85A30",
  other: "#888780",
  entity: "#2C2C2A",
};
