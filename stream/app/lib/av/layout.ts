import type { BuiltGraph, EdgeKind, GraphEdge, ResolvedNode, VertexId } from "./graph";
import { isPortWired, nodeLabel } from "./graph";
import type { Space } from "./schema";
import type { DeviceCategory, Medium, PortDirection, SpaceKind } from "./types";

/**
 * Lays the graph out for the signal-flow diagram.
 *
 * The setup document deliberately stores no coordinates, so the picture is
 * derived on every render. That is what lets a document written by hand — or
 * later, generated — become a diagram with no extra work.
 *
 * The pipeline is Sugiyama's, in the usual four stages:
 *
 *   1. rank into columns (longest path, after cutting the back edges, constrained
 *      by role so inputs sit left and outputs sit right)
 *   2. insert a dummy per column a long edge crosses, so it never runs over a box
 *   3. order the rows within each column (median heuristic)
 *   4. assign y, pulling each box toward the median of its neighbours
 *
 * On top of that sits **containment**, which the columns cannot express, because
 * where a thing is has nothing to do with what stage of the chain it is:
 *
 * - A computer *contains* the apps that run on it, so the app is drawn inside
 *   the machine's box and never appears in the column stages at all. The machine
 *   is the unit that gets ranked, which is what removed the three special cases
 *   (`pinToHosts`, `hostsFirst`, and a host-pinning pass in `assignRows`) that
 *   used to chase an app around after ranking had scattered it.
 * - A room *contains* whatever is in it, and a room spans the whole chain — mic
 *   at the left, speaker at the right. So a room is a horizontal lane rather
 *   than a box: every one of its members shares one band of rows, across every
 *   column. That is what keeps the frame drawn round a room from swallowing a
 *   box belonging to a different room, which a plain bounding box would.
 *
 * Two properties matter more than tidiness, because of what comes next:
 *
 * - **Ports are first class.** A cable ends at a jack, not at a box, and the
 *   anchor for a jack is derived from the model's port order — never from which
 *   links happen to exist. Drawing a new cable therefore cannot move the
 *   anchors that are already on screen.
 * - **Small edits move the picture a little.** Every stage is deterministic and
 *   `options.order` seeds stage 3 with a previous result, so re-laying out after
 *   one added link does not reshuffle the diagram. Live visualisation is
 *   unreadable without that.
 */

export type LayoutPort = {
  key: string;
  label: string;
  direction: PortDirection;
  /** Inputs sit on the left of the box, outputs on the right. */
  side: PortSide;
  x: number;
  y: number;
};

export type PortSide = "left" | "right";

/**
 * What a device is for, which is what decides its column band.
 *
 * Longest-path ranking alone puts a device wherever the wiring happens to lead,
 * and which edge gets cut to break a loop depends on the order the search
 * visits things — so two identical mics could land in different columns. Role
 * constrains the rank instead: inputs are pinned left, outputs are pushed right
 * of everything that is not one, and the mics land together because they are
 * mics, not because the search reached them the same way.
 */
export type NodeRole = "input" | "hub" | "output";

const CATEGORY_ROLE: Partial<Record<DeviceCategory, NodeRole>> = {
  mic: "input",
  camera: "input",
  wireless_rx: "input",
  speaker: "output",
  display: "output",
  headphone: "output",
  recorder: "output",
  software_broadcast: "output",
};

function roleOf(graph: BuiltGraph, resolved: ResolvedNode): NodeRole {
  if (resolved.model.category === "software_conferencing") return joinRole(graph, resolved);
  return CATEGORY_ROLE[resolved.model.category] ?? "hub";
}

/**
 * A meeting join is whatever its wiring makes it.
 *
 * Fixing it at `input` read the room right for an online speaker — a remote
 * participant is someone talking into the room, and the send back to them
 * belongs in the return lane. But a join used only to send to a satellite room
 * is a sink, and pinning that left drops the entire main signal into the return
 * lane, which makes the diagram lie about where the show is going.
 *
 * A join that runs on a computer is drawn inside it and so has no column of its
 * own; the role then only tints the band. It still decides the column for a
 * join with no host, which is how a remote participant nobody wrote a laptop
 * for stays on the left.
 */
function joinRole(graph: BuiltGraph, resolved: ResolvedNode): NodeRole {
  let wiredIn = false;
  let wiredOut = false;
  for (const port of resolved.model.ports) {
    // `isPortWired` counts only cables and device selections. Space edges sit
    // on both faces of every join in a meeting, so counting those would make
    // every join look like "both" and this would be a fixed role again.
    if (!isPortWired(graph, resolved.id, port)) continue;
    if (port.direction === "out") wiredOut = true;
    else wiredIn = true;
  }
  // Both wired, or nothing wired yet: `input`, which keeps a freshly added join
  // on the left where people look for it.
  return wiredIn && !wiredOut ? "output" : "input";
}

export type LayoutNode = {
  key: string;
  label: string;
  /** `null` for the room itself. */
  category: DeviceCategory | null;
  spaceKind: SpaceKind | null;
  /** `null` for the room, which follows whatever feeds it. */
  role: NodeRole | null;
  /** The box this one is drawn *inside* — the computer an app runs on. */
  parentKey: string | null;
  /** 0 at the top level; 1 for an app on a computer. */
  depth: number;
  /** The place frame this box sits in, or `null` when its location is unknown. */
  frameKey: string | null;
  /** The meeting a join is in, for the chip on its box. */
  meetingLabel: string | null;
  column: number;
  row: number;
  x: number;
  y: number;
  width: number;
  height: number;
  ports: LayoutPort[];
};

/**
 * A place drawn as a frame round everything in it.
 *
 * This is the one thing in the diagram that means containment, which is why it
 * gets a border: `LayoutBand` deliberately does not, because a role is not a
 * container. An acoustic and a visual space sharing a `venueKey` are one room
 * and get one frame — that is what `venueKey` was reserved for.
 */
export type LayoutFrame = {
  key: string;
  label: string;
  /** Every space kind the place covers, in document order. */
  spaceKinds: SpaceKind[];
  x: number;
  y: number;
  width: number;
  height: number;
};

export type Point = { x: number; y: number };

