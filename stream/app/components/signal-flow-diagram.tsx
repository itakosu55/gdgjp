import type { RefObject } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { SPACE_KIND_SHORT_LABELS, SPACE_MEDIUM_LABELS } from "~/lib/av/labels";
import type {
  Layout,
  LayoutBand,
  LayoutEdge,
  LayoutFrame,
  LayoutNode,
  LayoutPort,
  Point,
} from "~/lib/av/layout";
import type { PortDirection } from "~/lib/av/types";
import { cn } from "~/lib/utils";

/**
 * Picture of the signal flow, laid out from the document on every render.
 *
 * It is drawn jack to jack rather than box to box because a cable ends at a
 * jack: anchors come from the model's port order and never from which links
 * happen to exist, so drawing a new cable cannot move an anchor already on
 * screen. That was the precondition for `onWire` below, and it is why the
 * picture is now the wiring surface rather than a report of one.
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
 *
 * It stays geometric: it knows where every jack is and nothing about what may
 * be plugged into what. `canWire` and `onWire` come from the route, which is
 * the only place that knows a cable runs output → input while an app and the
 * computer under it are wired face to face.
 */

/** One end of a drag: which jack, on which box. */
export type PortEnd = {
  /** The box's key — for a device box, the document node id. */
  nodeId: string;
  portKey: string;
  direction: PortDirection;
};

type Anchor = PortEnd & Point;

/** How near a jack a drop has to land, in diagram units. Port pitch is 16. */
const HIT_RADIUS = 18;

/** Solid = cable, dotted = inside a computer, dashed = through the room. */
const EDGE_DASH: Record<string, string | undefined> = {
  cable: undefined,
  internal: "2 3",
  host: "1 3",
  space: "6 4",
};

const CORNER = 7;

/** The caption strip of a place frame — the only part of it that is clickable. */
const FRAME_GRIP = 22;

const BAND_LABEL: Record<string, string> = {
  input: "入力",
  hub: "中間",
  output: "出力",
  space: "空間",
};

export function SignalFlowDiagram({
  layout,
  alerts,
  highlight = null,
  scale = 1,
  selected,
  onSelect,
  canWire,
  onWire,
}: Readonly<{
  layout: Layout;
  alerts?: ReadonlySet<string>;
  /**
   * Graph edge ids to keep lit while everything else fades. Hovering a finding
   * in the dock passes that one loop, which is how a picture holding several
   * reported cycles can still show which one the row is talking about — the
   * danger colour alone cannot, because every reported cycle wears it.
   */
  highlight?: ReadonlySet<string> | null;
  /** Zoom. The picture scales; it never moves — the document has no coordinates. */
  scale?: number;
  /**
   * Box and frame keys drawn as selected. A set rather than one key because a
   * room is two things at once here — the dashed box for the air in it, and the
   * frame around everything standing in it — and selecting the room means both.
   */
  selected?: ReadonlySet<string>;
  /** Called with a `LayoutNode.key` or a `LayoutFrame.key`. */
  onSelect?: (key: string) => void;
  /** Whether a drag from one jack to another is a link the document can hold. */
  canWire?: (from: PortEnd, to: PortEnd) => boolean;
  onWire?: (from: PortEnd, to: PortEnd) => void;
}>) {
  const [focus, setFocus] = useState<string | null>(null);
  const alerted = layout.edges.filter((edge) => isAlerted(edge, alerts));
  const quiet = layout.edges.filter((edge) => !isAlerted(edge, alerts));
  const lit = litNodes(layout, highlight);

  const svg = useRef<SVGSVGElement>(null);
  const anchors = useMemo(
    () =>
      layout.nodes.flatMap((node) =>
        node.ports.map(
          (port): Anchor => ({
            nodeId: node.key,
            portKey: port.key,
            direction: port.direction,
            x: port.x,
            y: port.y,
          }),
        ),
      ),
    [layout],
  );

  const wiring = useWiring({ svg, layout, anchors, canWire, onWire });

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
    <svg
      ref={svg}
      role="img"
      aria-label="信号フロー図"
      viewBox={`0 0 ${layout.width} ${layout.height}`}
      width={Math.round(layout.width * scale)}
      height={Math.round(layout.height * scale)}
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
        <Frame
          key={frame.key}
          frame={frame}
          selected={selected?.has(frame.key) ?? false}
          onSelect={onSelect ? () => onSelect(frame.key) : undefined}
        />
      ))}

      {levels.map((level) => (
        <g key={level}>
          {quiet
            .filter((edge) => reach(edge) === level)
            .map((edge) => (
              <Cable
                key={edge.id}
                edge={edge}
                dimmed={isDimmed(edge, focus) || isFaded(edge, highlight)}
                alerted={false}
              />
            ))}
          {layout.nodes
            .filter((node) => node.depth === level)
            .map((node) => (
              <Box
                key={node.key}
                node={node}
                faded={lit !== null && !lit.has(node.key)}
                selected={selected?.has(node.key) ?? false}
                active={focus === node.key}
                onSelect={onSelect ? () => onSelect(node.key) : undefined}
                onFocus={() => setFocus(node.key)}
                onBlur={() => setFocus(null)}
                wiring={wiring}
              />
            ))}
        </g>
      ))}

      {/* Last, so what the linter reported is never buried under a halo or a box. */}
      {alerted.map((edge) => (
        <Cable
          key={edge.id}
          edge={edge}
          dimmed={isDimmed(edge, focus) || isFaded(edge, highlight)}
          alerted={true}
        />
      ))}

      {wiring.from && wiring.at ? (
        <DraftCable from={wiring.from} to={wiring.target ?? wiring.at} snapped={!!wiring.target} />
      ) : null}
    </svg>
  );
}

