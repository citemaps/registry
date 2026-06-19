"use client";

// Interactive detail-page entity graph (Slice 3). A larger version of the
// card's RegistryGraph, rendered as a client island over the SAME compact model
// + colors. Adds: hover tooltips (full untruncated node name; for a category
// hub, its category + member count), and click-to-expand hubs (reveal the
// members the density grouping collapsed). The directory cards stay static +
// server-rendered; only this detail view is interactive.
// ADR decisions/registry-entity-graph-viz.md (Slice 3).
import { useState } from "react";
import {
  REGISTRY_GRAPH_COLORS,
  type RegistryGraphModel,
  type RegistryGraphNode,
  type RegistryGraphNodeType,
} from "@/lib/graph-model";

const GOLDEN = 2.399963;
const SIZE = 420;

const TYPE_LABEL: Record<RegistryGraphNodeType, string> = {
  person: "person",
  product: "product",
  brand: "brand",
  service: "service",
  publication: "publication",
  location: "location",
  channel: "channel",
  other: "node",
};

interface Placed {
  node: RegistryGraphNode;
  i: number;
  x: number;
  y: number;
  r: number;
  color: string;
  isHub: boolean;
}

export function RegistryGraphDetail({ model }: { model?: RegistryGraphModel }) {
  const [hover, setHover] = useState<number | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);

  const nodes = model?.nodes ?? [];
  if (nodes.length === 0) return null;

  const cx = SIZE / 2;
  const cy = SIZE / 2;
  const maxR = SIZE / 2 - 40;
  const N = nodes.length;
  const baseR = N > 36 ? 4 : N > 18 ? 5 : 6.5;

  const placed: Placed[] = nodes.map((node, i) => {
    const rr = maxR * Math.sqrt((i + 1) / (N + 0.6));
    const ang = i * GOLDEN;
    const isHub = !!node.count && node.count > 1;
    const dotR = isHub ? Number((baseR + Math.min(5, Math.log2(node.count!))).toFixed(1)) : baseR;
    return {
      node,
      i,
      x: Number((cx + rr * Math.cos(ang)).toFixed(1)),
      y: Number((cy + rr * Math.sin(ang)).toFixed(1)),
      r: dotR,
      color: REGISTRY_GRAPH_COLORS[node.type] ?? REGISTRY_GRAPH_COLORS.other,
      isHub,
    };
  });

  const rings = [0.36, 0.68, 1.0].map((f) => maxR * f);
  const active = hover ?? expanded;
  const hub = expanded !== null ? placed[expanded] : null;

  return (
    <section
      style={{
        border: "1px solid var(--c-border)",
        borderRadius: 10,
        background: "var(--c-bg)",
        padding: 24,
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 16, marginBottom: 8 }}>
        <h2 style={{ fontSize: 13, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--c-text-muted)", margin: 0 }}>
          Entity graph
        </h2>
        <span style={{ fontSize: 12, color: "var(--c-text-muted)" }}>
          {model!.total} connected node{model!.total === 1 ? "" : "s"}
          {model!.overflow > 0 ? ` · +${model!.overflow} more` : ""}
        </span>
      </div>
      <p style={{ fontSize: 12.5, color: "var(--c-text-muted)", margin: "0 0 14px" }}>
        Hover a node for its name. Click a category hub to reveal what it groups.
      </p>

      <div style={{ position: "relative", width: SIZE, maxWidth: "100%", margin: "0 auto" }}>
        <svg
          width={SIZE}
          height={SIZE}
          viewBox={`0 0 ${SIZE} ${SIZE}`}
          style={{ width: "100%", height: "auto", display: "block" }}
          role="img"
          aria-label={`Entity graph — ${model!.total} connected nodes`}
        >
          {rings.map((r, i) => (
            <circle key={i} cx={cx} cy={cy} r={r} fill="none" stroke="var(--c-border)" strokeWidth={0.5} strokeDasharray="2 3" />
          ))}
          {placed.map((p) => {
            const isActive = active === p.i;
            const dim = active !== null && !isActive;
            return (
              <g
                key={`${p.node.label}-${p.i}`}
                onMouseEnter={() => setHover(p.i)}
                onMouseLeave={() => setHover((h) => (h === p.i ? null : h))}
                onClick={() => p.isHub && setExpanded((e) => (e === p.i ? null : p.i))}
                style={{ cursor: p.isHub ? "pointer" : "default" }}
              >
                <line x1={cx} y1={cy} x2={p.x} y2={p.y} stroke={p.color} strokeWidth={isActive ? 1.4 : 0.5} opacity={dim ? 0.12 : isActive ? 0.75 : 0.32} />
                <circle
                  cx={p.x}
                  cy={p.y}
                  r={isActive ? p.r + 1.5 : p.r}
                  fill={p.color}
                  opacity={dim ? 0.35 : 1}
                  stroke={isActive ? "var(--c-bg)" : "none"}
                  strokeWidth={isActive ? 1.5 : 0}
                />
                {p.isHub && p.node.count! >= 5 && !dim && (
                  <text x={p.x} y={p.y + 3} textAnchor="middle" fontSize={8.5} fontWeight={600} fill="var(--c-bg)" style={{ pointerEvents: "none" }}>
                    {p.node.count}
                  </text>
                )}
              </g>
            );
          })}
          <circle cx={cx} cy={cy} r={8} fill="var(--c-text)" />
          <circle cx={cx} cy={cy} r={12} fill="none" stroke="var(--c-text)" strokeWidth={0.8} opacity={0.4} />
        </svg>

        {hover !== null && <Tooltip p={placed[hover]} />}
      </div>

      {hub && <HubPanel p={hub} onClose={() => setExpanded(null)} />}
    </section>
  );
}

