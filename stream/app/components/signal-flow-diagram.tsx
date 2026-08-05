import { useState } from "react";
import type { Layout, LayoutEdge, LayoutNode, Point } from "~/lib/av/layout";

/**
 * Picture of the signal flow, laid out from the document on every render.
 *
 * Read-only for now — editing happens in the tables. It is drawn jack to jack
 * rather than box to box so that it can become the wiring surface later: every
 * jack and every cable carries the document id it came from, which is the hook
 * a drag would need.
 */

/** Solid = cable, dotted = inside a computer, dashed = through the room. */
const EDGE_DASH: Record<string, string | undefined> = {
  cable: undefined,
  internal: "2 3",
  host: "1 3",
  space: "6 4",
};

const CORNER = 7;

export function SignalFlowDiagram({ layout }: { layout: Layout }) {
  const [focus, setFocus] = useState<string | null>(null);

  if (layout.nodes.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">機材を追加すると信号フロー図が表示されます。</p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <svg
        role="img"
        aria-label="信号フロー図"
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        width={layout.width}
        height={layout.height}
        className="max-w-none text-foreground"
      >
        <title>信号フロー図</title>
        <defs>
          <marker
            id="flow-arrow"
            viewBox="0 0 8 8"
            refX="7"
            refY="4"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M0,0 L8,4 L0,8 z" className="fill-muted-foreground" />
          </marker>
        </defs>

        {layout.edges.map((edge) => (
          <Cable key={edge.id} edge={edge} dimmed={isDimmed(edge, focus)} />
        ))}

        {layout.nodes.map((node) => (
          <Box
            key={node.key}
            node={node}
            onFocus={() => setFocus(node.key)}
            onBlur={() => setFocus(null)}
          />
        ))}
      </svg>
    </div>
  );
}

function isDimmed(edge: LayoutEdge, focus: string | null): boolean {
  return focus !== null && edge.from !== focus && edge.to !== focus;
}

function Cable({ edge, dimmed }: { edge: LayoutEdge; dimmed: boolean }) {
  const d = roundedPath(edge.points);
  const width = edge.kind === "space" ? 1.5 : 1.2;
  return (
    <g data-edge-id={edge.id} data-link-id={edge.linkId ?? undefined} opacity={dimmed ? 0.15 : 1}>
      {/* Laid under the cable so a crossing still reads as a crossing. */}
      <path d={d} fill="none" strokeWidth={width + 3.5} className="stroke-background" />
      <path
        d={d}
        fill="none"
        strokeWidth={width}
        strokeDasharray={EDGE_DASH[edge.kind]}
        strokeLinejoin="round"
        strokeLinecap="round"
        markerEnd="url(#flow-arrow)"
        className={edge.back ? "stroke-destructive/70" : "stroke-muted-foreground"}
      />
    </g>
  );
}

function Box({
  node,
  onFocus,
  onBlur,
}: {
  node: LayoutNode;
  onFocus: () => void;
  onBlur: () => void;
}) {
  const isSpace = node.spaceKind !== null;
  return (
    <g
      data-node-key={node.key}
      onMouseEnter={onFocus}
      onMouseLeave={onBlur}
      onFocus={onFocus}
      onBlur={onBlur}
    >
      <rect
        x={node.x}
        y={node.y}
        width={node.width}
        height={node.height}
        rx={8}
        className={isSpace ? "fill-muted stroke-muted-foreground/60" : "fill-card stroke-border"}
        strokeDasharray={isSpace ? "5 4" : undefined}
      />
      <text x={node.x + 10} y={node.y + 17} className="fill-foreground text-[11px] font-medium">
        {truncate(node.label, 22)}
      </text>
      <text x={node.x + 10} y={node.y + 30} className="fill-muted-foreground text-[9px]">
        {isSpace
          ? node.spaceKind === "acoustic"
            ? "音響空間"
            : "視覚空間"
          : (node.category ?? "")}
      </text>

      {node.ports.map((port) => (
        <g key={port.key} data-port-key={port.key}>
          <circle cx={port.x} cy={port.y} r={3} className="fill-background stroke-border" />
          <text
            x={port.side === "left" ? port.x + 8 : port.x - 8}
            y={port.y + 3}
            textAnchor={port.side === "left" ? "start" : "end"}
            className="fill-muted-foreground text-[8px]"
          >
            {truncate(port.label, 11)}
          </text>
        </g>
      ))}
    </g>
  );
}

/** Polyline with its corners cut, so a route reads as one cable and not as steps. */
function roundedPath(points: readonly Point[]): string {
  const first = points[0];
  if (!first) return "";
  if (points.length < 3) {
    const last = points[points.length - 1] ?? first;
    return `M${first.x},${first.y} L${last.x},${last.y}`;
  }

  let d = `M${first.x},${first.y}`;
  for (let i = 1; i < points.length - 1; i++) {
    const previous = points[i - 1];
    const corner = points[i];
    const next = points[i + 1];
    if (!previous || !corner || !next) continue;
    const into = shorten(corner, previous);
    const away = shorten(corner, next);
    d += ` L${into.x},${into.y} Q${corner.x},${corner.y} ${away.x},${away.y}`;
  }
  const last = points[points.length - 1];
  if (last) d += ` L${last.x},${last.y}`;
  return d;
}

function shorten(from: Point, toward: Point): Point {
  const dx = toward.x - from.x;
  const dy = toward.y - from.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) return { x: from.x, y: from.y };
  const ratio = Math.min(CORNER, length / 2) / length;
  return { x: from.x + dx * ratio, y: from.y + dy * ratio };
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