/**
 * The cable being dragged. Straight, not routed: routing is what the layout
 * does to a cable that exists, and pretending this one already has a lane
 * would make the picture jump the moment it becomes real.
 */
function DraftCable({ from, to, snapped }: Readonly<{ from: Point; to: Point; snapped: boolean }>) {
  return (
    <g className="pointer-events-none">
      <path
        d={`M${from.x},${from.y} L${to.x},${to.y}`}
        fill="none"
        strokeWidth={1.6}
        strokeDasharray="4 3"
        strokeLinecap="round"
        className={snapped ? "stroke-primary" : "stroke-muted-foreground"}
      />
      {snapped ? <circle cx={to.x} cy={to.y} r={5} className="fill-primary" /> : null}
    </g>
  );
}

/** What the boxes need to know about a drag in progress. */
type Wiring = {
  /** Where the drag started, or `null` when nothing is being dragged. */
  from: Anchor | null;
  /** The pointer, in diagram units. */
  at: Point | null;
  /** The jack the drop would land on. */
  target: Anchor | null;
  /** Whether this jack would accept the drag currently in progress. */
  accepts: (anchor: Anchor) => boolean;
  start: (anchor: Anchor, event: { clientX: number; clientY: number }) => void;
  enabled: boolean;
};

/**
 * Dragging one jack onto another.
 *
 * The pointer is tracked on `window` rather than through `setPointerCapture`,
 * because capture would send every later event to the jack the drag began on —
 * which is exactly the element that must *not* receive them — and because it
 * rewrites where the subsequent `click` lands, so a jack could no longer double
 * as a way to select its device.
 *
 * Hit testing is arithmetic against the port anchors rather than `pointerover`
 * on the targets, so a drop that lands a few pixels short of a 3px circle still
 * connects, and so the target is known during the drag and can be drawn.
 */
function useWiring({
  svg,
  layout,
  anchors,
  canWire,
  onWire,
}: {
  svg: RefObject<SVGSVGElement | null>;
  layout: Layout;
  anchors: Anchor[];
  canWire?: (from: PortEnd, to: PortEnd) => boolean;
  onWire?: (from: PortEnd, to: PortEnd) => void;
}): Wiring {
  const enabled = Boolean(canWire && onWire);
  const [from, setFrom] = useState<Anchor | null>(null);
  const [at, setAt] = useState<Point | null>(null);
  const [target, setTarget] = useState<Anchor | null>(null);
  // The pointerup handler is installed once per drag, so it cannot read the
  // target out of state without reading whatever it was when the drag began.
  const landed = useRef<Anchor | null>(null);

  const toDiagram = (event: { clientX: number; clientY: number }): Point | null => {
    const box = svg.current?.getBoundingClientRect();
    if (!box || box.width === 0 || box.height === 0) return null;
    return {
      x: ((event.clientX - box.left) / box.width) * layout.width,
      y: ((event.clientY - box.top) / box.height) * layout.height,
    };
  };

  // `toDiagram` reads a ref and a prop that cannot change mid-drag.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above.
  useEffect(() => {
    if (!from || !canWire || !onWire) return;

    const move = (event: PointerEvent) => {
      const point = toDiagram(event);
      if (!point) return;
      setAt(point);
      const hit = nearest(anchors, point, (anchor) => canWire(from, anchor));
      landed.current = hit;
      setTarget(hit);
    };
    const finish = () => {
      const hit = landed.current;
      setFrom(null);
      setAt(null);
      setTarget(null);
      landed.current = null;
      if (hit) onWire(from, hit);
    };
    const cancel = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      landed.current = null;
      setFrom(null);
      setAt(null);
      setTarget(null);
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
    window.addEventListener("keydown", cancel);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      window.removeEventListener("keydown", cancel);
    };
  }, [from, anchors, canWire, onWire]);

  return {
    from,
    at,
    target,
    enabled,
    accepts: (anchor) => Boolean(from && canWire?.(from, anchor)),
    start: (anchor, event) => {
      if (!enabled) return;
      setFrom(anchor);
      setAt(toDiagram(event) ?? { x: anchor.x, y: anchor.y });
      setTarget(null);
      landed.current = null;
    },
  };
}