function Tooltip({ p }: { p: Placed }) {
  // Position relative to the (SIZE-wide) graph box. Coords are SVG px == box px.
  const pct = (v: number) => `${(v / SIZE) * 100}%`;
  const below = p.y < 64;
  const cleanLabel = p.isHub ? p.node.label.replace(/\s*\(\d+\)\s*$/, "") : p.node.label;
  return (
    <div
      style={{
        position: "absolute",
        left: pct(p.x),
        top: pct(p.y),
        transform: `translate(-50%, ${below ? "14px" : "calc(-100% - 14px)"})`,
        pointerEvents: "none",
        background: "var(--c-text)",
        color: "var(--c-bg)",
        padding: "6px 10px",
        borderRadius: 6,
        fontSize: 12,
        lineHeight: 1.35,
        maxWidth: 220,
        whiteSpace: "normal",
        textAlign: "center",
        boxShadow: "0 4px 16px rgba(0,0,0,0.18)",
        zIndex: 5,
      }}
    >
      <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontWeight: 600 }}>
        <span style={{ width: 8, height: 8, borderRadius: "50%", background: p.color, display: "inline-block", flexShrink: 0 }} aria-hidden />
        {cleanLabel}
      </span>
      <div style={{ fontSize: 10.5, opacity: 0.75, marginTop: 2, fontFamily: "var(--font-geist-mono)" }}>
        {p.isHub
          ? `${TYPE_LABEL[p.node.type]} category · ${p.node.count} item${p.node.count === 1 ? "" : "s"} · click to expand`
          : TYPE_LABEL[p.node.type]}
      </div>
    </div>
  );
}

function HubPanel({ p, onClose }: { p: Placed; onClose: () => void }) {
  const members = p.node.members ?? [];
  const remaining = (p.node.count ?? members.length) - members.length;
  const cleanLabel = p.node.label.replace(/\s*\(\d+\)\s*$/, "");
  return (
    <div
      style={{
        marginTop: 18,
        paddingTop: 16,
        borderTop: "1px solid var(--c-border)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 10 }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 7, fontSize: 13, fontWeight: 600 }}>
          <span style={{ width: 10, height: 10, borderRadius: "50%", background: p.color, display: "inline-block" }} aria-hidden />
          {cleanLabel}
          <span style={{ color: "var(--c-text-muted)", fontWeight: 400 }}>· {p.node.count} {TYPE_LABEL[p.node.type]}{p.node.count === 1 ? "" : "s"}</span>
        </span>
        <button
          onClick={onClose}
          style={{ border: "none", background: "none", color: "var(--c-text-muted)", fontSize: 12, cursor: "pointer", padding: 0 }}
        >
          close ✕
        </button>
      </div>
      {members.length > 0 ? (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {members.map((m, i) => (
            <span
              key={`${m}-${i}`}
              style={{
                fontSize: 12,
                fontFamily: "var(--font-geist-mono)",
                background: "var(--c-bg-subtle)",
                padding: "4px 10px",
                borderRadius: 4,
                color: "var(--c-text)",
              }}
            >
              {m}
            </span>
          ))}
          {remaining > 0 && (
            <span style={{ fontSize: 12, color: "var(--c-text-muted)", padding: "4px 6px" }}>
              +{remaining} more
            </span>
          )}
        </div>
      ) : (
        <p style={{ fontSize: 12.5, color: "var(--c-text-muted)", margin: 0 }}>
          {p.node.count} item{p.node.count === 1 ? "" : "s"} in this category (names not itemized in the citemap).
        </p>
      )}
    </div>
  );
}
