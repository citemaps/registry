// ============================================================
// Registry entity-graph model — a compact, render-ready graph derived from a
// citemap's @graph, for the per-entry visualization on the registry.
// ADR decisions/registry-entity-graph-viz.md.
//
// The registry already fetches the full citemap to validate it, so we build
// this in the same pass and persist it on ParsedCitemap. The preview viz is
// radial (entity at center, every node on a ring), so we store nodes + per-type
// counts — not explicit edges (each node connects to the center). Capped so a
// 200-product catalog stays a readable constellation + an "+N more" affordance.
// ============================================================

export type RegistryGraphNodeType =
  | "person" | "product" | "brand" | "service" | "location" | "channel" | "other";

export interface RegistryGraphNode {
  id: string;
  label: string;
  type: RegistryGraphNodeType;
}

export interface RegistryGraphModel {
  /** Capped node list for rendering. */
  nodes: RegistryGraphNode[];
  /** Full per-type counts (pre-cap) — drives the card's "N products · M people". */
  counts: Partial<Record<RegistryGraphNodeType, number>>;
  /** Full node count (pre-cap). */
  total: number;
  /** Nodes beyond the cap (total − nodes.length) → "+N more". */
  overflow: number;
}

const NODE_CAP = 48;
const TYPE_PRIORITY: RegistryGraphNodeType[] = [
  "person", "brand", "product", "service", "location", "channel", "other",
];

/** Map a node's @type to a simplified ring type. The Organization (the entity
 *  itself) is the center, not a ring node → null. MediaChannel is multi-typed
 *  ["Organization", "…/MediaChannel"] so it's checked before Organization. */
function classifyType(rawType: unknown): RegistryGraphNodeType | null {
  const types = Array.isArray(rawType) ? rawType : [rawType];
  const names = types
    .filter((t): t is string => typeof t === "string")
    .map((t) => t.split("/").pop() || t);
  const has = (n: string) => names.some((x) => x === n);
  if (names.some((x) => x.includes("MediaChannel"))) return "channel";
  if (has("Person")) return "person";
  if (has("Product") || has("ProductGroup")) return "product";
  if (has("Brand")) return "brand";
  if (has("Service")) return "service";
  if (has("Place")) return "location";
  if (has("Organization")) return null; // the entity itself = center
  return "other";
}

/** Build the compact graph model from a parsed citemap object. Returns
 *  undefined when there are no @graph nodes (renders as just the entity dot). */
export function graphModelFromCitemap(citemap: unknown): RegistryGraphModel | undefined {
  if (!citemap || typeof citemap !== "object") return undefined;
  const obj = citemap as Record<string, unknown>;
  const graph = Array.isArray(obj["@graph"]) ? (obj["@graph"] as unknown[]) : [];

  const nodes: RegistryGraphNode[] = [];
  const counts: Partial<Record<RegistryGraphNodeType, number>> = {};
  for (const raw of graph) {
    if (!raw || typeof raw !== "object") continue;
    const n = raw as Record<string, unknown>;
    const type = classifyType(n["@type"]);
    if (!type) continue;
    counts[type] = (counts[type] ?? 0) + 1;
    nodes.push({
      id: typeof n["@id"] === "string" ? (n["@id"] as string) : `${type}-${nodes.length}`,
      label: typeof n.name === "string" && (n.name as string).trim() ? (n.name as string).trim() : type,
      type,
    });
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
  location: "#BA7517",
  channel: "#D85A30",
  other: "#888780",
  entity: "#2C2C2A",
};
