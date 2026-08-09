import { placeKeyOf } from "./places";
import type { PortRef, SetupDoc, SetupLink, SetupNode, Space } from "./schema";
import type {
  CouplingDirection,
  Device,
  DeviceModel,
  DeviceModelPort,
  Medium,
  PortDirection,
} from "./types";
import { SPACE_MEDIA, portMedia } from "./types";

/**
 * Turns a setup document plus the device catalog into a directed graph.
 *
 * Four kinds of edge feed the same graph, which is what lets one cycle search
 * find howling, remote-participant echo and the infinite mirror:
 *
 * - `cable`    — an explicit link, output port → input port
 * - `host`     — a software node wired to a physical port of the computer it
 *                runs on (OBS's monitor output going to the headphone jack)
 * - `internal` — inside a device, from an input to the outputs of a bus
 * - `space`    — the implicit hop through the room: speaker → air → mic
 */

export type VertexId = string;

export function portVertexId(nodeId: string, portKey: string): VertexId {
  return `port:${nodeId}:${portKey}`;
}

export function spaceVertexId(spaceId: string): VertexId {
  return `space:${spaceId}`;
}

/**
 * A transport space gets one vertex per *sender*, not one vertex.
 *
 * A meeting never returns a join its own audio — that exclusion is the
 * Mix-Minus a conference bridge performs internally — and splitting the vertex
 * is what expresses it. The alternative, a single vertex plus a "do not leave
 * by the join you arrived from" rule, would leak join identity into `paths.ts`,
 * which is a generic breadth-first search that knows nothing about spaces.
 * Here the self-edge simply never exists and the search needs no changes.
 */
export function transportVertexId(spaceId: string, sourceNodeId: string): VertexId {
  return `space:${spaceId}:from:${sourceNodeId}`;
}

export type PortVertex = {
  id: VertexId;
  type: "port";
  nodeId: string;
  portKey: string;
  port: DeviceModelPort;
};

export type SpaceVertex =
  | { id: VertexId; type: "space"; spaceId: string; kind: "acoustic" | "visual" }
  | {
      id: VertexId;
      type: "space";
      spaceId: string;
      kind: "transport";
      /** The join whose signal this vertex carries. See `transportVertexId`. */
      sourceNodeId: string;
    };

export type Vertex = PortVertex | SpaceVertex;

export type EdgeKind = "cable" | "host" | "internal" | "space";

export type GraphEdge = {
  id: string;
  from: VertexId;
  to: VertexId;
  kind: EdgeKind;
  media: Medium[];
  linkId?: string;
  nodeId?: string;
  busKey?: string;
  spaceId?: string;
};

/**
 * Referential problems found while building the graph. The linter turns these
 * into diagnostics; the graph itself just skips what it cannot resolve so the
 * editor keeps working on a half-finished document.
 */
export type ResolutionIssue =
  | { kind: "unknown-device"; nodeId: string; deviceId: string }
  | { kind: "unknown-model"; nodeId: string; modelId: string }
  | { kind: "no-device-reference"; nodeId: string }
  | { kind: "unknown-space"; nodeId: string; spaceId: string }
  | { kind: "unknown-host"; nodeId: string; hostNodeId: string }
  | { kind: "unknown-link-node"; linkId: string; nodeId: string }
  | { kind: "unknown-link-port"; linkId: string; nodeId: string; portKey: string }
  | { kind: "bad-link-direction"; linkId: string }
  | { kind: "link-media-mismatch"; linkId: string }
  | { kind: "unknown-route-node"; nodeId: string }
  | { kind: "unknown-route-port"; nodeId: string; portKey: string }
  | { kind: "unknown-route-bus"; nodeId: string; busKey: string };

export type ResolvedNode = {
  id: string;
  node: SetupNode;
  /**
   * `null` when the node references a model directly. Software is not a
   * physical unit, so it does not belong in the 機材台帳 — see the note on
   * `SetupNode.modelId`.
   */
  device: Device | null;
  model: DeviceModel;
  ports: Map<string, DeviceModelPort>;
};

export type BuiltGraph = {
  doc: SetupDoc;
  nodes: Map<string, ResolvedNode>;
  spaces: Map<string, Space>;
  vertices: Map<VertexId, Vertex>;
  edges: GraphEdge[];
  outgoing: Map<VertexId, GraphEdge[]>;
  incoming: Map<VertexId, GraphEdge[]>;
  issues: ResolutionIssue[];
};

