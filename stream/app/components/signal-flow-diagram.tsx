import { useState } from "react";
import { SPACE_KIND_SHORT_LABELS, SPACE_MEDIUM_LABELS } from "~/lib/av/labels";
import type {
  Layout,
  LayoutBand,
  LayoutEdge,
  LayoutFrame,
  LayoutNode,
  Point,
} from "~/lib/av/layout";

/**
 * Picture of the signal flow, laid out from the document on every render.
 *
 * Read-only for now — editing happens in the tables. It is drawn jack to jack
 * rather than box to box so that it can become the wiring surface later: every
 * jack and every cable carries the document id it came from, which is the hook
 * a drag would need.
 *
 * `alerts` holds the graph edge ids the linter reported, and is the *only*
 * thing drawn in the danger colour. The diagram does not decide on its own what
 * looks wrong: a return path under the picture is a routing fact, and plenty of
 * correct wiring produces one — the room feeding a mic, the send back to a
 * remote participant. Colouring those red trains people to ignore red.
 *
 * Three things are stacked behind the cables, and they say different things on
 * purpose: a **band** is a tint with no border and means a role, a **frame** is
 * a border and means a place, and a **box inside a box** means the machine runs
 * the app. Only the last two are containment, so only they get an outline.
 */

/** Solid = cable, dotted = inside a computer, dashed = through the room. */
const EDGE_DASH: Record<string, string | undefined> = {
  cable: undefined,
  internal: "2 3",
  host: "1 3",
  space: "6 4",
};

const CORNER = 7;

const BAND_LABEL: Record<string, string> = {
  input: "入力",
  hub: "中間",
  output: "出力",
  space: "空間",
};

export function SignalFlowDiagram({
  layout,
  alerts,
}: Readonly<{ layout: Layout; alerts?: ReadonlySet<string> }>) {
  const [focus, setFocus] = useState<string | null>(null);
  const alerted = layout.edges.filter((edge) => isAlerted(edge, alerts));
  const quiet = layout.edges.filter((edge) => !isAlerted(edge, alerts));

  // Boxes and cables interleave by depth rather than going down in two slabs.
  // A cable ending on an app has to cross the machine holding it, so painting
  // every cable first let the machine's fill swallow its last centimetre,
  // arrowhead included, and the line looked like it stopped at the machine's
  // edge. Each level therefore goes: the cables that reach that deep, then the
  // boxes at that depth. The layout keeps every other line clear of the boxes,
  // so lifting the deep ones over the machines uncovers nothing else.
  const depthOf = new Map(layout.nodes.map((node) => [node.key, node.depth]));
  const reach = (edge: LayoutEdge) =>
    Math.max(depthOf.get(edge.from) ?? 0, depthOf.get(edge.to) ?? 0);
  const levels = [...new Set(layout.nodes.map((node) => node.depth))].sort((a, b) => a - b);

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
          {/* Two markers rather than `context-stroke`, which browsers disagree about. */}
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
          <marker
            id="flow-arrow-alert"
            viewBox="0 0 8 8"
            refX="7"
            refY="4"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M0,0 L8,4 L0,8 z" className="fill-destructive" />
          </marker>
        </defs>

        {layout.bands.map((band) => (
          <Band key={`${band.role}-${band.fromColumn}`} band={band} height={layout.height} />
        ))}

        {layout.frames.map((frame) => (
          <Frame key={frame.key} frame={frame} />
        ))}

        {levels.map((level) => (
          <g key={level}>
            {quiet
              .filter((edge) => reach(edge) === level)
              .map((edge) => (
                <Cable key={edge.id} edge={edge} dimmed={isDimmed(edge, focus)} alerted={false} />
              ))}
            {layout.nodes
              .filter((node) => node.depth === level)
              .map((node) => (
                <Box
                  key={node.key}
                  node={node}
                  onFocus={() => setFocus(node.key)}
                  onBlur={() => setFocus(null)}
                />
              ))}
          </g>
        ))}

        {/* Last, so what the linter reported is never buried under a halo or a box. */}
        {alerted.map((edge) => (
          <Cable key={edge.id} edge={edge} dimmed={isDimmed(edge, focus)} alerted={true} />
        ))}
      </svg>
    </div>
  );
}

/**
 * The border round a place. This is the one shape in the diagram that means
 * "these things are in here", which is why nothing else gets one.
 */
