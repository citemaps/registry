// Per-entry entity-graph viz (radial: entity at center, every @graph node on a
// ring, colored by type). Pure render from the compact model stored on
// ParsedCitemap. ADR decisions/registry-entity-graph-viz.md.
import { REGISTRY_GRAPH_COLORS, type RegistryGraphModel, type RegistryGraphNodeType } from "@/lib/graph-model";

const GOLDEN = 2.399963; // radians — even organic scatter

export function RegistryGraph({ model, size = 140 }: { model?: RegistryGraphModel; size?: number }) {
  const cx = size / 2;
  const cy = size / 2;
  const maxR = size / 2 - 12;
  const nodes = model?.nodes ?? [];
  const N = nodes.length;
  const dotR = N > 24 ? 2.4 : N > 12 ? 3.0 : 3.6;
  const rings = [0.36, 0.68, 1.0].map((f) => maxR * f);

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label={`Entity graph — ${model?.total ?? 0} connected node${(model?.total ?? 0) === 1 ? "" : "s"}`}
    >
      {rings.map((r, i) => (
        <circle key={i} cx={cx} cy={cy} r={r} fill="none" stroke="var(--c-border)" strokeWidth={0.5} strokeDasharray="2 3" />
      ))}
      {nodes.map((nd, i) => {
        const r = maxR * Math.sqrt((i + 1) / (N + 0.6));
        const ang = i * GOLDEN;
        const x = (cx + r * Math.cos(ang)).toFixed(1);
        const y = (cy + r * Math.sin(ang)).toFixed(1);
        const color = REGISTRY_GRAPH_COLORS[nd.type] ?? REGISTRY_GRAPH_COLORS.other;
        return (
          <g key={`${nd.id}-${i}`}>
            <line x1={cx} y1={cy} x2={x} y2={y} stroke={color} strokeWidth={0.5} opacity={0.3} />
            <circle cx={x} cy={y} r={dotR} fill={color} />
          </g>
        );
      })}
      <circle cx={cx} cy={cy} r={6} fill="var(--c-text)" />
      <circle cx={cx} cy={cy} r={9} fill="none" stroke="var(--c-text)" strokeWidth={0.8} opacity={0.4} />
    </svg>
  );
}

const LEGEND_TYPES: RegistryGraphNodeType[] = ["person", "product", "brand", "service", "location", "channel"];

/** Thin node-type legend — pinned at the top of the directory so the card
 *  colors are always decodable. */
export function GraphLegend() {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 14, fontSize: 12, color: "var(--c-text-muted)" }}>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
        <span style={{ width: 11, height: 11, borderRadius: "50%", background: "var(--c-text)", display: "inline-block" }} aria-hidden />
        entity
      </span>
      {LEGEND_TYPES.map((t) => (
        <span key={t} style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
          <span style={{ width: 9, height: 9, borderRadius: "50%", background: REGISTRY_GRAPH_COLORS[t], display: "inline-block" }} aria-hidden />
          {t}
        </span>
      ))}
    </div>
  );
}