export type CatalogLookup = {
  devices: Map<string, Device>;
  models: Map<string, DeviceModel>;
};

function sharedMedia(a: readonly Medium[], b: readonly Medium[]): Medium[] {
  return a.filter((medium) => b.includes(medium));
}

export function buildGraph(doc: SetupDoc, catalog: CatalogLookup): BuiltGraph {
  const issues: ResolutionIssue[] = [];
  const spaces = new Map(doc.spaces.map((space) => [space.id, space]));
  const nodes = new Map<string, ResolvedNode>();

  for (const node of doc.nodes) {
    const resolved = resolveNode(node, catalog, issues);
    if (resolved) nodes.set(node.id, resolved);
  }

  for (const resolved of nodes.values()) {
    const { spaceId, hostNodeId } = resolved.node;
    if (spaceId && !spaces.has(spaceId)) {
      issues.push({ kind: "unknown-space", nodeId: resolved.id, spaceId });
    }
    if (hostNodeId && !nodes.has(hostNodeId)) {
      issues.push({ kind: "unknown-host", nodeId: resolved.id, hostNodeId });
    }
  }

  // Which jacks actually couple to which space has to be known before the
  // vertices exist, because a transport space has one vertex per join.
  const members = collectSpaceMembers(nodes, spaces);

  const vertices = new Map<VertexId, Vertex>();
  for (const space of spaces.values()) {
    if (space.kind !== "transport") {
      const id = spaceVertexId(space.id);
      vertices.set(id, { id, type: "space", spaceId: space.id, kind: space.kind });
      continue;
    }
    for (const joinId of members.get(space.id)?.keys() ?? []) {
      const id = transportVertexId(space.id, joinId);
      vertices.set(id, {
        id,
        type: "space",
        spaceId: space.id,
        kind: "transport",
        sourceNodeId: joinId,
      });
    }
  }
  for (const resolved of nodes.values()) {
    for (const port of resolved.ports.values()) {
      const id = portVertexId(resolved.id, port.key);
      vertices.set(id, { id, type: "port", nodeId: resolved.id, portKey: port.key, port });
    }
  }

  const edges: GraphEdge[] = [
    ...buildLinkEdges(doc, nodes, issues),
    ...buildInternalEdges(doc, nodes, issues),
    ...buildSpaceEdges(members, spaces),
  ];

  const outgoing = new Map<VertexId, GraphEdge[]>();
  const incoming = new Map<VertexId, GraphEdge[]>();
  for (const edge of edges) {
    const out = outgoing.get(edge.from);
    if (out) out.push(edge);
    else outgoing.set(edge.from, [edge]);
    const into = incoming.get(edge.to);
    if (into) into.push(edge);
    else incoming.set(edge.to, [edge]);
  }

  return { doc, nodes, spaces, vertices, edges, outgoing, incoming, issues };
}

/**
 * A node names either a unit in the ledger or, for software, a model directly.
 * Both roads end at a `DeviceModel`; only the ledger road has a `Device`.
 */
function resolveNode(
  node: SetupNode,
  catalog: CatalogLookup,
  issues: ResolutionIssue[],
): ResolvedNode | null {
  let device: Device | null = null;
  let model: DeviceModel | undefined;

  if (node.deviceId) {
    device = catalog.devices.get(node.deviceId) ?? null;
    if (!device) {
      issues.push({ kind: "unknown-device", nodeId: node.id, deviceId: node.deviceId });
      return null;
    }
    model = catalog.models.get(device.modelId);
    if (!model) {
      issues.push({ kind: "unknown-model", nodeId: node.id, modelId: device.modelId });
      return null;
    }
  } else if (node.modelId) {
    model = catalog.models.get(node.modelId);
    if (!model) {
      issues.push({ kind: "unknown-model", nodeId: node.id, modelId: node.modelId });
      return null;
    }
  } else {
    // The schema rejects this; a document that arrived some other way still has
    // to leave the editor usable.
    issues.push({ kind: "no-device-reference", nodeId: node.id });
    return null;
  }

  return {
    id: node.id,
    node,
    device,
    model,
    ports: new Map(model.ports.map((port) => [port.key, port])),
  };
}