export type LayoutEdge = {
  id: string;
  /** Box keys. `fromPort` / `toPort` name the jack, and are `null` for a room. */
  from: string;
  to: string;
  fromPort: string | null;
  toPort: string | null;
  kind: EdgeKind;
  media: Medium[];
  /** Set for `cable` and `host` edges — the document link this cable is. */
  linkId: string | null;
  /**
   * The graph edges this line stands for. Room coupling collapses several into
   * one, so matching a `Diagnostic.cycle` against `id` alone would miss them.
   */
  sourceIds: string[];
  /** Runs right to left: the edge that closes a loop. Routed under the diagram. */
  back: boolean;
  points: Point[];
};

/**
 * A run of columns that share a role, drawn as a tint behind the boxes.
 *
 * A band rather than a frame around the group: once ranking is role-constrained
 * the position already says what the role is, and a frame would re-state it in
 * a lot of ink, imply a containment that is not there, and collide with the
 * border vocabulary the boxes already use (solid device, dashed room). A tint
 * sits behind the cables instead of fighting them, and stretches to however
 * many columns the middle turns out to need.
 */
export type LayoutBand = {
  role: NodeRole | "space";
  fromColumn: number;
  toColumn: number;
  x: number;
  width: number;
};

export type Layout = {
  nodes: LayoutNode[];
  edges: LayoutEdge[];
  bands: LayoutBand[];
  frames: LayoutFrame[];
  columns: number;
  rows: number;
  width: number;
  height: number;
  /**
   * Row order actually used, as box and dummy keys. Feed it back as
   * `options.order` on the next layout to keep the picture stable across edits.
   */
  order: string[];
};

export type LayoutOptions = {
  /** A previous `Layout.order`, used to seed the row ordering. */
  order?: readonly string[];
};

const SPACE_PREFIX = "space:";
const PLACE_PREFIX = "place:";

const PADDING = 24;
const BOX_WIDTH = 184;
const COL_GAP = 108;
const HEADER_HEIGHT = 38;
const PORT_PITCH = 16;
const BOX_MIN_HEIGHT = 50;
const BOX_PAD_BOTTOM = 10;
const ROW_GAP = 34;
const DUMMY_HEIGHT = 10;
const ELBOW = 14;
/**
 * How far a cable looping around a box stands off from it. Too close and the
 * loop reads as a second, dashed border on the box instead of as a cable.
 */
const ESCAPE = 18;
/** The lanes under the diagram that the loop-closing edges take. */
const RETURN_LANE_GAP = 30;
const RETURN_LANE_PITCH = 14;
const ORDER_SWEEPS = 4;
const ALIGN_PASSES = 4;
/** Room above the boxes for the band captions. */
const BAND_HEADER = 28;
/** Gutter left between two bands, so they read as neighbours and not as one. */
const BAND_GUTTER = 14;
/** How far inside its machine an app is drawn. Also the gutter its cable takes. */
const NEST_PAD = 12;
/** Between two apps on one computer. */
const NEST_GAP = 8;
/** Breathing room between a place frame and the boxes it holds. */
const FRAME_PAD = 14;
/** Room above a place frame's content for its caption. */
const FRAME_HEADER = 20;
/** Between two places, which are stacked as horizontal lanes. */
const PLACE_GAP = 30;
/** The lane for everything whose place is unknown. Sorts last. */
const NO_PLACE = "";

function columnX(column: number): number {
  return PADDING + column * (BOX_WIDTH + COL_GAP);
}

type BoxPort = {
  key: string;
  label: string;
  direction: PortDirection;
  side: PortSide;
  dy: number;
};

type Box = {
  key: string;
  kind: "node" | "space";
  label: string;
  category: DeviceCategory | null;
  role: NodeRole | null;
  /** The box this one is drawn inside — the computer an app runs on. */
  parentKey: string | null;
  children: Box[];
  /** Where the children start, relative to the box top. */
  contentTop: number;
  depth: number;
  /** The place this box is in, which is the lane it is laid out in. */
  placeKey: string | null;
  /** The meeting a join is in. Not a place: a join is inside its computer. */
  meetingLabel: string | null;
  spaceKind: SpaceKind | null;
  ports: BoxPort[];
  width: number;
  height: number;
};

type DrawnEdge = {
  id: string;
  from: string;
  to: string;
  fromPort: string | null;
  toPort: string | null;
  kind: EdgeKind;
  media: Medium[];
  linkId: string | null;
  sourceIds: string[];
};

/** Box key of a vertex: port vertices collapse onto the device that owns them. */
function vertexBox(graph: BuiltGraph, vertexId: VertexId): string | null {
  const vertex = graph.vertices.get(vertexId);
  if (!vertex) return null;
  return vertex.type === "port" ? vertex.nodeId : `${SPACE_PREFIX}${vertex.spaceId}`;
}

function vertexPort(graph: BuiltGraph, vertexId: VertexId): string | null {
  const vertex = graph.vertices.get(vertexId);
  return vertex?.type === "port" ? vertex.portKey : null;
}

export function layoutGraph(graph: BuiltGraph, options: LayoutOptions = {}): Layout {
  const places = collectPlaces(graph);
  const boxes = collectBoxes(graph, places);
  const roots = rootKeys(boxes);
  // Only the top level takes part in the column stages: an app has no column of
  // its own, it is inside the machine that has one.
  const keys = [...boxes.values()].filter((box) => box.parentKey === null).map((box) => box.key);

  const edges = collectEdges(graph, boxes);
  // Ranking and ordering see the machine, not what is inside it. Ids survive the
  // projection, so the dummies these produce are still found by the real edge.
  const structural = projectToRoots(edges, roots);

  const { forward } = splitByDirection(keys, structural, boxes);
  const column = rankByRole(keys, forward, boxes);
  for (const box of boxes.values()) {
    if (box.parentKey === null) continue;
    column.set(box.key, column.get(roots.get(box.key) ?? box.key) ?? 0);
  }

  const { items, segments } = insertDummies(keys, forward, column);
  const lanes = laneOfEach(boxes, items, forward, places);
  const order = orderRows(items, segments, lanes, laneOrder(lanes, places), options.order);
  const y = assignRows(order, boxes, segments, lanes, laneOrder(lanes, places), places);

  return buildLayout(places, boxes, edges, forward, column, order, y);
}

/**
 * The physical places, keyed so that several spaces can be one room.
 *
 * `venueKey` was reserved for exactly this — "these two spaces are the same
 * room" — so a hall's acoustic space and its visual space collapse to one frame
 * instead of drawing the same room twice. A meeting is not a place: it is a path
 * between places, and the joins in it are already inside their computers.
 */
type Place = { key: string; label: string; spaceKinds: SpaceKind[]; rank: number };