function nearest(
  anchors: readonly Anchor[],
  at: Point,
  accept: (anchor: Anchor) => boolean,
): Anchor | null {
  let best: Anchor | null = null;
  let bestDistance = HIT_RADIUS;
  for (const anchor of anchors) {
    if (!accept(anchor)) continue;
    const distance = Math.hypot(anchor.x - at.x, anchor.y - at.y);
    if (distance <= bestDistance) {
      best = anchor;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * Boxes to keep lit while one loop is highlighted.
 *
 * A machine stays lit when the app inside it is on the loop, and the other way
 * round: the two are one object on screen, and fading half of it reads as a
 * rendering fault rather than as emphasis.
 */
function litNodes(layout: Layout, highlight: ReadonlySet<string> | null): Set<string> | null {
  if (highlight === null) return null;
  const parentOf = new Map(layout.nodes.map((node) => [node.key, node.parentKey]));
  const lit = new Set<string>();
  const add = (key: string) => {
    lit.add(key);
    const parent = parentOf.get(key);
    if (parent) lit.add(parent);
  };
  for (const edge of layout.edges) {
    if (!edge.sourceIds.some((id) => highlight.has(id))) continue;
    add(edge.from);
    add(edge.to);
  }
  return lit;
}

function isFaded(edge: LayoutEdge, highlight: ReadonlySet<string> | null): boolean {
  return highlight !== null && !edge.sourceIds.some((id) => highlight.has(id));
}

/**
 * The border round a place. This is the one shape in the diagram that means
 * "these things are in here", which is why nothing else gets one.
 */
function Frame({
  frame,
  selected,
  onSelect,
}: Readonly<{ frame: LayoutFrame; selected: boolean; onSelect?: () => void }>) {
  return (
    <g data-frame-key={frame.key} data-selected={selected ? "" : undefined}>
      <rect
        x={frame.x}
        y={frame.y}
        width={frame.width}
        height={frame.height}
        rx={12}
        className={cn(
          "fill-muted-foreground/[0.04] stroke-muted-foreground/45",
          selected && "stroke-primary",
        )}
        strokeWidth={selected ? 2 : 1.5}
      />
      {/* Only the caption strip is clickable. The frame spans the whole rig, so
          a hit area over its middle would swallow every click meant for the
          gear standing inside it. */}
      {onSelect ? (
        <rect
          x={frame.x}
          y={frame.y}
          width={frame.width}
          height={FRAME_GRIP}
          className="cursor-pointer fill-transparent"
          role="button"
          tabIndex={0}
          aria-label={`${frame.label} を選択`}
          onClick={onSelect}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              onSelect();
            }
          }}
        />
      ) : null}
      <text
        x={frame.x + 12}
        y={frame.y + 15}
        className="pointer-events-none fill-muted-foreground text-[10px] font-medium"
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
  faded,
  selected,
  active,
  onSelect,
  onFocus,
  onBlur,
  wiring,
}: {
  node: LayoutNode;
  faded: boolean;
  selected: boolean;
  /** Hovered or keyboard-focused, which is also what dims the other cables. */
  active: boolean;
  onSelect?: () => void;
  onFocus: () => void;
  onBlur: () => void;
  wiring: Wiring;
}) {
  const isSpace = node.spaceKind !== null;
  const nested = node.parentKey !== null;
  // Room inside the box for however many characters its width actually holds.
  const room = Math.floor((node.width - 20) / 6.5);
  return (
    <g
      data-node-key={node.key}
      data-parent-key={node.parentKey ?? undefined}
      data-selected={selected ? "" : undefined}
      opacity={faded ? 0.35 : 1}
      role={onSelect ? "button" : undefined}
      tabIndex={onSelect ? 0 : undefined}
      aria-label={onSelect ? selectLabel(node) : undefined}
      aria-pressed={onSelect ? selected : undefined}
      className={onSelect ? "cursor-pointer outline-none" : undefined}
      onClick={onSelect}
      onKeyDown={
        onSelect
          ? (event) => {
              if (event.key !== "Enter" && event.key !== " ") return;
              event.preventDefault();
              onSelect();
            }
          : undefined
      }
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
        className={cn(
          boxFill(isSpace, nested),
          selected && "stroke-primary",
          active && "stroke-ring",
        )}
        strokeWidth={selected ? 2 : active ? 1.5 : undefined}
        strokeDasharray={isSpace ? "5 4" : undefined}
      />
      <text
        x={node.x + 10}
        y={node.y + 17}
        className="pointer-events-none fill-foreground text-[11px] font-medium"
      >
        {truncate(title(node), room)}
      </text>
      <text
        x={node.x + 10}
        y={node.y + 30}
        className="pointer-events-none fill-muted-foreground text-[9px]"
      >
        {truncate(subtitle(node), room + 4)}
      </text>

      {node.ports.map((port) => (
        <Jack key={port.key} node={node} port={port} wiring={wiring} />
      ))}
    </g>
  );
}