function buildLinkEdges(
  doc: SetupDoc,
  nodes: Map<string, ResolvedNode>,
  issues: ResolutionIssue[],
): GraphEdge[] {
  const edges: GraphEdge[] = [];

  for (const link of doc.links) {
    const [fromNodeId, fromPortKey] = link.from;
    const [toNodeId, toPortKey] = link.to;
    const fromNode = nodes.get(fromNodeId);
    const toNode = nodes.get(toNodeId);
    if (!fromNode) {
      issues.push({ kind: "unknown-link-node", linkId: link.id, nodeId: fromNodeId });
      continue;
    }
    if (!toNode) {
      issues.push({ kind: "unknown-link-node", linkId: link.id, nodeId: toNodeId });
      continue;
    }
    const fromPort = fromNode.ports.get(fromPortKey);
    const toPort = toNode.ports.get(toPortKey);
    if (!fromPort) {
      issues.push({
        kind: "unknown-link-port",
        linkId: link.id,
        nodeId: fromNodeId,
        portKey: fromPortKey,
      });
      continue;
    }
    if (!toPort) {
      issues.push({
        kind: "unknown-link-port",
        linkId: link.id,
        nodeId: toNodeId,
        portKey: toPortKey,
      });
      continue;
    }

    // A cable runs output → input. The two host cases are the exception: from
    // inside a computer, a physical output is a *sink* (the app plays into it)
    // and a physical input is a *source* (the app captures from it). Modelling
    // that is what makes "Meet is playing out of the speakers" visible.
    const softwareToHostOutput =
      fromNode.node.hostNodeId === toNode.id &&
      fromPort.direction === "out" &&
      toPort.direction === "out";
    const hostInputToSoftware =
      toNode.node.hostNodeId === fromNode.id &&
      fromPort.direction === "in" &&
      toPort.direction === "in";
    const isCable = fromPort.direction === "out" && toPort.direction === "in";

    if (!isCable && !softwareToHostOutput && !hostInputToSoftware) {
      issues.push({ kind: "bad-link-direction", linkId: link.id });
      continue;
    }

    const media = sharedMedia(portMedia(fromPort.signal), portMedia(toPort.signal));
    if (media.length === 0) {
      issues.push({ kind: "link-media-mismatch", linkId: link.id });
      continue;
    }

    edges.push({
      id: `link:${link.id}`,
      from: portVertexId(fromNodeId, fromPortKey),
      to: portVertexId(toNodeId, toPortKey),
      kind: isCable ? "cable" : "host",
      media,
      linkId: link.id,
    });
  }

  return edges;
}

function buildInternalEdges(
  doc: SetupDoc,
  nodes: Map<string, ResolvedNode>,
  issues: ResolutionIssue[],
): GraphEdge[] {
  const edges: GraphEdge[] = [];

  for (const route of doc.routing) {
    if (!nodes.has(route.nodeId)) {
      issues.push({ kind: "unknown-route-node", nodeId: route.nodeId });
    }
  }

  for (const resolved of nodes.values()) {
    const { model } = resolved;

    if (model.internalRouting === "matrix") {
      const routes = doc.routing.filter((route) => route.nodeId === resolved.id);
      for (const route of routes) {
        const inPort = resolved.ports.get(route.inPort);
        if (!inPort || inPort.direction !== "in") {
          issues.push({
            kind: "unknown-route-port",
            nodeId: resolved.id,
            portKey: route.inPort,
          });
          continue;
        }
        if (!model.buses.some((bus) => bus.key === route.bus)) {
          issues.push({ kind: "unknown-route-bus", nodeId: resolved.id, busKey: route.bus });
          continue;
        }
        for (const outPort of resolved.ports.values()) {
          if (outPort.direction !== "out" || outPort.busKey !== route.bus) continue;
          const media = sharedMedia(portMedia(inPort.signal), portMedia(outPort.signal));
          if (media.length === 0) continue;
          edges.push({
            id: `route:${resolved.id}:${inPort.key}:${route.bus}:${outPort.key}`,
            from: portVertexId(resolved.id, inPort.key),
            to: portVertexId(resolved.id, outPort.key),
            kind: "internal",
            media,
            nodeId: resolved.id,
            busKey: route.bus,
          });
        }
      }
      continue;
    }

    if (model.internalRouting === "passthrough") {
      for (const inPort of resolved.ports.values()) {
        if (inPort.direction !== "in") continue;
        for (const outPort of resolved.ports.values()) {
          if (outPort.direction !== "out") continue;
          const media = sharedMedia(portMedia(inPort.signal), portMedia(outPort.signal));
          if (media.length === 0) continue;
          edges.push({
            id: `pass:${resolved.id}:${inPort.key}:${outPort.key}`,
            from: portVertexId(resolved.id, inPort.key),
            to: portVertexId(resolved.id, outPort.key),
            kind: "internal",
            media,
            nodeId: resolved.id,
          });
        }
      }
    }
  }

  return edges;
}