function collectPlaces(graph: BuiltGraph): Map<string, Place> {
  const places = new Map<string, Place>();
  for (const space of graph.spaces.values()) {
    const key = placeKeyOf(space);
    if (!key) continue;
    const existing = places.get(key);
    if (existing) {
      if (!existing.spaceKinds.includes(space.kind)) existing.spaceKinds.push(space.kind);
      continue;
    }
    places.set(key, { key, label: space.label, spaceKinds: [space.kind], rank: places.size });
  }
  return places;
}

/**
 * Exported because the editor's tree groups by room too, and the two must agree
 * on which spaces are one room — otherwise the tree splits a hall the picture
 * draws as a single frame.
 */
export function placeKeyOf(space: Space): string | null {
  if (space.kind === "transport") return null;
  return `${PLACE_PREFIX}${space.venueKey ?? space.id}`;
}

function collectBoxes(graph: BuiltGraph, places: Map<string, Place>): Map<string, Box> {
  const boxes = new Map<string, Box>();
  const placeOfSpace = new Map<string, string>();
  const meetingOfSpace = new Map<string, string>();
  for (const space of graph.spaces.values()) {
    const key = placeKeyOf(space);
    if (key && places.has(key)) placeOfSpace.set(space.id, key);
    if (space.kind === "transport") meetingOfSpace.set(space.id, space.label);
  }

  for (const resolved of graph.nodes.values()) {
    const ports: BoxPort[] = [];
    const nextIndex = { in: 0, out: 0 };
    for (const port of resolved.model.ports) {
      const index = nextIndex[port.direction]++;
      ports.push({
        key: port.key,
        label: port.label,
        direction: port.direction,
        side: port.direction === "out" ? "right" : "left",
        dy: HEADER_HEIGHT + index * PORT_PITCH + PORT_PITCH / 2,
      });
    }
    const spaceId = resolved.node.spaceId;
    boxes.set(resolved.id, {
      key: resolved.id,
      kind: "node",
      label: nodeLabel(resolved),
      category: resolved.model.category,
      role: roleOf(graph, resolved),
      parentKey: resolved.node.hostNodeId ?? null,
      children: [],
      contentTop: 0,
      depth: 0,
      placeKey: spaceId ? (placeOfSpace.get(spaceId) ?? null) : null,
      meetingLabel: spaceId ? (meetingOfSpace.get(spaceId) ?? null) : null,
      spaceKind: null,
      ports,
      width: BOX_WIDTH,
      height: boxHeight(nextIndex.in, nextIndex.out),
    });
  }

  for (const space of graph.spaces.values()) {
    const key = `${SPACE_PREFIX}${space.id}`;
    boxes.set(key, {
      key,
      kind: "space",
      label: space.label,
      category: null,
      role: null,
      parentKey: null,
      children: [],
      contentTop: 0,
      depth: 0,
      placeKey: placeOfSpace.get(space.id) ?? null,
      meetingLabel: null,
      spaceKind: space.kind,
      ports: [],
      width: BOX_WIDTH,
      height: BOX_MIN_HEIGHT,
    });
  }

  nestBoxes(boxes);
  return boxes;
}

/**
 * Files each app inside the machine it runs on, and grows the machine to hold
 * it.
 *
 * The child keeps its own ports and its own box; it just lives in its parent's
 * lower half, below the parent's own jacks. A machine's height is therefore
 * known before anything is placed, which is what lets the column stages treat
 * it as one item and never learn that nesting exists.
 */
function nestBoxes(boxes: Map<string, Box>): void {
  for (const box of boxes.values()) {
    if (box.parentKey !== null && !boxes.has(box.parentKey)) box.parentKey = null;
  }
  breakHostCycles(boxes);

  for (const box of boxes.values()) {
    const parent = box.parentKey === null ? undefined : boxes.get(box.parentKey);
    parent?.children.push(box);
  }
  for (const box of boxes.values()) {
    if (box.parentKey === null) sizeNested(box, 0);
  }
}

/** A machine cannot run inside an app that runs inside it. */
function breakHostCycles(boxes: Map<string, Box>): void {
  for (const box of boxes.values()) {
    const seen = new Set<string>([box.key]);
    let key = box.parentKey;
    while (key !== null) {
      if (seen.has(key)) {
        box.parentKey = null;
        break;
      }
      seen.add(key);
      key = boxes.get(key)?.parentKey ?? null;
    }
  }
}

function sizeNested(box: Box, depth: number): void {
  box.depth = depth;
  for (const child of box.children) {
    child.width = box.width - 2 * NEST_PAD;
    sizeNested(child, depth + 1);
  }
  if (box.children.length === 0) return;
  const inner = box.children.reduce(
    (total, child, index) => total + child.height + (index === 0 ? 0 : NEST_GAP),
    0,
  );
  box.contentTop = box.height + NEST_PAD;
  box.height = box.contentTop + inner + NEST_PAD;
}

/** Every box mapped to the top-level box it is drawn inside. */
function rootKeys(boxes: Map<string, Box>): Map<string, string> {
  const roots = new Map<string, string>();
  for (const box of boxes.values()) {
    let current = box;
    while (current.parentKey !== null) {
      const parent = boxes.get(current.parentKey);
      if (!parent) break;
      current = parent;
    }
    roots.set(box.key, current.key);
  }
  return roots;
}

function boxHeight(ins: number, outs: number): number {
  const rows = Math.max(ins, outs);
  return Math.max(BOX_MIN_HEIGHT, HEADER_HEIGHT + rows * PORT_PITCH + BOX_PAD_BOTTOM);
}

/**
 * The edges the picture draws.
 *
 * `internal` edges stay out of it: they live inside one box, and the routing
 * matrix is the honest view of them. Room coupling is not a cable — nobody
 * patches a speaker into the air — so `space` edges collapse to one per box
 * pair and anchor on the box rather than on a jack. Everything else is a real
 * cable, drawn one line per link so it can be clicked.
 */
