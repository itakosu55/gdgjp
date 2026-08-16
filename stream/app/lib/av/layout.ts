import type { BuiltGraph, EdgeKind, GraphEdge, ResolvedNode, VertexId } from "./graph";
import { isPortWired, nodeLabel } from "./graph";
import { inPlaceOrder, placeKeyOf, spaceRank } from "./places";
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
  /**
   * Where this jack's label starts, which is not always just inside the box.
   *
   * A machine's own labels have to clear the gutter its apps' cables run in, or
   * a device selection is drawn through the name of the jack it selects — and
   * the cable wins, because it is painted after the box it crosses.
   */
  labelX: number;
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
  for (const port of resolved.ports.values()) {
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
  /** Every space kind the place covers, air before sight (`inPlaceOrder`). */
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
/**
 * The lanes a loop-closing edge returns in — under its own room when both ends
 * are in one (`returnBands`), and under the whole picture when it is not.
 */
const RETURN_LANE_GAP = 30;
const RETURN_LANE_PITCH = 14;
/**
 * Two lines that would run in one strip are moved apart by this much.
 *
 * A lane of its own under the picture is not enough for a return path: the
 * risers down to it leave the same column as every other return, so drawn at
 * one offset they descend on one line and six cables read as one. The same
 * happens wherever a strip is the only way through — the gutter inside a
 * machine, the gap between two boxes in one column.
 *
 * One pitch for all of them, because the reader is counting lines, and a strip
 * where they run closer together than elsewhere reads as fewer of them. Where a
 * strip is too narrow to hold its lines at this pitch it is the strip that
 * gives: `sizeHosts` widens the machine rather than crowding the cables.
 */
const LINE_PITCH = 8;
/** Nearer a face than this and a line stops reading as one that left it. */
const LINE_FLOOR = 4;
/** Between a jack and its label. */
const LABEL_INSET = 8;
/**
 * How far a line may stand off a face before it is in the next column's way.
 * A face at column 0 has only the page margin, which `roomBeside` reads off the
 * anchor rather than assuming.
 */
const BESIDE_ROOM = COL_GAP - 2 * ELBOW;
const ORDER_SWEEPS = 4;
const ALIGN_PASSES = 4;
/** Room above the boxes for the band captions. */
const BAND_HEADER = 28;
/** Gutter left between two bands, so they read as neighbours and not as one. */
const BAND_GUTTER = 14;
/**
 * The narrowest an app's gutter gets — the strip between its border and its
 * machine's, which every cable of that app runs in. A machine with more cables
 * than this holds gets a wider one (`sizeHosts`); this is the floor, so a
 * machine running one quiet app is drawn exactly as it always was.
 */
const NEST_PAD = 16;
/**
 * Between the outermost line in a gutter and the machine's own border, which
 * carries the machine's own jacks — a cable hugging it reads as plugged into
 * them.
 */
const NEST_CLEAR = 6;
/**
 * The narrowest gap between two apps on one computer. A cable from one to the
 * other can only cross in the gap — it is the one strip between them that holds
 * no box — so a busy pair is given a wider one.
 */
const NEST_GAP = 20;
/** Between a crossing and the box above or below the gap it crosses in. */
const CROSS_CLEAR = 6;
/** Breathing room between a place frame and the boxes it holds. */
const FRAME_PAD = 14;
/**
 * Between a place frame and the outermost line drawn inside it.
 *
 * Less than `FRAME_PAD`, for the same reason `NEST_CLEAR` is less than
 * `NEST_PAD`: a box needs room for its own border and its label, a line needs
 * only not to be touching. A return riser left on the border reads as a cable
 * leaving the room, which is the opposite of what a return that comes home is.
 */
const FRAME_CLEAR = 6;
/** Room above a place frame's content for its caption. */
const FRAME_HEADER = 20;
/** Between two places, which are stacked as horizontal lanes. */
const PLACE_GAP = 30;
/** The lane for everything whose place is unknown. Sorts last. */
const NO_PLACE = "";

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
  /**
   * How far in from each face the children are drawn, which is how wide the
   * gutter their cables run in is. Per face, because a machine whose apps are
   * all captured from one side has no reason to be fat on the other.
   */
  padLeft: number;
  padRight: number;
  /** Between two children, which is the strip a cable between them crosses in. */
  gap: number;
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
  // A room has no jacks to hang its couplings on, so it is sized by how many
  // there are. Nothing before this point reads a box's height.
  sizeSpaces(boxes, edges);
  // Ranking and ordering see the machine, not what is inside it. Ids survive the
  // projection, so the dummies these produce are still found by the real edge.
  const structural = projectToRoots(edges, roots);

  const { forward } = splitByDirection(keys, structural, boxes);
  const column = rankByRole(keys, forward, boxes);
  for (const box of boxes.values()) {
    if (box.parentKey === null) continue;
    column.set(box.key, column.get(roots.get(box.key) ?? box.key) ?? 0);
  }

  // Which column a box is in decides which lines run inside it, and that is
  // what a machine has to be big enough for. Ranking cares about neither.
  const forwardIds = new Set(forward.map((edge) => edge.id));
  sizeHosts(boxes, edges, column, forwardIds);
  // Which returns come home to the room they left, counted before any row is
  // assigned so the room can be given the rows to hold them.
  const bands = returnBands(edges, boxes, places, column, forwardIds);

  const { items, segments } = insertDummies(keys, forward, column);
  const lanes = laneOfEach(boxes, items, forward, places);
  // Two spaces of one room share a lane *and* a column, so nothing else in the
  // pipeline has an opinion about which of them is drawn first.
  const withinLane = new Map(
    [...boxes.values()].flatMap((box) =>
      box.spaceKind === null ? [] : [[box.key, spaceRank(box.spaceKind)] as const],
    ),
  );
  const order = orderRows(
    items,
    segments,
    lanes,
    laneOrder(lanes, places),
    withinLane,
    options.order,
  );
  const y = assignRows(order, boxes, segments, lanes, laneOrder(lanes, places), places, bands);

  return buildLayout(places, boxes, edges, forwardIds, column, order, y, bands);
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
  const grouped = new Map<string, Space[]>();
  for (const space of graph.spaces.values()) {
    const key = placeKeyOf(space);
    if (!key) continue;
    const found = grouped.get(key);
    if (found) found.push(space);
    else grouped.set(key, [space]);
  }

  // Places keep document order — a lane is a room, and the order rooms were
  // written in is the author's. Only the spaces *inside* one are canonical.
  const places = new Map<string, Place>();
  for (const [key, spaces] of grouped) {
    const ordered = inPlaceOrder(spaces);
    places.set(key, {
      key,
      label: ordered[0]?.label ?? key,
      spaceKinds: [...new Set(ordered.map((space) => space.kind))],
      rank: places.size,
    });
  }
  return places;
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
    for (const port of resolved.ports.values()) {
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
      padLeft: NEST_PAD,
      padRight: NEST_PAD,
      gap: NEST_GAP,
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
      padLeft: NEST_PAD,
      padRight: NEST_PAD,
      gap: NEST_GAP,
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
 * Files each app inside the machine it runs on.
 *
 * The child keeps its own ports and its own box; it just lives in its parent's
 * lower half, below the parent's own jacks. Sizing is left to `sizeHosts`,
 * which runs once the cables are known — a machine is as big as what it has to
 * hold, and what it has to hold is its apps *and* their wiring.
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

/**
 * Lays a box's children out inside it, growing the box until they fit.
 *
 * It grows outward rather than squeezing inward: an app is drawn at the width
 * an app is drawn at, and a machine needing a wide gutter gets a wider machine,
 * not a narrower app. Nothing has been placed yet, so the column stages still
 * see one item whose size is already settled.
 */
function sizeNested(box: Box, depth: number): void {
  box.depth = depth;
  for (const child of box.children) {
    child.width = nestedWidth(depth + 1);
    sizeNested(child, depth + 1);
  }
  if (box.children.length === 0) return;
  const widest = box.children.reduce((max, child) => Math.max(max, child.width), 0);
  for (const child of box.children) child.width = widest;

  const inner = box.children.reduce(
    (total, child, index) => total + child.height + (index === 0 ? 0 : box.gap),
    0,
  );
  box.width = Math.max(box.width, widest + box.padLeft + box.padRight);
  box.contentTop = box.height + NEST_PAD;
  box.height = box.contentTop + inner + NEST_PAD;
}

/** How wide a box is drawn at this nesting depth, before its own cables widen it. */
function nestedWidth(depth: number): number {
  return BOX_WIDTH - 2 * NEST_PAD * depth;
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
 * Grows a room until every coupling meets it on a row of its own.
 *
 * A room is not a device and never grows jacks — nobody patches a speaker into
 * the air, and a drag has nothing to land on there. But every cable touching
 * one used to anchor on the middle of its face, so a hall with two speakers and
 * a laptop in it drew three cables into a single point under a single
 * arrowhead: three couplings that the picture said were one. A room holds a row
 * per cable for the same reason a box holds a row per port, and `spaceRows`
 * then hands them out; the rows are counted per face, exactly as ports are
 * counted per direction.
 */
function sizeSpaces(boxes: Map<string, Box>, edges: readonly DrawnEdge[]): void {
  const faces = new Map<string, { left: number; right: number }>();
  const claim = (key: string, side: PortSide) => {
    if (boxes.get(key)?.kind !== "space") return;
    const face = faces.get(key) ?? { left: 0, right: 0 };
    face[side] += 1;
    faces.set(key, face);
  };

  for (const edge of edges) {
    claim(edge.from, "right");
    claim(edge.to, "left");
  }

  for (const [key, face] of faces) {
    const box = boxes.get(key);
    if (box) box.height = boxHeight(face.left, face.right);
  }
}

/**
 * Widens every machine until the cables inside it have the room the cables
 * outside it have, then lays its apps out in it.
 *
 * A room grows a row per coupling (`sizeSpaces`); a machine grows a lane per
 * cable, for the same reason. Its apps' wiring has only two ways through — the
 * gutter down each side, and the gap between two apps — and those are fixed
 * strips, so a machine running OBS and Meet used to draw four connectors 3px
 * apart while every line outside it kept 8. Cramped is its own kind of wrong
 * answer: the reader is counting lines, and lines drawn closer together than
 * the rest of the picture read as fewer of them.
 *
 * So the strip is sized to what it holds rather than what it holds being
 * squeezed into the strip — outward, into the machine's own width, because the
 * app inside is a box someone has to read. The counting has to agree with
 * `settleLanes` about which lines end up in which strip, which is why both ask
 * `routeOf` rather than each deciding for itself; it runs after ranking for the
 * same reason, since that is when a line's shape is known. Nothing before this
 * point reads a nested box's size.
 */
function sizeHosts(
  boxes: Map<string, Box>,
  edges: readonly DrawnEdge[],
  column: Map<string, number>,
  forwardIds: ReadonlySet<string>,
): void {
  const gutters = new Map<string, number>();
  const pairs = new Map<string, { machine: string; lines: number }>();

  for (const edge of edges) {
    const from = boxes.get(edge.from);
    const to = boxes.get(edge.to);
    if (!from || !to) continue;
    const route = routeOf(edge, from, to, boxes, column, forwardIds);

    for (const stand of standoffs(route, from, to)) {
      if (stand.strip !== "gutter" || stand.box.parentKey === null) continue;
      const strip = gutterStrip(stand.box.parentKey, stand.side);
      gutters.set(strip, (gutters.get(strip) ?? 0) + 1);
    }
    if (route.shape !== "sibling") continue;
    if (from.parentKey === null || from.parentKey !== to.parentKey) continue;
    const key = [from.key, to.key].sort(compare).join("|");
    const pair = pairs.get(key) ?? { machine: from.parentKey, lines: 0 };
    pair.lines += 1;
    pairs.set(key, pair);
  }

  const busiest = new Map<string, number>();
  for (const pair of pairs.values()) {
    busiest.set(pair.machine, Math.max(busiest.get(pair.machine) ?? 0, pair.lines));
  }

  for (const box of boxes.values()) {
    if (box.children.length === 0) continue;
    box.padLeft = gutterWidth(gutters.get(gutterStrip(box.key, "left")) ?? 0);
    box.padRight = gutterWidth(gutters.get(gutterStrip(box.key, "right")) ?? 0);
    box.gap = crossingGap(busiest.get(box.key) ?? 0);
  }
  for (const box of boxes.values()) {
    if (box.parentKey === null) sizeNested(box, 0);
  }
}

/** One end of a line, and the strip it will stand off in. */
type Standoff = { box: Box; side: PortSide; strip: "gutter" | "beside" };

/**
 * Which strips a line will claim, as `settleLanes` will claim them.
 *
 * Read twice — once to size the strips and once to hand them out — and the two
 * readings have to agree, or a strip is sized for lines that end up elsewhere
 * while the lines that do arrive are crowded into whatever is left.
 */
function standoffs(route: Route<Box>, from: Box, to: Box): Standoff[] {
  const nested = (box: Box, side: PortSide): Standoff => ({
    box,
    side,
    strip: box.parentKey === null ? "beside" : "gutter",
  });
  switch (route.shape) {
    case "nested":
      return route.inner ? [nested(route.inner, route.fromSide)] : [];
    // Both ends: each stands off its own face, so each takes a lane of the
    // strip it stands off in.
    case "sibling":
      return [nested(from, route.fromSide), nested(to, route.toSide)];
    // A return leaves its machine before it descends (`escapeMachine`), so it
    // is beside the column wherever its jack was.
    case "back":
      return [
        { box: from, side: route.fromSide, strip: "beside" },
        { box: to, side: route.toSide, strip: "beside" },
      ];
    // A line going forward leaves its jack sideways and stands off nothing.
    case "forward":
      return [];
  }
}

function gutterStrip(machineKey: string, side: PortSide): string {
  return `gutter:${machineKey}:${side}`;
}

/** Wide enough that `spread` can hand out `lines` lanes without closing up. */
function gutterWidth(lines: number): number {
  return Math.max(NEST_PAD, LINE_FLOOR + Math.max(0, lines - 1) * LINE_PITCH + NEST_CLEAR);
}

function crossingGap(lines: number): number {
  return Math.max(NEST_GAP, CROSS_CLEAR + Math.max(0, lines - 1) * LINE_PITCH);
}

/**
 * Where the first column stands, which is however much its returns need.
 *
 * Every other left face has a whole column gap to stand off in; the first has
 * the page margin, and `roomBeside` reads the room off the anchor for exactly
 * that reason. But reading it is not the same as having it — a hall returning
 * into three mics put three risers into fourteen pixels, one of them ten from
 * the edge of the picture. The margin is a strip like any other, so it is sized
 * like one: the innermost riser stands where a single riser has always stood
 * and the rest go outward, taking the page with them.
 */
function leftMargin(
  edges: readonly DrawnEdge[],
  boxes: Map<string, Box>,
  column: Map<string, number>,
  forwardIds: ReadonlySet<string>,
): number {
  let lines = 0;
  for (const edge of edges) {
    const from = boxes.get(edge.from);
    const to = boxes.get(edge.to);
    if (!from || !to) continue;
    const route = routeOf(edge, from, to, boxes, column, forwardIds);
    for (const stand of standoffs(route, from, to)) {
      // A nested box escapes to its machine's face, and its machine is in its
      // column — so the column is the same question either way.
      if (stand.strip !== "beside" || stand.side !== "left") continue;
      if ((column.get(stand.box.key) ?? 0) === 0) lines += 1;
    }
  }
  if (lines === 0) return PADDING;
  // `PADDING` past the outermost, which is what the width and the height
  // already leave past theirs: every line in the picture is one margin from
  // the edge of it, and the band tint starts half of one further out.
  return Math.max(PADDING, ELBOW + (lines - 1) * LINE_PITCH + PADDING);
}

/**
 * The strip of rows at the bottom of one room that its own returns run in.
 *
 * Counted before the rows are ordered and placed while they are being assigned,
 * because only `separateLanes` knows where a lane ends up — and only it knows it
 * with the dummy rows counted in, so a return lane cannot land on a row a
 * crossing is already using.
 */
type ReturnBand = { lanes: number; top: number };

/** The lowest lane of a band, which is what the room has to be tall enough for. */
function bandBottom(band: ReturnBand): number {
  return band.top + (band.lanes - 1) * RETURN_LANE_PITCH;
}

/**
 * How many returns each room has to hold, which is how much room it is given.
 *
 * A hall feeding its own microphones is a loop that closes inside one room, and
 * run under the whole picture it descends past every room in between — so the
 * reader follows it out of the frame, along the bottom of the page, and back in,
 * to be told something that never left. Under the room it left, it is read where
 * the loop is.
 *
 * So a room grows a lane per return it holds, exactly as it grows a row per
 * coupling (`sizeSpaces`), a machine grows a lane per cable (`sizeHosts`) and
 * the page margin grows one per riser (`leftMargin`): the strip is sized by what
 * it has to carry. Counting through `routeOf` is what keeps it sized for the
 * lines that actually arrive in it.
 *
 * The *root* boxes decide the room, because a join is drawn inside the laptop it
 * runs on and the laptop is what is standing somewhere. A meeting is not a place
 * (`placeKeyOf`), so a return out of one is between two rooms however few rooms
 * are on the page, and keeps the lanes under the picture.
 */
function returnBands(
  edges: readonly DrawnEdge[],
  boxes: Map<string, Box>,
  places: Map<string, Place>,
  column: Map<string, number>,
  forwardIds: ReadonlySet<string>,
): Map<string, ReturnBand> {
  const bands = new Map<string, ReturnBand>();
  for (const edge of edges) {
    const from = boxes.get(edge.from);
    const to = boxes.get(edge.to);
    if (!from || !to) continue;
    if (routeOf(edge, from, to, boxes, column, forwardIds).shape !== "back") continue;
    const room = sharedRoom(from, to, boxes);
    if (room === null || !places.has(room)) continue;
    const band = bands.get(room) ?? { lanes: 0, top: 0 };
    band.lanes += 1;
    bands.set(room, band);
  }
  return bands;
}

/**
 * The room both ends of a line are standing in, or `null` when they are not.
 *
 * Read twice — once to size the bands and once to hand out their lanes — and
 * both readings have to agree, for the same reason `standoffs` is shared: a band
 * sized for a return that ends up under the picture leaves a gap nothing runs
 * in, and a return sent to a band nobody counted lands on the room below.
 */
function sharedRoom<T extends Box>(from: T, to: T, boxes: Map<string, T>): string | null {
  const room = rootOf(from, boxes).placeKey;
  return room !== null && room === rootOf(to, boxes).placeKey ? room : null;
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
 * Two kinds of edge are cut before the loop search runs, and for the same
 * reason. A mic is where signal starts by definition, and a room is where
 * signal leaves the cables — so a room feeding anything standing in it is a
 * return path, not a step forward. Cutting both by rule, rather than by
 * whichever edge the search happened to reach first, is what keeps two
 * identical devices in the same column.
 */
function splitByDirection(
  keys: readonly string[],
  edges: readonly DrawnEdge[],
  boxes: Map<string, Box>,
): { forward: DrawnEdge[]; back: DrawnEdge[] } {
  const intoInput = new Set(
    edges.filter(
      (edge) => boxes.get(edge.to)?.role === "input" || boxes.get(edge.from)?.kind === "space",
    ),
  );
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
 * is. Rooms sit one column further still, because a room is not a stage of the
 * chain but the point where it folds back — so its column has to follow from
 * what a room *is*, not from which transducers happen to stand in it. Left to
 * its inflow a hall with a speaker lands past the outputs while a camera-only
 * room, having nothing emitting into it, stays at column 0: the two halves of
 * one place then draw at opposite ends of the picture.
 */
function rankByRole(
  keys: readonly string[],
  forward: readonly DrawnEdge[],
  boxes: Map<string, Box>,
): Map<string, number> {
  const hasInput = keys.some((key) => boxes.get(key)?.role === "input");
  const floorFor = (key: string, output: number): number | undefined => {
    const box = boxes.get(key);
    if (box?.kind === "space") return output + 1;
    const role = box?.role;
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
  withinLane: Map<string, number>,
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
  return columns.map((column) => byLane(column, lanes, rankOfLane, withinLane));
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
 *
 * `withinLane` then settles the one tie the median heuristic cannot: a room's
 * two spaces share a lane and a column and neither has a forward edge, so
 * without it their rows came from the order the document declared them in, and
 * one hall's air sat above its sight or below it depending on which half was
 * typed first. Everything else scores 0 and keeps the order the sweeps found.
 */
function byLane(
  column: readonly string[],
  lanes: Map<string, string>,
  rankOfLane: Map<string, number>,
  withinLane: Map<string, number>,
): string[] {
  return [...column].sort(
    (a, b) =>
      (rankOfLane.get(lanes.get(a) ?? NO_PLACE) ?? 0) -
        (rankOfLane.get(lanes.get(b) ?? NO_PLACE) ?? 0) ||
      (withinLane.get(a) ?? 0) - (withinLane.get(b) ?? 0),
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
  bands: Map<string, ReturnBand>,
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

  separateLanes(columns, y, heightOf, lanes, order, places, bands);
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
 * It is also where a room's return band is placed, because this is the one
 * point that knows where a lane ended up — and knows it with the dummy rows
 * counted in, which measuring the floor off the boxes alone would miss.
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
  bands: Map<string, ReturnBand>,
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
    cursor += head + (extent.bottom - extent.top);
    // A room's own returns run below everything in it, so the room is that much
    // taller and the next one starts below them rather than through them. The
    // tail is what the border will take (`computeFrames`), so two rooms are the
    // same distance apart whether or not either of them holds a return.
    const band = bands.get(lane);
    if (band) {
      band.top = cursor + RETURN_LANE_GAP;
      cursor += RETURN_LANE_GAP + (band.lanes - 1) * RETURN_LANE_PITCH + FRAME_CLEAR;
    } else if (framed) cursor += FRAME_PAD;
    cursor += PLACE_GAP;
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

/**
 * Where a column stands and how wide its slot is.
 *
 * The slot is the widest box in the column, so the gap between two columns is
 * `COL_GAP` wherever you measure it. That is what everything standing off a
 * face — a return riser most of all — assumes it has to itself, and a machine
 * widened to hold its own cables would otherwise spend the next column's gap.
 */
type Slot = { x: number; width: number; items: readonly string[] };

function columnSlots(
  columns: readonly string[][],
  boxes: Map<string, Box>,
  margin: number,
): Slot[] {
  const slots: Slot[] = [];
  let x = margin;
  for (const items of columns) {
    let width = BOX_WIDTH;
    for (const key of items) width = Math.max(width, boxes.get(key)?.width ?? 0);
    slots.push({ x, width, items });
    x += width + COL_GAP;
  }
  return slots;
}

function buildLayout(
  places: Map<string, Place>,
  boxes: Map<string, Box>,
  edges: readonly DrawnEdge[],
  forwardIds: ReadonlySet<string>,
  column: Map<string, number>,
  columns: readonly string[][],
  y: Map<string, number>,
  bands: Map<string, ReturnBand>,
): Layout {
  const slots = columnSlots(columns, boxes, leftMargin(edges, boxes, column, forwardIds));
  const placed = new Map<string, PlacedBox>();
  const place = (box: Box, x: number, top: number, col: number, row: number) => {
    placed.set(box.key, { ...box, column: col, row, x, y: top });
    // The children go in the machine's lower half, under its own jacks. Their
    // heights were folded into its height before anything was ranked, so this
    // cannot push anything out of the box it was given.
    let cursor = top + box.contentTop;
    for (const child of box.children) {
      place(child, x + box.padLeft, cursor, col, row);
      cursor += child.height + box.gap;
    }
  };

  slots.forEach((slot, col) => {
    let row = 0;
    for (const key of slot.items) {
      const box = boxes.get(key);
      if (!box) continue;
      place(box, slot.x, y.get(key) ?? PADDING, col, row++);
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
        ports: box.ports.map((port) => {
          const x = port.side === "right" ? box.x + box.width : box.x;
          const pad = port.side === "right" ? box.padRight : box.padLeft;
          const inset = box.children.length > 0 ? pad + LABEL_INSET : LABEL_INSET;
          return {
            key: port.key,
            label: port.label,
            direction: port.direction,
            side: port.side,
            x,
            y: box.y + port.dy,
            labelX: port.side === "right" ? x - inset : x + inset,
          };
        }),
      },
    ];
  });

  let bottom = PADDING;
  for (const node of nodes) bottom = Math.max(bottom, node.y + node.height);
  // Past the lowest room band too: a room whose returns run below the last box
  // in the picture would otherwise share its lowest lane with the first of the
  // lanes under the picture, and two returns would be drawn as one.
  for (const band of bands.values()) bottom = Math.max(bottom, bandBottom(band));

  const laid = routeEdges(edges, placed, forwardIds, bands, slots, column, y, bottom);

  const frames = computeFrames(places, placed, bands, laid);
  const order = columns.flat();
  let width = PADDING;
  let height = bottom + PADDING;
  for (const node of nodes) width = Math.max(width, node.x + node.width);
  for (const frame of frames) {
    width = Math.max(width, frame.x + frame.width);
    height = Math.max(height, frame.y + frame.height + PADDING);
  }
  for (const edge of laid) {
    // The return risers stand off the last column, which is past the last box,
    // so the width has to follow the lines as the height already does.
    for (const point of edge.points) {
      width = Math.max(width, point.x);
      height = Math.max(height, point.y + PADDING);
    }
  }
  width += PADDING;
  const columnCount = nodes.reduce((max, node) => Math.max(max, node.column + 1), 0);

  return {
    nodes,
    edges: laid,
    bands: computeBands(nodes, slots, columnCount, width),
    frames,
    columns: columnCount,
    rows: columns.reduce((max, items) => Math.max(max, items.length), 0),
    width,
    height,
    order,
  };
}

/** Is `inner` drawn inside `outer`? */
function nestedInside(inner: Box, outer: Box, boxes: Map<string, Box>): boolean {
  let key = inner.parentKey;
  while (key !== null) {
    if (key === outer.key) return true;
    key = boxes.get(key)?.parentKey ?? null;
  }
  return false;
}

/**
 * A frame round everything in one place.
 *
 * Only top-level boxes are measured: what is nested is already inside the box
 * that holds it, and its own return band, which is drawn inside the room for the
 * same reason it is routed there — a line that closes a loop in this room is
 * part of this room. A place holding nothing but its own air gets no frame — a
 * border round one pill states nothing the pill does not.
 */
function computeFrames(
  places: Map<string, Place>,
  placed: Map<string, PlacedBox>,
  bands: Map<string, ReturnBand>,
  laid: readonly LayoutEdge[],
): LayoutFrame[] {
  const reaches = returnReach(placed, bands, laid);
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
    // The room's own returns are the room's, and a riser standing on the border
    // reads as one that left it — which is the one thing this line does not do.
    const reach = reaches.get(place.key);
    const x = Math.min(left - FRAME_PAD, (reach?.left ?? left) - FRAME_CLEAR);
    const y = Math.min(top - FRAME_PAD, (reach?.top ?? top) - FRAME_CLEAR) - FRAME_HEADER;
    const far = Math.max(right + FRAME_PAD, (reach?.right ?? right) + FRAME_CLEAR);
    const low = Math.max(bottom + FRAME_PAD, (reach?.bottom ?? bottom) + FRAME_CLEAR);

    frames.push({
      key: place.key,
      label: place.label,
      spaceKinds: place.spaceKinds,
      x,
      y,
      width: far - x,
      height: low - y,
    });
  }
  return frames;
}

/**
 * How far each room's own returns reach, which its frame has to hold too.
 *
 * Measured off the routed points rather than worked out again, because the
 * risers are shared strips — how far out one stands depends on what else is
 * claiming that strip — and a frame drawn from a second guess at that would be
 * the one thing on the page that is not where the lines are.
 */
function returnReach(
  placed: Map<string, PlacedBox>,
  bands: Map<string, ReturnBand>,
  laid: readonly LayoutEdge[],
): Map<string, { left: number; top: number; right: number; bottom: number }> {
  const reaches = new Map<string, { left: number; top: number; right: number; bottom: number }>();
  for (const edge of laid) {
    if (!edge.back) continue;
    const from = placed.get(edge.from);
    const to = placed.get(edge.to);
    if (!from || !to) continue;
    const room = sharedRoom(from, to, placed);
    if (room === null || !bands.has(room)) continue;
    for (const point of edge.points) {
      const reach = reaches.get(room);
      if (!reach) {
        reaches.set(room, { left: point.x, top: point.y, right: point.x, bottom: point.y });
        continue;
      }
      reach.left = Math.min(reach.left, point.x);
      reach.top = Math.min(reach.top, point.y);
      reach.right = Math.max(reach.right, point.x);
      reach.bottom = Math.max(reach.bottom, point.y);
    }
  }
  return reaches;
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
  slots: readonly Slot[],
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
    const first = slots[band.fromColumn];
    const last = slots[band.toColumn];
    const left = Math.max(PADDING / 2, (first?.x ?? PADDING) - inset);
    const right = Math.min(
      width - PADDING / 2,
      (last?.x ?? PADDING) + (last?.width ?? BOX_WIDTH) + inset,
    );
    band.x = left;
    band.width = Math.max(0, right - left);
  }
  return bands;
}

/** Where a long edge crosses the columns in between, in left-to-right order. */
function waypoints(
  edge: DrawnEdge,
  slots: readonly Slot[],
  column: Map<string, number>,
  y: Map<string, number>,
): Waypoint[] {
  const from = column.get(edge.from) ?? 0;
  const to = column.get(edge.to) ?? 0;
  const points: Waypoint[] = [];
  for (let col = from + 1; col < to; col++) {
    const key = `dummy:${edge.id}:${col}`;
    const slot = slots[col];
    if (!slot?.items.includes(key)) continue;
    points.push({
      x: slot.x,
      y: (y.get(key) ?? PADDING) + DUMMY_HEIGHT / 2,
      width: slot.width,
    });
  }
  return points;
}

/** A row reserved for one line in a column it only passes through. */
type Waypoint = Point & { width: number };

/**
 * The four shapes a line can take, decided before any of them is drawn.
 *
 * They are worked out up front because which shape a line takes decides which
 * strip it runs in, and a strip is shared: two lines that pick the same one
 * have to be told about each other before either is routed.
 */
type EdgeShape = "nested" | "sibling" | "forward" | "back";

type Route<T> = {
  shape: EdgeShape;
  /** The box drawn inside the other one. */
  inner: T | null;
  fromSide: PortSide;
  toSide: PortSide;
};

/**
 * Which shape a line takes, decided from the boxes alone.
 *
 * Nothing here reads a coordinate, which is what lets `sizeHosts` ask the same
 * question before anything is placed — a machine has to be sized for the lines
 * that will run inside it, and it cannot be sized after they are drawn.
 */
function routeOf<T extends Box>(
  edge: DrawnEdge,
  from: T,
  to: T,
  boxes: Map<string, Box>,
  column: Map<string, number>,
  forwardIds: ReadonlySet<string>,
): Route<T> {
  const fromSide = sideOf(from, edge.fromPort, "right");
  const toSide = sideOf(to, edge.toPort, "left");
  const inner = nestedInside(from, to, boxes) ? from : nestedInside(to, from, boxes) ? to : null;
  const fromColumn = column.get(from.key) ?? 0;
  const toColumn = column.get(to.key) ?? 0;
  // A device selection joins two jacks of one face; anything else between an
  // app and its machine — a capture between two apps, most of all — is a
  // sibling, and crosses between the boxes rather than running up the gutter.
  const shape: EdgeShape =
    inner && fromSide === toSide
      ? "nested"
      : fromColumn === toColumn
        ? "sibling"
        : forwardIds.has(edge.id) && toColumn > fromColumn
          ? "forward"
          : "back";
  return { shape, inner, fromSide, toSide };
}

type Plan = {
  edge: DrawnEdge;
  from: PlacedBox;
  to: PlacedBox;
  a: Anchor;
  b: Anchor;
  shape: EdgeShape;
  /** The box drawn inside the other one, for a `nested` line. */
  inner: PlacedBox | null;
  /** The lane a `back` line returns in — its own room's band, or the picture's. */
  lane: number;
  /** How far off its face the line stands, at each end. */
  out: number;
  into: number;
  /** Where a `sibling` line crosses between the two boxes. */
  cross: number;
};

/**
 * Routes every line, having first moved apart the ones that would otherwise be
 * drawn on top of each other.
 *
 * Overlapping is not the same problem as crossing. Two cables that cross read
 * as two cables — that is what the halo under each line is for — but two drawn
 * along the same run are one line on screen, and where they end together they
 * are one arrowhead too, so the picture silently under-reports the wiring. It
 * happens wherever several lines have to get through the same strip: the risers
 * down to the return lanes all leave one column, the device selections on one
 * machine all run in one gutter, and two apps wired to each other can only
 * cross in the gap between them.
 *
 * So each strip is shared out rather than defaulted into: `settle` gives every
 * line claiming one an offset of its own, and a strip with a single claim keeps
 * the offset it always had, which is what stops this from moving pictures that
 * were never ambiguous.
 */
function routeEdges(
  edges: readonly DrawnEdge[],
  placed: Map<string, PlacedBox>,
  forwardIds: ReadonlySet<string>,
  bands: Map<string, ReturnBand>,
  slots: readonly Slot[],
  column: Map<string, number>,
  y: Map<string, number>,
  bottom: number,
): LayoutEdge[] {
  const rows = spaceRows(edges, placed);

  const plans: Plan[] = [];
  for (const edge of edges) {
    const from = placed.get(edge.from);
    const to = placed.get(edge.to);
    if (!from || !to) continue;
    const a = anchorOf(from, edge.fromPort, "right", rows.get(rowKey(edge, edge.from)));
    const b = anchorOf(to, edge.toPort, "left", rows.get(rowKey(edge, edge.to)));
    const { shape, inner } = routeOf(edge, from, to, placed, column, forwardIds);
    plans.push({ edge, from, to, a, b, shape, inner, lane: 0, out: ELBOW, into: ELBOW, cross: 0 });
  }

  settleLanes(plans, placed, bands, bottom);

  return plans.map((plan) => ({
    id: plan.edge.id,
    from: plan.edge.from,
    to: plan.edge.to,
    fromPort: plan.edge.fromPort,
    toPort: plan.edge.toPort,
    kind: plan.edge.kind,
    media: plan.edge.media,
    linkId: plan.edge.linkId,
    sourceIds: plan.edge.sourceIds,
    back: plan.shape === "back",
    points: pointsOf(plan, slots, column, y),
  }));
}

function pointsOf(
  plan: Plan,
  slots: readonly Slot[],
  column: Map<string, number>,
  y: Map<string, number>,
): Point[] {
  const { a, b, from, to } = plan;
  switch (plan.shape) {
    case "nested":
      return routeNested(a, b, plan.inner ?? from, plan.out);
    case "sibling":
      return routeSibling(a, b, plan.cross, plan.out, plan.into);
    case "forward":
      return routeForward(a, b, from, to, waypoints(plan.edge, slots, column, y));
    case "back":
      return routeBack(a, b, plan.lane, plan.out, plan.into);
  }
}

function rowKey(edge: DrawnEdge, boxKey: string): string {
  return `${edge.id}@${boxKey}`;
}

/**
 * Which row of a room's face each cable meets it on.
 *
 * Ordered by the far end, so the fan out of a room does not cross itself on the
 * way. That is the whole ordering: unlike a port, a room's row means nothing on
 * its own — there is no jack there to name — so it may be decided by what makes
 * the picture readable.
 */
function spaceRows(
  edges: readonly DrawnEdge[],
  placed: Map<string, PlacedBox>,
): Map<string, number> {
  type Face = { key: string; edges: DrawnEdge[] };
  const faces = new Map<string, Face>();
  const claim = (key: string, side: PortSide, edge: DrawnEdge) => {
    if (placed.get(key)?.kind !== "space") return;
    const id = `${key}:${side}`;
    const face = faces.get(id) ?? { key, edges: [] };
    face.edges.push(edge);
    faces.set(id, face);
  };

  for (const edge of edges) {
    if (!placed.has(edge.from) || !placed.has(edge.to)) continue;
    claim(edge.from, "right", edge);
    claim(edge.to, "left", edge);
  }

  const rows = new Map<string, number>();
  for (const face of faces.values()) {
    const ordered = [...face.edges].sort(
      (left, right) =>
        farSide(left, face.key, placed) - farSide(right, face.key, placed) ||
        compare(left.id, right.id),
    );
    ordered.forEach((edge, index) => {
      rows.set(rowKey(edge, face.key), HEADER_HEIGHT + index * PORT_PITCH + PORT_PITCH / 2);
    });
  }
  return rows;
}

/**
 * Where a line with no jack meets a face: between two rows, never on one.
 *
 * The middle of a face lands wherever the box's height happens to put it, which
 * for a join was six pixels off one of its own jacks — so its coupling into the
 * meeting and the cable out of the jack below left the box as a pair of lines
 * running together. Halfway between two rows is the one offset on a face that
 * no jack can be at, and it is a full pitch from the two either side of it.
 */
function betweenRows(height: number): number {
  const rows = Math.max(0, Math.round((height / 2 - HEADER_HEIGHT) / PORT_PITCH));
  return HEADER_HEIGHT + rows * PORT_PITCH;
}

/** Where the other end of this line sits, which is what orders a room's rows. */
function farSide(edge: DrawnEdge, near: string, placed: Map<string, PlacedBox>): number {
  const isFrom = edge.from === near;
  const far = placed.get(isFrom ? edge.to : edge.from);
  if (!far) return 0;
  const portKey = isFrom ? edge.toPort : edge.fromPort;
  const port = portKey === null ? undefined : far.ports.find((entry) => entry.key === portKey);
  return far.y + (port ? port.dy : far.height / 2);
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** One line's claim on a strip that other lines also have to get through. */
type Claim = {
  strip: string;
  /** What the claims in one strip are ordered by, innermost first. */
  order: number;
  /** Where the first line in the strip runs, and how far the strip reaches. */
  base: number;
  room: number;
  pitch: number;
  take: (offset: number) => void;
};

/**
 * Hands out the shared strips, and gives every return path its own lane.
 *
 * The lanes are still assigned in document order, so a picture's return paths
 * stay in the order the reader last saw them; everything else is derived from
 * where the line already is.
 */
function settleLanes(
  plans: readonly Plan[],
  placed: Map<string, PlacedBox>,
  bands: Map<string, ReturnBand>,
  bottom: number,
): void {
  const claims: Claim[] = [];
  const taken = new Map<string, number>();

  for (const plan of plans) {
    if (plan.shape === "back") {
      plan.lane = returnLane(plan, placed, bands, bottom, taken);
      // Both ends: two returns into one box's face collide on the way up out of
      // the lanes exactly as two leaving one room collide on the way down.
      // Deeper lane, further out — then no riser crosses a lane it is not in.
      claims.push(
        escapeMachine(plan.from, plan.a, plan.lane, placed, (offset) => {
          plan.out = offset;
        }),
        escapeMachine(plan.to, plan.b, plan.lane, placed, (offset) => {
          plan.into = offset;
        }),
      );
      continue;
    }

    if (plan.shape === "nested") {
      claims.push(
        gutter(plan.inner, plan.a.side, plan.a.y, placed, (offset) => {
          plan.out = offset;
        }),
      );
      continue;
    }

    if (plan.shape !== "sibling") continue;
    claims.push(
      standoff(plan.from, plan.a, plan.a.y, placed, (offset) => {
        plan.out = offset;
      }),
      standoff(plan.to, plan.b, plan.b.y, placed, (offset) => {
        plan.into = offset;
      }),
    );
  }

  settle(claims);
  crossings(plans);
}

/**
 * Which lane a return runs in: its own room's band, or the ones under the whole
 * picture when it does not come home to the room it left.
 *
 * The bands stack down the page in room order and the picture's own lanes sit
 * below the last of them, so a deeper lane is still further down whichever it
 * came from — which is what lets `escapeMachine` keep ordering the risers by it
 * and be sure no riser crosses a lane it is not in.
 */
function returnLane(
  plan: Plan,
  placed: Map<string, PlacedBox>,
  bands: Map<string, ReturnBand>,
  bottom: number,
  taken: Map<string, number>,
): number {
  const room = sharedRoom(plan.from, plan.to, placed);
  const band = room === null ? undefined : bands.get(room);
  const key = band ? (room ?? NO_PLACE) : NO_PLACE;
  const index = taken.get(key) ?? 0;
  taken.set(key, index + 1);
  return (band ? band.top : bottom + RETURN_LANE_GAP) + index * RETURN_LANE_PITCH;
}

/**
 * The strip a line standing off a face runs in: its machine's gutter if it has
 * one, and the column gap otherwise.
 */
function standoff(
  box: PlacedBox,
  anchor: Anchor,
  order: number,
  placed: Map<string, PlacedBox>,
  take: (offset: number) => void,
): Claim {
  if (box.parentKey === null) return beside(anchor, order, take);
  return gutter(box, anchor.side, order, placed, take);
}

/**
 * A return leaving a nested box: out of the machine first, then down.
 *
 * A gutter is a strip inside one machine, and a return path is not going
 * anywhere inside it — it descends the whole picture. Standing it off the app's
 * own face left it running down through its machine, and worse, made it the
 * only line in a strip nothing else could claim: two returns into two machines
 * standing in one column were each alone in their own gutter, at the same
 * offset, at the same x, which is one line on screen. Off the machine's face
 * they are in the strip beside the column, which every other riser there is
 * claiming too, so they are handed lanes like everything else.
 */
function escapeMachine(
  box: PlacedBox,
  anchor: Anchor,
  order: number,
  placed: Map<string, PlacedBox>,
  take: (offset: number) => void,
): Claim {
  const root = rootOf(box, placed);
  const face = anchor.side === "right" ? root.x + root.width : root.x;
  const inset = Math.abs(face - anchor.x);
  return beside({ ...anchor, x: face }, order, (offset) => take(offset + inset));
}

/** The top-level box a line's end is drawn inside, which is itself for most. */
function rootOf<T extends Box>(box: T, boxes: Map<string, T>): T {
  let current = box;
  while (current.parentKey !== null) {
    const parent = boxes.get(current.parentKey);
    if (!parent) break;
    current = parent;
  }
  return current;
}

/** A line standing off a face, in the strip beside it. */
function beside(anchor: Anchor, order: number, take: (offset: number) => void): Claim {
  return {
    strip: `beside:${Math.round(anchor.x)}:${anchor.side}`,
    order,
    base: ELBOW,
    room: roomBeside(anchor),
    pitch: LINE_PITCH,
    take,
  };
}

/**
 * A line running in the gutter between an app's border and its machine's.
 *
 * The gutter is as wide as the lines in it need (`sizeHosts`), so `room` is
 * read off the machine rather than assumed: the lines then come out one pitch
 * apart instead of packed into whatever the gutter happened to be.
 */
function gutter(
  inner: PlacedBox | null,
  side: PortSide,
  order: number,
  placed: Map<string, PlacedBox>,
  take: (offset: number) => void,
): Claim {
  const machineKey = inner?.parentKey ?? "";
  const machine = placed.get(machineKey);
  const pad = machine ? (side === "right" ? machine.padRight : machine.padLeft) : NEST_PAD;
  return {
    strip: gutterStrip(machineKey, side),
    order,
    base: pad / 2,
    room: pad - NEST_CLEAR,
    pitch: LINE_PITCH,
    take,
  };
}

/**
 * How far a line may stand off this face.
 *
 * A face at column 0 has only the page margin to its left, and a line pushed
 * past it would be drawn outside the picture rather than merely too near the
 * next column — so the room is read off the anchor.
 */
function roomBeside(anchor: Anchor): number {
  if (anchor.side === "right") return BESIDE_ROOM;
  return Math.max(ELBOW, Math.min(BESIDE_ROOM, anchor.x - PADDING / 2));
}

function settle(claims: readonly Claim[]): void {
  const strips = new Map<string, Claim[]>();
  for (const claim of claims) {
    const list = strips.get(claim.strip);
    if (list) list.push(claim);
    else strips.set(claim.strip, [claim]);
  }

  for (const list of strips.values()) {
    const ordered = [...list].sort((left, right) => left.order - right.order);
    ordered.forEach((claim, index) => claim.take(spread(index, ordered.length, claim)));
  }
}

/**
 * Where the `index`th of `count` lines runs in a strip.
 *
 * One line keeps `base`, which is the offset the picture has always used. The
 * rest follow at `pitch`, and the run slides inward when the strip is too
 * narrow to hold them all outside it — the returns into the leftmost column
 * have only the page margin to stand in, and a line pushed past that is drawn
 * off the picture rather than merely close to the next column. Cramped is worse
 * than spread out, but both beat drawn on top of one another, and `LINE_FLOOR`
 * is what keeps the innermost still reading as a line that left the face.
 */
function spread(index: number, count: number, claim: Claim): number {
  if (count <= 1) return claim.base;
  const room = Math.max(claim.room, LINE_FLOOR);
  const step = Math.min(claim.pitch, (room - LINE_FLOOR) / (count - 1));
  const first = Math.min(claim.base, room - step * (count - 1));
  return first + index * step;
}

/**
 * Where each line between two boxes in one column crosses between them.
 *
 * The gap is the only strip there that holds no box, so several cables between
 * one pair — an app's window taken as both sound and picture is two — have to
 * share it. Spread about the middle of the gap rather than out from one edge,
 * so a single cable still crosses where it always did.
 */
function crossings(plans: readonly Plan[]): void {
  const pairs = new Map<string, Plan[]>();
  for (const plan of plans) {
    if (plan.shape !== "sibling") continue;
    const key = [plan.from.key, plan.to.key].sort(compare).join("|");
    const list = pairs.get(key);
    if (list) list.push(plan);
    else pairs.set(key, [plan]);
  }

  for (const list of pairs.values()) {
    const first = list[0];
    if (!first) continue;
    const above = first.from.y <= first.to.y ? first.from : first.to;
    const below = above === first.from ? first.to : first.from;
    const gap = below.y - (above.y + above.height);
    const middle = above.y + above.height + Math.max(0, gap) / 2;
    const step = Math.min(
      LINE_PITCH,
      Math.max(0, gap - CROSS_CLEAR) / Math.max(1, list.length - 1),
    );
    const ordered = [...list].sort(
      (left, right) => left.a.y - right.a.y || compare(left.edge.id, right.edge.id),
    );
    ordered.forEach((plan, index) => {
      plan.cross = middle + (index - (ordered.length - 1) / 2) * step;
    });
  }
}

type Anchor = { x: number; y: number; side: PortSide };

function portOf(box: Box, portKey: string | null): BoxPort | undefined {
  return portKey === null ? undefined : box.ports.find((entry) => entry.key === portKey);
}

/** Which face of its box a line leaves by: its jack's, or the one it is given. */
function sideOf(box: Box, portKey: string | null, fallback: PortSide): PortSide {
  return portOf(box, portKey)?.side ?? fallback;
}

/**
 * Where a line meets a box: the jack it names, or the row it was given.
 *
 * `row` is what a room gets instead of a jack (`spaceRows`). Falling back to
 * the middle of the face is still right for a box with neither — one line
 * cannot collide with itself.
 */
function anchorOf(
  box: PlacedBox,
  portKey: string | null,
  fallback: PortSide,
  row?: number,
): Anchor {
  const port = portOf(box, portKey);
  if (!port) {
    return {
      x: fallback === "right" ? box.x + box.width : box.x,
      y: box.y + (row ?? betweenRows(box.height)),
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
function routeForward(
  a: Anchor,
  b: Anchor,
  from: PlacedBox,
  to: PlacedBox,
  via: Waypoint[],
): Point[] {
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
    points.push({ x: point.x, y: point.y }, { x: point.x + point.width, y: point.y });
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
 * A device selection only ever joins two jacks of the same face (out→out when
 * an app plays into one, in→in when it captures from one), so the connector
 * runs up the gutter between the app's border and the machine's — the only
 * strip of the machine nothing else is drawn in, including its other apps.
 * Which lane of that gutter it takes is `settleLanes`': two apps selecting the
 * same jack of one machine ran down the same line otherwise, and a machine with
 * OBS and Meet on it is the ordinary case, not the awkward one.
 */
function routeNested(a: Anchor, b: Anchor, inner: PlacedBox, lane: number) {
  const gutter = a.side === "right" ? inner.x + inner.width + lane : inner.x - lane;
  return [
    { x: a.x, y: a.y },
    { x: gutter, y: a.y },
    { x: gutter, y: b.y },
    { x: b.x, y: b.y },
  ];
}

/**
 * Two boxes in the same column: an app and the computer it runs on, or two apps
 * on one machine.
 *
 * The connector crosses between them rather than taking the return lane,
 * because nothing here is going backwards — it is one machine. When both jacks
 * are on the same face this collapses to a straight run down that side.
 */
function routeSibling(a: Anchor, b: Anchor, cross: number, out: number, into: number): Point[] {
  const ax = a.side === "right" ? a.x + out : a.x - out;
  const bx = b.side === "right" ? b.x + into : b.x - into;
  return [
    { x: a.x, y: a.y },
    { x: ax, y: a.y },
    { x: ax, y: cross },
    { x: bx, y: cross },
    { x: bx, y: b.y },
    { x: b.x, y: b.y },
  ];
}

/**
 * The return path of a loop, routed in its own lane under the room it closes in
 * (`returnBands`) or under the diagram when it closes across rooms. A howl is
 * the normal input here, so the edge that closes it deserves to be the one edge
 * you cannot miss — which it is not while six of them descend on one line.
 */
function routeBack(a: Anchor, b: Anchor, lane: number, out: number, into: number): Point[] {
  const ax = a.side === "right" ? a.x + out : a.x - out;
  const bx = b.side === "left" ? b.x - into : b.x + into;
  return [
    { x: a.x, y: a.y },
    { x: ax, y: a.y },
    { x: ax, y: lane },
    { x: bx, y: lane },
    { x: bx, y: b.y },
    { x: b.x, y: b.y },
  ];
}