/** One jack facing one space, and the media it can actually carry there. */
type PortCoupling = {
  port: DeviceModelPort;
  direction: CouplingDirection;
  media: Medium[];
};

/**
 * The couplings of each space, keyed space id → node id → jacks.
 *
 * Nested rather than flat because a transport space needs both: the jacks, to
 * draw the edges, and the *set of nodes*, because everyone else's send is what
 * arrives at a join.
 */
type SpaceMembers = Map<string, Map<string, PortCoupling[]>>;

/**
 * Which space a jack faces, given the node's 所在.
 *
 * A node names one place, not one space (§11.4). A meeting is not a place, so a
 * join resolves to its transport space directly; everything else resolves
 * through the place, where the port's own medium picks the space — audio finds
 * the air, video finds the sightline. That is what lets one all-in-one terminal
 * be a screen and a mic at once without the document naming two locations.
 */
function spacesForPort(
  node: SetupNode,
  port: DeviceModelPort,
  spaces: Map<string, Space>,
  byPlace: Map<string, Space[]>,
): { space: Space; media: Medium[] }[] {
  if (!node.spaceId) return [];
  const home = spaces.get(node.spaceId);
  if (!home) return [];

  const media = portMedia(port.signal);
  const candidates =
    home.kind === "transport" ? [home] : (byPlace.get(placeKeyOf(home) ?? "") ?? []);

  const found: { space: Space; media: Medium[] }[] = [];
  for (const space of candidates) {
    const shared = sharedMedia(media, SPACE_MEDIA[space.kind]);
    if (shared.length > 0) found.push({ space, media: shared });
  }
  return found;
}

function collectSpaceMembers(
  nodes: Map<string, ResolvedNode>,
  spaces: Map<string, Space>,
): SpaceMembers {
  const byPlace = new Map<string, Space[]>();
  for (const space of spaces.values()) {
    const key = placeKeyOf(space);
    if (!key) continue;
    const list = byPlace.get(key);
    if (list) list.push(space);
    else byPlace.set(key, [space]);
  }

  const members: SpaceMembers = new Map();
  for (const resolved of nodes.values()) {
    if (resolved.node.coupling === "isolated") continue;

    for (const port of resolved.ports.values()) {
      if (!port.couples) continue;
      for (const { space, media } of spacesForPort(resolved.node, port, spaces, byPlace)) {
        let byNode = members.get(space.id);
        if (!byNode) {
          byNode = new Map();
          members.set(space.id, byNode);
        }
        const list = byNode.get(resolved.id);
        const coupling: PortCoupling = { port, direction: port.couples, media };
        if (list) list.push(coupling);
        else byNode.set(resolved.id, [coupling]);
      }
    }
  }

  return members;
}

/**
 * `to_space` before `from_space` per node, so a join's send is laid down before
 * what it receives. The order is only cosmetic to the search, but it is what
 * the existing cycle expectations were written against.
 */
const COUPLING_ORDER: readonly CouplingDirection[] = ["to_space", "from_space"];