/**
 * A jack, and the grab handle for the cable that starts at it.
 *
 * The visible circle stays 3px — the drawing is dense and a bigger dot would
 * read as a component rather than a connector — so the hit area is a separate
 * transparent circle over it. `touch-action: none` sits on that one alone: a
 * drag from a jack must not scroll the pane, and a drag from anywhere else
 * must.
 */
function Jack({
  node,
  port,
  wiring,
}: Readonly<{ node: LayoutNode; port: LayoutPort; wiring: Wiring }>) {
  const anchor: Anchor = {
    nodeId: node.key,
    portKey: port.key,
    direction: port.direction,
    x: port.x,
    y: port.y,
  };
  const dragging = wiring.from !== null;
  const accepts = dragging && wiring.accepts(anchor);
  const isTarget = wiring.target?.nodeId === node.key && wiring.target?.portKey === port.key;
  const isSource = wiring.from?.nodeId === node.key && wiring.from?.portKey === port.key;

  return (
    <g data-port-key={port.key} data-port-direction={port.direction}>
      {/* Every jack that would take the cable currently in the air, lit at once:
          the question during a drag is "where can this go", and answering it
          only under the cursor means hunting for it. */}
      {accepts ? (
        <circle
          cx={port.x}
          cy={port.y}
          r={isTarget ? 8 : 6}
          className="pointer-events-none fill-primary/20 stroke-primary"
        />
      ) : null}
      <circle
        cx={port.x}
        cy={port.y}
        r={3}
        className={cn(
          "fill-background stroke-border",
          isSource && "fill-primary stroke-primary",
          dragging && !accepts && !isSource && "opacity-40",
        )}
      />
      {wiring.enabled ? (
        <circle
          cx={port.x}
          cy={port.y}
          r={9}
          fill="transparent"
          // The grab handle, and the e2e suite's hook for a drag: the group
          // around it is as wide as the port's label, so its centre is not
          // the jack.
          data-port-grip=""
          className="cursor-crosshair touch-none"
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            wiring.start(anchor, event);
          }}
        >
          <title>{port.label}</title>
        </circle>
      ) : null}
      <text
        x={port.side === "left" ? port.x + 8 : port.x - 8}
        y={port.y + 3}
        textAnchor={port.side === "left" ? "start" : "end"}
        className="pointer-events-none fill-muted-foreground text-[8px]"
      >
        {truncate(port.label, 11)}
      </text>
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
 * Both shapes a room wears select the same room, so neither may be called just
 * "メインホール を選択" — two controls with one name is a screen reader reading
 * the picture as if it held two rooms. The frame keeps the plain name because
 * it is the room; the dashed box says which medium it stands for, exactly as
 * `title` does for the eye.
 */
function selectLabel(node: LayoutNode): string {
  if (node.spaceKind !== null && node.frameKey !== null) {
    return `${node.label} の${SPACE_MEDIUM_LABELS[node.spaceKind]}を選択`;
  }
  return `${node.label} を選択`;
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