function collectEdges(graph: BuiltGraph, boxes: Map<string, Box>): DrawnEdge[] {
  const drawn: DrawnEdge[] = [];
  const spaces = new Map<string, DrawnEdge>();

  for (const edge of graph.edges) {
    if (edge.kind === "internal") continue;
    const from = vertexBox(graph, edge.from);
    const to = vertexBox(graph, edge.to);
    if (!from || !to || from === to) continue;
    if (!boxes.has(from) || !boxes.has(to)) continue;

    if (edge.kind === "space") {
      const key = `space:${from}->${to}`;
      const existing = spaces.get(key);
      if (existing) {
        existing.sourceIds.push(edge.id);
        // A meeting carries audio and video down the same collapsed line, so
        // the first edge's media are not the whole story.
        for (const medium of edge.media) {
          if (!existing.media.includes(medium)) existing.media.push(medium);
        }
        continue;
      }
      const collapsed: DrawnEdge = {
        id: key,
        from,
        to,
        fromPort: null,
        toPort: null,
        kind: "space",
        media: edge.media,
        linkId: null,
        sourceIds: [edge.id],
      };
      spaces.set(key, collapsed);
      drawn.push(collapsed);
      continue;
    }

    drawn.push({
      id: edge.id,
      from,
      to,
      fromPort: vertexPort(graph, edge.from),
      toPort: vertexPort(graph, edge.to),
      kind: edge.kind,
      media: edge.media,
      linkId: linkIdOf(edge),
      sourceIds: [edge.id],
    });
  }

  return drawn;
}

function linkIdOf(edge: GraphEdge): string | null {
  return edge.linkId ?? null;
}

/**
 * Re-points every edge at the machine that holds its end.
 *
 * Ranking a nested app on its own put OBS out among the speakers, and the old
 * fix was to rank it and then drag it back to its host. Contracting the machine
 * first says the same thing once: a cable into an app is a cable into the box
 * you can actually plug into. A link between an app and its own host collapses
 * to a self-edge and drops out, which is right — it constrains no ordering.
 */
function projectToRoots(
  edges: readonly DrawnEdge[],
  roots: Map<string, string>,
): readonly DrawnEdge[] {
  const projected: DrawnEdge[] = [];
  for (const edge of edges) {
    const from = roots.get(edge.from) ?? edge.from;
    const to = roots.get(edge.to) ?? edge.to;
    if (from === to) continue;
    projected.push(from === edge.from && to === edge.to ? edge : { ...edge, from, to });
  }
  return projected;
}

/**
 * The lane every laid-out item belongs to, which is its place.
 *
 * A dummy takes the lane of the box its edge left, so a cable crossing between
 * two rooms travels in the room it started in and changes lane at the far end
 * rather than wandering through the rooms in between.
 */
function laneOfEach(
  boxes: Map<string, Box>,
  items: Items,
  forward: readonly DrawnEdge[],
  places: Map<string, Place>,
): Map<string, string> {
  const lanes = new Map<string, string>();
  for (const box of boxes.values()) {
    if (box.parentKey !== null) continue;
    const place = box.placeKey;
    lanes.set(box.key, place !== null && places.has(place) ? place : NO_PLACE);
  }

  const byId = new Map(forward.map((edge) => [edge.id, edge]));
  for (const [key, dummy] of items.dummies) {
    const edge = byId.get(dummy.edgeId);
    lanes.set(key, (edge && lanes.get(edge.from)) ?? NO_PLACE);
  }
  return lanes;
}

/** Places in document order, then everything whose place is unknown. */
function laneOrder(lanes: Map<string, string>, places: Map<string, Place>): string[] {
  const used = new Set(lanes.values());
  const order = [...places.values()]
    .filter((place) => used.has(place.key))
    .sort((a, b) => a.rank - b.rank)
    .map((place) => place.key);
  if (used.has(NO_PLACE)) order.push(NO_PLACE);
  return order;
}

/**
 * Splits the edges into the ones ranking may follow and the ones it may not.
 *
 * Anything arriving at an input is cut before the loop search runs. A mic is
 * where signal starts by definition, so the room feeding it is a return path,
 * not a step forward — and cutting it by rule rather than by whichever edge the
 * search happened to reach first is what keeps two identical mics together.
 */
function splitByDirection(
  keys: readonly string[],
  edges: readonly DrawnEdge[],
  boxes: Map<string, Box>,
): { forward: DrawnEdge[]; back: DrawnEdge[] } {
  const intoInput = new Set(edges.filter((edge) => boxes.get(edge.to)?.role === "input"));
  const candidates = edges.filter((edge) => !intoInput.has(edge));
  const dropped = cutBackEdges(keys, candidates);

  const forward: DrawnEdge[] = [];
  const back: DrawnEdge[] = [];
  for (const edge of edges) {
    if (intoInput.has(edge) || dropped.has(edge)) back.push(edge);
    else forward.push(edge);
  }
  return { forward, back };
}

/**
 * Ranks in two passes, because where the outputs belong depends on how wide
 * everything else turned out.
 *
 * The first pass finds the natural depth of the inputs and the middle. The
 * second pins every output one column past the deepest of those, so speakers,
 * recorders and OBS line up on the right however long the chain feeding them
 * is. Rooms carry no floor of their own — a room sits wherever what feeds it
 * puts it, which is to say just past the speakers.
 */
function rankByRole(
  keys: readonly string[],
  forward: readonly DrawnEdge[],
  boxes: Map<string, Box>,
): Map<string, number> {
  const hasInput = keys.some((key) => boxes.get(key)?.role === "input");
  const floorFor = (key: string, output: number): number | undefined => {
    const role = boxes.get(key)?.role;
    if (role === "input") return 0;
    if (role === "output") return output;
    if (role === "hub") return hasInput ? 1 : 0;
    return undefined;
  };

  const floors = (output: number) =>
    new Map(
      keys.flatMap((key) => {
        const floor = floorFor(key, output);
        return floor === undefined ? [] : [[key, floor] as const];
      }),
    );

  const first = rankNodes(keys, forward, floors(hasInput ? 1 : 0));

  let deepest = 0;
  for (const key of keys) {
    const box = boxes.get(key);
    if (!box || box.kind === "space" || box.role === "output") continue;
    deepest = Math.max(deepest, first.get(key) ?? 0);
  }

  return rankNodes(keys, forward, floors(deepest + 1));
}

/**
 * Longest-path ranking, on the graph with its loops already cut.
 *
 * Cycles are the whole point of this tool, so ranking cannot assume a DAG — but
 * it cannot relax over one either. Every pass around a loop adds another column,
 * so a single howling path drags the diagram thousands of pixels wide.
 */