function buildSpaceEdges(members: SpaceMembers, spaces: Map<string, Space>): GraphEdge[] {
  const edges: GraphEdge[] = [];

  for (const [spaceId, byNode] of members) {
    const space = spaces.get(spaceId);
    if (!space) continue;

    for (const [nodeId, couplings] of byNode) {
      for (const direction of COUPLING_ORDER) {
        for (const { port, media } of couplings) {
          if (port.couples !== direction) continue;
          const portVertex = portVertexId(nodeId, port.key);

          if (space.kind !== "transport") {
            edges.push(
              direction === "from_space"
                ? {
                    id: `space:${spaceId}:${nodeId}:${port.key}`,
                    from: spaceVertexId(spaceId),
                    to: portVertex,
                    kind: "space",
                    media,
                    nodeId,
                    spaceId,
                  }
                : {
                    id: `space:${nodeId}:${port.key}:${spaceId}`,
                    from: portVertex,
                    to: spaceVertexId(spaceId),
                    kind: "space",
                    media,
                    nodeId,
                    spaceId,
                  },
            );
            continue;
          }

          if (direction === "to_space") {
            // Into the meeting, tagged with who sent it.
            edges.push({
              id: `space:${nodeId}:${port.key}:${spaceId}`,
              from: portVertex,
              to: transportVertexId(spaceId, nodeId),
              kind: "space",
              media,
              nodeId,
              spaceId,
            });
            continue;
          }

          // Out of the meeting: everyone *else*'s send arrives here. The
          // missing self-edge is the bridge's own Mix-Minus.
          for (const otherId of byNode.keys()) {
            if (otherId === nodeId) continue;
            edges.push({
              id: `space:${spaceId}:from:${otherId}:${nodeId}:${port.key}`,
              from: transportVertexId(spaceId, otherId),
              to: portVertex,
              kind: "space",
              media,
              nodeId,
              spaceId,
            });
          }
        }
      }
    }
  }

  return edges;
}

/**
 * Is this link a device selection rather than a cable?
 *
 * `links` carries two relationships that behave nothing alike. A cable runs
 * output → input, physically exists, and someone can unplug it. A link between
 * an app and the computer it runs on is a setting — which device OBS captures
 * from, which device it monitors on — and runs out→out or in→in. The editor
 * has to tell them apart to stop asking people to know that rule.
 */
export function isHostAssignment(doc: SetupDoc, link: SetupLink): boolean {
  const from = doc.nodes.find((node) => node.id === link.from[0]);
  const to = doc.nodes.find((node) => node.id === link.to[0]);
  if (!from || !to) return false;
  return from.hostNodeId === to.id || to.hostNodeId === from.id;
}

/**
 * Orders the two ends of a device selection into a link.
 *
 * An app reading from a jack and an app playing into one are the same
 * relationship pointing opposite ways, and `buildLinkEdges` can only tell them
 * apart once they are oriented. Deriving the order from the port directions is
 * what lets a form ask "which jack does this app use" instead of asking someone
 * to remember that this one case runs out→out.
 */
export function orientHostAssignment(
  app: { ref: PortRef; direction: PortDirection },
  host: { ref: PortRef; direction: PortDirection },
): { from: PortRef; to: PortRef } | null {
  if (app.direction !== host.direction) return null;
  return app.direction === "out"
    ? { from: app.ref, to: host.ref }
    : { from: host.ref, to: app.ref };
}

/** Every port vertex of a node matching `medium` and `direction`. */
export function portVertices(
  resolved: ResolvedNode,
  direction: "in" | "out",
  medium: Medium,
): VertexId[] {
  return [...resolved.ports.values()]
    .filter((port) => port.direction === direction && portMedia(port.signal).includes(medium))
    .map((port) => portVertexId(resolved.id, port.key));
}

export function nodesByCategory(graph: BuiltGraph, category: string): ResolvedNode[] {
  return [...graph.nodes.values()].filter((node) => node.model.category === category);
}

export function nodeLabel(resolved: ResolvedNode): string {
  // `model.name` rather than `describeDevice`, which would read "Google Google
  // Meet" for the seeded catalog entry.
  return resolved.node.label ?? resolved.device?.name ?? resolved.model.name;
}

/**
 * Is a cable or a device selection attached to this port?
 *
 * Space hops deliberately do not count. Every join in a meeting has them on
 * both faces, so counting them would make every join look wired both ways and
 * the diagram's wiring-derived role would be a fixed role again.
 */
export function isPortWired(graph: BuiltGraph, nodeId: string, port: DeviceModelPort): boolean {
  const vertexId = portVertexId(nodeId, port.key);
  const edges =
    port.direction === "out"
      ? (graph.outgoing.get(vertexId) ?? [])
      : (graph.incoming.get(vertexId) ?? []);
  return edges.some((edge) => edge.kind === "cable" || edge.kind === "host");
}