function Frame({ frame }: Readonly<{ frame: LayoutFrame }>) {
  return (
    <g data-frame-key={frame.key}>
      <rect
        x={frame.x}
        y={frame.y}
        width={frame.width}
        height={frame.height}
        rx={12}
        className="fill-muted-foreground/[0.04] stroke-muted-foreground/45"
        strokeWidth={1.5}
      />
      <text
        x={frame.x + 12}
        y={frame.y + 15}
        className="fill-muted-foreground text-[10px] font-medium"
      >
        {frame.label}
        <tspan className="fill-muted-foreground/60">
          {`　${frame.spaceKinds.map((kind) => SPACE_KIND_SHORT_LABELS[kind]).join("・")}`}
        </tspan>
      </text>
    </g>
  );
}

/** A tint behind the columns, captioned. Deliberately not a frame — see `LayoutBand`. */
function Band({ band, height }: Readonly<{ band: LayoutBand; height: number }>) {
  return (
    <g data-band={band.role}>
      <rect
        x={band.x}
        y={10}
        width={band.width}
        height={Math.max(0, height - 20)}
        rx={10}
        className="fill-muted-foreground/[0.055]"
      />
      <text
        x={band.x + 12}
        y={26}
        className="fill-muted-foreground/70 text-[9px] font-medium tracking-wide"
      >
        {BAND_LABEL[band.role] ?? band.role}
      </text>
    </g>
  );
}

function isDimmed(edge: LayoutEdge, focus: string | null): boolean {
  return focus !== null && edge.from !== focus && edge.to !== focus;
}

function isAlerted(edge: LayoutEdge, alerts: ReadonlySet<string> | undefined): boolean {
  return alerts !== undefined && edge.sourceIds.some((id) => alerts.has(id));
}

function Cable({
  edge,
  dimmed,
  alerted,
}: Readonly<{ edge: LayoutEdge; dimmed: boolean; alerted: boolean }>) {
  const d = roundedPath(edge.points);
  const width = cableWidth(edge, alerted);
  return (
    <g
      data-edge-id={edge.id}
      data-link-id={edge.linkId ?? undefined}
      data-alerted={alerted ? "" : undefined}
      opacity={dimmed ? 0.15 : 1}
    >
      {/* Laid under the cable so a crossing still reads as a crossing. */}
      <path d={d} fill="none" strokeWidth={width + 3.5} className="stroke-background" />
      <path
        d={d}
        fill="none"
        strokeWidth={width}
        strokeDasharray={EDGE_DASH[edge.kind]}
        strokeLinejoin="round"
        strokeLinecap="round"
        markerEnd={alerted ? "url(#flow-arrow-alert)" : "url(#flow-arrow)"}
        className={cableStroke(edge, alerted)}
      />
    </g>
  );
}

function cableWidth(edge: LayoutEdge, alerted: boolean): number {
  if (alerted) return 2;
  return edge.kind === "space" ? 1.5 : 1.2;
}

/** A return path recedes; only what the linter reported is loud. */
function cableStroke(edge: LayoutEdge, alerted: boolean): string {
  if (alerted) return "stroke-destructive";
  return edge.back ? "stroke-muted-foreground/55" : "stroke-muted-foreground";
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
  const nested = node.parentKey !== null;
  // Room inside the box for however many characters its width actually holds.
  const room = Math.floor((node.width - 20) / 6.5);
  return (
    <g
      data-node-key={node.key}
      data-parent-key={node.parentKey ?? undefined}
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
        className={boxFill(isSpace, nested)}
        strokeDasharray={isSpace ? "5 4" : undefined}
      />
      <text x={node.x + 10} y={node.y + 17} className="fill-foreground text-[11px] font-medium">
        {truncate(title(node), room)}
      </text>
      <text x={node.x + 10} y={node.y + 30} className="fill-muted-foreground text-[9px]">
        {truncate(subtitle(node), room + 4)}
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

function boxFill(isSpace: boolean, nested: boolean): string {
  if (isSpace) return "fill-muted stroke-muted-foreground/60";
  // A shade apart from the machine it sits in, or the two borders read as one
  // box with a line through it.
  return nested ? "fill-muted/60 stroke-border" : "fill-card stroke-border";
}

/**
 * A space drawn inside the frame of its own room must not repeat the room's
 * name — the frame already carries it, and two "メインホール" a centimetre apart
 * read as two rooms. What is left to say is which medium the box carries.
 */
function title(node: LayoutNode): string {
  return node.spaceKind !== null && node.frameKey !== null
    ? SPACE_MEDIUM_LABELS[node.spaceKind]
    : node.label;
}

/**
 * A join's meeting beats its category: "登壇 Meet" is what tells two otherwise
 * identical Meet windows apart, and which meeting a join is in is exactly the
 * question §9 added the transport space to answer.
 */
function subtitle(node: LayoutNode): string {
  if (node.spaceKind !== null) return SPACE_KIND_SHORT_LABELS[node.spaceKind];
  return node.meetingLabel ?? node.category ?? "";
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