function rankNodes(
  keys: readonly string[],
  forward: readonly DrawnEdge[],
  floors: Map<string, number>,
): Map<string, number> {
  const incoming = new Map<string, string[]>();
  for (const edge of forward) {
    const list = incoming.get(edge.to);
    if (list) list.push(edge.from);
    else incoming.set(edge.to, [edge.from]);
  }

  const rank = new Map<string, number>(keys.map((key) => [key, floors.get(key) ?? 0]));
  for (let pass = 0; pass < keys.length; pass++) {
    let changed = false;
    for (const key of keys) {
      const sources = incoming.get(key);
      if (!sources || sources.length === 0) continue;
      let best = rank.get(key) ?? 0;
      for (const source of sources) {
        const candidate = (rank.get(source) ?? 0) + 1;
        if (candidate > best) best = candidate;
      }
      if (best !== rank.get(key)) {
        rank.set(key, best);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return rank;
}

/**
 * Iterative depth-first search that drops each edge pointing back at a node
 * still on the stack. Those are exactly the edges that close a loop.
 */
function cutBackEdges(keys: readonly string[], edges: readonly DrawnEdge[]): Set<DrawnEdge> {
  const outgoing = new Map<string, DrawnEdge[]>();
  for (const edge of edges) {
    const list = outgoing.get(edge.from);
    if (list) list.push(edge);
    else outgoing.set(edge.from, [edge]);
  }

  const ON_STACK = 1;
  const DONE = 2;
  const state = new Map<string, number>();
  const dropped = new Set<DrawnEdge>();

  for (const start of keys) {
    if (state.has(start)) continue;
    state.set(start, ON_STACK);
    const stack: { key: string; next: number }[] = [{ key: start, next: 0 }];

    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      if (!frame) break;
      const out = outgoing.get(frame.key) ?? [];
      if (frame.next >= out.length) {
        state.set(frame.key, DONE);
        stack.pop();
        continue;
      }
      const edge = out[frame.next];
      frame.next += 1;
      if (!edge) continue;
      const target = state.get(edge.to);
      if (target === ON_STACK) {
        dropped.add(edge);
        continue;
      }
      if (target === DONE) continue;
      state.set(edge.to, ON_STACK);
      stack.push({ key: edge.to, next: 0 });
    }
  }

  return dropped;
}

type Segment = { from: string; to: string };

type Items = {
  /** Per column, the keys placed there — boxes plus the dummies of long edges. */
  columns: string[][];
  dummies: Map<string, { edgeId: string; column: number }>;
  /** Where each long edge's dummies are, in column order. */
  chains: Map<string, string[]>;
};

/**
 * Splits every edge crossing more than one column into unit-span segments,
 * reserving a row for the crossing in each column it passes through.
 *
 * This is what stops a line from being drawn across a box that has nothing to
 * do with it: the crossing owns a row of its own there.
 */
function insertDummies(
  keys: readonly string[],
  forward: readonly DrawnEdge[],
  column: Map<string, number>,
): { items: Items; segments: Segment[] } {
  const columns: string[][] = [];
  const dummies = new Map<string, { edgeId: string; column: number }>();
  const chains = new Map<string, string[]>();
  const segments: Segment[] = [];

  const put = (col: number, key: string) => {
    while (columns.length <= col) columns.push([]);
    columns[col]?.push(key);
  };

  for (const key of keys) put(column.get(key) ?? 0, key);

  for (const edge of forward) {
    const from = column.get(edge.from) ?? 0;
    const to = column.get(edge.to) ?? 0;
    // An app and its host share a column, so the link between them constrains
    // no ordering — it is drawn inside the column instead.
    if (to === from) continue;
    if (to - from <= 1) {
      segments.push({ from: edge.from, to: edge.to });
      continue;
    }
    const chain: string[] = [];
    let previous = edge.from;
    for (let col = from + 1; col < to; col++) {
      const key = `dummy:${edge.id}:${col}`;
      dummies.set(key, { edgeId: edge.id, column: col });
      put(col, key);
      chain.push(key);
      segments.push({ from: previous, to: key });
      previous = key;
    }
    segments.push({ from: previous, to: edge.to });
    chains.set(edge.id, chain);
  }

  if (columns.length === 0) columns.push([]);
  return { items: { columns, dummies, chains }, segments };
}

/**
 * Median heuristic, swept up and down a fixed number of times.
 *
 * Ties break on the incoming order, and the incoming order can be seeded from a
 * previous layout, so the result is a pure function of the document — an added
 * link nudges the rows instead of reshuffling them.
 */
function orderRows(
  items: Items,
  segments: readonly Segment[],
  lanes: Map<string, string>,
  order: readonly string[],
  seed?: readonly string[],
): string[][] {
  const rank = new Map<string, number>();
  seed?.forEach((key, index) => rank.set(key, index));

  const columns = items.columns.map((column) =>
    [...column].sort(
      (a, b) => (rank.get(a) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b) ?? Number.MAX_SAFE_INTEGER),
    ),
  );

  const predecessors = new Map<string, string[]>();
  const successors = new Map<string, string[]>();
  for (const segment of segments) {
    push(successors, segment.from, segment.to);
    push(predecessors, segment.to, segment.from);
  }

  const position = new Map<string, number>();
  const reindex = () => {
    position.clear();
    for (const column of columns) column.forEach((key, index) => position.set(key, index));
  };
  reindex();

  for (let sweep = 0; sweep < ORDER_SWEEPS; sweep++) {
    const down = sweep % 2 === 0;
    const indexes = columns.map((_, index) => index);
    if (!down) indexes.reverse();
    for (const index of indexes) {
      if (down ? index === 0 : index === columns.length - 1) continue;
      const column = columns[index];
      if (!column) continue;
      const neighbours = down ? predecessors : successors;
      columns[index] = medianSort(column, (key) => neighbours.get(key) ?? [], position);
      reindex();
    }
  }

  const rankOfLane = new Map(order.map((lane, index) => [lane, index]));
  return columns.map((column) => byLane(column, lanes, rankOfLane));
}

/**
 * Sorts each column by place, so the rows already read as lanes before
 * `separateLanes` makes them into ones.
 *
 * Correctness does not need this — separating the lanes is a rigid shift per
 * lane, so it cannot make two boxes collide whatever order they were in. What
 * it buys is that the median heuristic's work survives: without it a column
 * would be reshuffled at the very end and every straightened edge would bend
 * again.
 */
function byLane(
  column: readonly string[],
  lanes: Map<string, string>,
  rankOfLane: Map<string, number>,
): string[] {
  return [...column].sort(
    (a, b) =>
      (rankOfLane.get(lanes.get(a) ?? NO_PLACE) ?? 0) -
      (rankOfLane.get(lanes.get(b) ?? NO_PLACE) ?? 0),
  );
}

function push(map: Map<string, string[]>, key: string, value: string): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function medianSort(
  column: readonly string[],
  neighbours: (key: string) => readonly string[],
  position: Map<string, number>,
): string[] {
  const keyed = column.map((key, index) => {
    const positions = neighbours(key)
      .map((neighbour) => position.get(neighbour) ?? -1)
      .filter((value) => value >= 0)
      .sort((a, b) => a - b);
    return { key, index, median: median(positions, index) };
  });
  keyed.sort((a, b) => a.median - b.median || a.index - b.index);
  return keyed.map((entry) => entry.key);
}

/** An item with no neighbours keeps its place, which is what `fallback` is. */
function median(values: readonly number[], fallback: number): number {
  if (values.length === 0) return fallback;
  const middle = values.length / 2;
  if (values.length % 2 === 1) return values[Math.floor(middle)] ?? fallback;
  const low = values[middle - 1] ?? fallback;
  const high = values[middle] ?? fallback;
  return (low + high) / 2;
}

/**
 * Pulls each item toward the median of what it connects to, then packs the
 * column back apart. Straighter edges are easier to follow than tidy rows.
 */
function assignRows(
  columns: readonly string[][],
  boxes: Map<string, Box>,
  segments: readonly Segment[],
  lanes: Map<string, string>,
  order: readonly string[],
  places: Map<string, Place>,
): Map<string, number> {
  const heightOf = (key: string) => boxes.get(key)?.height ?? DUMMY_HEIGHT;
  const y = new Map<string, number>();

  for (const items of columns) {
    let cursor = 0;
    for (const key of items) {
      y.set(key, cursor);
      cursor += heightOf(key) + ROW_GAP;
    }
  }

  const predecessors = new Map<string, string[]>();
  const successors = new Map<string, string[]>();
  for (const segment of segments) {
    push(successors, segment.from, segment.to);
    push(predecessors, segment.to, segment.from);
  }
  const centre = (key: string) => (y.get(key) ?? 0) + heightOf(key) / 2;

  for (let pass = 0; pass < ALIGN_PASSES; pass++) {
    const down = pass % 2 === 0;
    const indexes = columns.map((_, index) => index);
    if (!down) indexes.reverse();

    for (const index of indexes) {
      if (down ? index === 0 : index === columns.length - 1) continue;
      const items = columns[index];
      if (!items || items.length === 0) continue;
      const neighbours = down ? predecessors : successors;

      const desired = items.map((key) => {
        const related = (neighbours.get(key) ?? []).map(centre).sort((a, b) => a - b);
        return median(related, centre(key)) - heightOf(key) / 2;
      });

      const heights = items.map(heightOf);
      const low = packDown(desired, heights);
      const high = packUp(desired, heights);
      const blended = low.map((value, i) => (value + (high[i] ?? value)) / 2);
      const settled = packDown(blended, heights);
      items.forEach((key, i) => y.set(key, settled[i] ?? 0));
    }
  }

  separateLanes(columns, y, heightOf, lanes, order, places);
  return y;
}

/**
 * Stacks the places into horizontal lanes, and gives every column one origin.
 *
 * Each lane is moved as a rigid body, so nothing inside one can collide with
 * anything else in it — the alignment passes already settled that — and the
 * lanes end up on disjoint bands of rows, so nothing in one room can land
 * between two things in another. That is the property a frame needs: a plain
 * bounding box round a room's members would otherwise swallow a box from the
 * room next door that happened to be laid out between them.
 *
 * With one lane and no frame this is the shared-origin shift the layout has
 * always ended with.
 */
function separateLanes(
  columns: readonly string[][],
  y: Map<string, number>,
  heightOf: (key: string) => number,
  lanes: Map<string, string>,
  order: readonly string[],
  places: Map<string, Place>,
): void {
  const extents = new Map<string, { top: number; bottom: number }>();
  for (const items of columns) {
    for (const key of items) {
      const lane = lanes.get(key) ?? NO_PLACE;
      const top = y.get(key) ?? 0;
      const bottom = top + heightOf(key);
      const extent = extents.get(lane);
      if (!extent) extents.set(lane, { top, bottom });
      else {
        extent.top = Math.min(extent.top, top);
        extent.bottom = Math.max(extent.bottom, bottom);
      }
    }
  }

  const shifts = new Map<string, number>();
  let cursor = PADDING + BAND_HEADER;
  for (const lane of order) {
    const extent = extents.get(lane);
    if (!extent) continue;
    const framed = places.has(lane);
    const head = framed ? FRAME_HEADER + FRAME_PAD : 0;
    shifts.set(lane, cursor + head - extent.top);
    cursor += head + (extent.bottom - extent.top) + (framed ? FRAME_PAD : 0) + PLACE_GAP;
  }

  for (const [key, value] of y) {
    y.set(key, value + (shifts.get(lanes.get(key) ?? NO_PLACE) ?? 0));
  }
}

function packDown(desired: readonly number[], heights: readonly number[]): number[] {
  const result: number[] = [];
  let cursor = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < desired.length; i++) {
    const top = Math.max(desired[i] ?? 0, cursor);
    result.push(top);
    cursor = top + (heights[i] ?? 0) + ROW_GAP;
  }
  return result;
}

function packUp(desired: readonly number[], heights: readonly number[]): number[] {
  const result: number[] = new Array(desired.length).fill(0);
  let cursor = Number.POSITIVE_INFINITY;
  for (let i = desired.length - 1; i >= 0; i--) {
    const top = Math.min(desired[i] ?? 0, cursor - (heights[i] ?? 0));
    result[i] = top;
    cursor = top - ROW_GAP;
  }
  return result;
}

type PlacedBox = Box & { column: number; row: number; x: number; y: number };

function buildLayout(
  places: Map<string, Place>,
  boxes: Map<string, Box>,
  edges: readonly DrawnEdge[],
  forward: readonly DrawnEdge[],
  column: Map<string, number>,
  columns: readonly string[][],
  y: Map<string, number>,
): Layout {
  const placed = new Map<string, PlacedBox>();
  const place = (box: Box, x: number, top: number, col: number, row: number) => {
    placed.set(box.key, { ...box, column: col, row, x, y: top });
    // The children go in the machine's lower half, under its own jacks. Their
    // heights were folded into its height before anything was ranked, so this
    // cannot push anything out of the box it was given.
    let cursor = top + box.contentTop;
    for (const child of box.children) {
      place(child, x + NEST_PAD, cursor, col, row);
      cursor += child.height + NEST_GAP;
    }
  };

  columns.forEach((items, col) => {
    let row = 0;
    for (const key of items) {
      const box = boxes.get(key);
      if (!box) continue;
      place(box, columnX(col), y.get(key) ?? PADDING, col, row++);
    }
  });

  const nodes: LayoutNode[] = [...boxes.keys()].flatMap((key) => {
    const box = placed.get(key);
    if (!box) return [];
    return [
      {
        key: box.key,
        label: box.label,
        category: box.category,
        role: box.role,
        spaceKind: box.spaceKind,
        parentKey: box.parentKey,
        depth: box.depth,
        frameKey: box.placeKey !== null && places.has(box.placeKey) ? box.placeKey : null,
        meetingLabel: box.meetingLabel,
        column: box.column,
        row: box.row,
        x: box.x,
        y: box.y,
        width: box.width,
        height: box.height,
        ports: box.ports.map((port) => ({
          key: port.key,
          label: port.label,
          direction: port.direction,
          side: port.side,
          x: port.side === "right" ? box.x + box.width : box.x,
          y: box.y + port.dy,
        })),
      },
    ];
  });

  let bottom = PADDING;
  for (const node of nodes) bottom = Math.max(bottom, node.y + node.height);

  const laid: LayoutEdge[] = [];
  const forwardIds = new Set(forward.map((edge) => edge.id));
  let lane = 0;

  for (const edge of edges) {
    const from = placed.get(edge.from);
    const to = placed.get(edge.to);
    if (!from || !to) continue;
    const a = anchorOf(from, edge.fromPort, "right");
    const b = anchorOf(to, edge.toPort, "left");
    const inner = nestedInside(from, to, placed)
      ? from
      : nestedInside(to, from, placed)
        ? to
        : null;
    const sameColumn = to.column === from.column;
    const isForward = forwardIds.has(edge.id) && to.column > from.column;
    let points: Point[];
    if (inner) points = routeNested(a, b, inner, from, to);
    else if (sameColumn) points = routeSibling(a, b, from, to);
    else if (isForward) points = routeForward(a, b, from, to, waypoints(edge, columns, column, y));
    else points = routeBack(a, b, bottom + RETURN_LANE_GAP + lane++ * RETURN_LANE_PITCH);
    laid.push({
      id: edge.id,
      from: edge.from,
      to: edge.to,
      fromPort: edge.fromPort,
      toPort: edge.toPort,
      kind: edge.kind,
      media: edge.media,
      linkId: edge.linkId,
      sourceIds: edge.sourceIds,
      back: inner === null && !isForward && !sameColumn,
      points,
    });
  }

  const frames = computeFrames(places, placed);
  const order = columns.flat();
  let width = PADDING;
  let height = bottom + PADDING;
  for (const node of nodes) width = Math.max(width, node.x + node.width);
  for (const frame of frames) {
    width = Math.max(width, frame.x + frame.width);
    height = Math.max(height, frame.y + frame.height + PADDING);
  }
  for (const edge of laid) {
    for (const point of edge.points) height = Math.max(height, point.y + PADDING);
  }
  width += PADDING;
  const columnCount = nodes.reduce((max, node) => Math.max(max, node.column + 1), 0);

  return {
    nodes,
    edges: laid,
    bands: computeBands(nodes, columnCount, width),
    frames,
    columns: columnCount,
    rows: columns.reduce((max, items) => Math.max(max, items.length), 0),
    width,
    height,
    order,
  };
}

/** Is `inner` drawn inside `outer`? */
function nestedInside(inner: PlacedBox, outer: PlacedBox, placed: Map<string, PlacedBox>): boolean {
  let key = inner.parentKey;
  while (key !== null) {
    if (key === outer.key) return true;
    key = placed.get(key)?.parentKey ?? null;
  }
  return false;
}

/**
 * A frame round everything in one place.
 *
 * Only top-level boxes are measured: what is nested is already inside the box
 * that holds it. A place holding nothing but its own air gets no frame — a
 * border round one pill states nothing the pill does not.
 */
function computeFrames(places: Map<string, Place>, placed: Map<string, PlacedBox>): LayoutFrame[] {
  const members = new Map<string, PlacedBox[]>();
  for (const box of placed.values()) {
    if (box.parentKey !== null || box.placeKey === null) continue;
    if (!places.has(box.placeKey)) continue;
    const list = members.get(box.placeKey);
    if (list) list.push(box);
    else members.set(box.placeKey, [box]);
  }

  const frames: LayoutFrame[] = [];
  for (const place of [...places.values()].sort((a, b) => a.rank - b.rank)) {
    const inside = members.get(place.key);
    if (!inside || !inside.some((box) => box.kind === "node")) continue;

    let left = Number.POSITIVE_INFINITY;
    let top = Number.POSITIVE_INFINITY;
    let right = Number.NEGATIVE_INFINITY;
    let bottom = Number.NEGATIVE_INFINITY;
    for (const box of inside) {
      left = Math.min(left, box.x);
      top = Math.min(top, box.y);
      right = Math.max(right, box.x + box.width);
      bottom = Math.max(bottom, box.y + box.height);
    }

    frames.push({
      key: place.key,
      label: place.label,
      spaceKinds: place.spaceKinds,
      x: left - FRAME_PAD,
      y: top - FRAME_PAD - FRAME_HEADER,
      width: right - left + 2 * FRAME_PAD,
      height: bottom - top + 2 * FRAME_PAD + FRAME_HEADER,
    });
  }
  return frames;
}

/**
 * Groups the columns into role bands.
 *
 * A column takes the role of the devices in it; a column holding only rooms is
 * its own band, because a room belongs to no role and lands past the outputs.
 * A column of mixed roles counts as middle — it is the one that has to give.
 */
function computeBands(
  nodes: readonly LayoutNode[],
  columnCount: number,
  width: number,
): LayoutBand[] {
  const roleByColumn: (NodeRole | "space" | null)[] = [];
  for (let col = 0; col < columnCount; col++) {
    const inColumn = nodes.filter((node) => node.column === col);
    const devices = inColumn.filter((node) => node.role !== null);
    if (inColumn.length === 0) roleByColumn.push(null);
    else if (devices.length === 0) roleByColumn.push("space");
    else {
      const roles = new Set(devices.map((node) => node.role as NodeRole));
      roleByColumn.push(roles.size === 1 ? (roles.values().next().value as NodeRole) : "hub");
    }
  }

  const bands: LayoutBand[] = [];
  for (let col = 0; col < roleByColumn.length; col++) {
    const role = roleByColumn[col];
    if (role === null || role === undefined) continue;
    const last = bands[bands.length - 1];
    if (last && last.role === role && last.toColumn === col - 1) last.toColumn = col;
    else bands.push({ role, fromColumn: col, toColumn: col, x: 0, width: 0 });
  }

  const inset = Math.max(0, (COL_GAP - BAND_GUTTER) / 2);
  for (const band of bands) {
    const left = Math.max(PADDING / 2, columnX(band.fromColumn) - inset);
    const right = Math.min(width - PADDING / 2, columnX(band.toColumn) + BOX_WIDTH + inset);
    band.x = left;
    band.width = Math.max(0, right - left);
  }
  return bands;
}

/** Where a long edge crosses the columns in between, in left-to-right order. */
function waypoints(
  edge: DrawnEdge,
  columns: readonly string[][],
  column: Map<string, number>,
  y: Map<string, number>,
): Point[] {
  const from = column.get(edge.from) ?? 0;
  const to = column.get(edge.to) ?? 0;
  const points: Point[] = [];
  for (let col = from + 1; col < to; col++) {
    const key = `dummy:${edge.id}:${col}`;
    if (!columns[col]?.includes(key)) continue;
    points.push({ x: columnX(col), y: (y.get(key) ?? PADDING) + DUMMY_HEIGHT / 2 });
  }
  return points;
}

type Anchor = { x: number; y: number; side: PortSide };

function anchorOf(box: PlacedBox, portKey: string | null, fallback: PortSide): Anchor {
  const port = portKey === null ? undefined : box.ports.find((entry) => entry.key === portKey);
  if (!port) {
    return {
      x: fallback === "right" ? box.x + box.width : box.x,
      y: box.y + box.height / 2,
      side: fallback,
    };
  }
  return {
    x: port.side === "right" ? box.x + box.width : box.x,
    y: box.y + port.dy,
    side: port.side,
  };
}

/**
 * Runs the cable out of the jack, across the gaps between columns, and into the
 * far jack. Diagonals only ever happen in a gap, and a gap holds no boxes.
 *
 * The awkward case is a host link, which runs out→out or in→in: one end sits on
 * the wrong face of its box. Rather than draw the jack on a side it does not
 * belong on, the cable leaves the jack properly and loops around the box.
 */
function routeForward(a: Anchor, b: Anchor, from: PlacedBox, to: PlacedBox, via: Point[]): Point[] {
  const points: Point[] = [{ x: a.x, y: a.y }];

  if (a.side === "right") {
    points.push({ x: a.x + ELBOW, y: a.y });
  } else {
    const lane = escapeLane(a.y, from);
    points.push(
      { x: a.x - ELBOW, y: a.y },
      { x: a.x - ELBOW, y: lane },
      { x: from.x + from.width + ELBOW, y: lane },
    );
  }

  for (const point of via) {
    points.push({ x: point.x, y: point.y }, { x: point.x + BOX_WIDTH, y: point.y });
  }

  if (b.side === "left") {
    points.push({ x: b.x - ELBOW, y: b.y }, { x: b.x, y: b.y });
  } else {
    const lane = escapeLane(b.y, to);
    points.push(
      { x: to.x - ELBOW, y: lane },
      { x: b.x + ELBOW, y: lane },
      { x: b.x + ELBOW, y: b.y },
      { x: b.x, y: b.y },
    );
  }

  return points;
}

function escapeLane(y: number, box: PlacedBox): number {
  return y < box.y + box.height / 2 ? box.y - ESCAPE : box.y + box.height + ESCAPE;
}

/**
 * An app wired to a jack of the machine it is drawn inside.
 *
 * `orientHostAssignment` only ever produces same-face links (out→out when an app
 * plays into a jack, in→in when it captures from one), so the connector runs up
 * the gutter between the app's border and the machine's — the only strip of the
 * machine nothing else is drawn in, including its other apps. Anything else
 * between the two is not a device selection, and falls back to the sibling
 * route.
 */
function routeNested(a: Anchor, b: Anchor, inner: PlacedBox, from: PlacedBox, to: PlacedBox) {
  if (a.side !== b.side) return routeSibling(a, b, from, to);
  const gutter = a.side === "right" ? inner.x + inner.width + NEST_PAD / 2 : inner.x - NEST_PAD / 2;
  return [
    { x: a.x, y: a.y },
    { x: gutter, y: a.y },
    { x: gutter, y: b.y },
    { x: b.x, y: b.y },
  ];
}

/**
 * Two boxes in the same column: an app and the computer it runs on.
 *
 * The connector crosses the gap between them rather than taking the return
 * lane, because nothing here is going backwards — it is one machine. When both
 * jacks are on the same face, which is the usual shape for a host link
 * (out→out or in→in), this collapses to a straight run down that side.
 */
function routeSibling(a: Anchor, b: Anchor, from: PlacedBox, to: PlacedBox): Point[] {
  const above = from.y <= to.y ? from : to;
  const below = above === from ? to : from;
  const midY = (above.y + above.height + below.y) / 2;

  const ax = a.side === "right" ? a.x + ELBOW : a.x - ELBOW;
  const bx = b.side === "right" ? b.x + ELBOW : b.x - ELBOW;
  return [
    { x: a.x, y: a.y },
    { x: ax, y: a.y },
    { x: ax, y: midY },
    { x: bx, y: midY },
    { x: bx, y: b.y },
    { x: b.x, y: b.y },
  ];
}

/**
 * The return path of a loop, routed in its own lane under the diagram. A howl
 * is the normal input here, so the edge that closes it deserves to be the one
 * edge you cannot miss.
 */
function routeBack(a: Anchor, b: Anchor, lane: number): Point[] {
  const ax = a.side === "right" ? a.x + ELBOW : a.x - ELBOW;
  const bx = b.side === "left" ? b.x - ELBOW : b.x + ELBOW;
  return [
    { x: a.x, y: a.y },
    { x: ax, y: a.y },
    { x: ax, y: lane },
    { x: bx, y: lane },
    { x: bx, y: b.y },
    { x: b.x, y: b.y },
  ];
}
