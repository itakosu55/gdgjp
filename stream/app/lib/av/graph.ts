import type { SetupDoc, SetupNode, Space } from "./schema";
import type { Device, DeviceModel, DeviceModelPort, Medium } from "./types";
import { CATEGORY_SPACE_COUPLING, portMedia } from "./types";

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

export type PortVertex = {
  id: VertexId;
  type: "port";
  nodeId: string;
  portKey: string;
  port: DeviceModelPort;
};

export type SpaceVertex = {
  id: VertexId;
  type: "space";
  spaceId: string;
  kind: "acoustic" | "visual";
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
  | { kind: "unknown-space"; nodeId: string; spaceId: string }
  | { kind: "unknown-host"; nodeId: string; hostNodeId: string }
  | { kind: "space-kind-mismatch"; nodeId: string; spaceId: string }
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
  device: Device;
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

function sharedMedia(a: Medium[], b: Medium[]): Medium[] {
  return a.filter((medium) => b.includes(medium));
}

export function buildGraph(doc: SetupDoc, catalog: CatalogLookup): BuiltGraph {
  const issues: ResolutionIssue[] = [];
  const spaces = new Map(doc.spaces.map((space) => [space.id, space]));
  const nodes = new Map<string, ResolvedNode>();

  for (const node of doc.nodes) {
    const device = catalog.devices.get(node.deviceId);
    if (!device) {
      issues.push({ kind: "unknown-device", nodeId: node.id, deviceId: node.deviceId });
      continue;
    }
    const model = catalog.models.get(device.modelId);
    if (!model) {
      issues.push({ kind: "unknown-model", nodeId: node.id, modelId: device.modelId });
      continue;
    }
    nodes.set(node.id, {
      id: node.id,
      node,
      device,
      model,
      ports: new Map(model.ports.map((port) => [port.key, port])),
    });
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

  const vertices = new Map<VertexId, Vertex>();
  for (const space of spaces.values()) {
    const id = spaceVertexId(space.id);
    vertices.set(id, { id, type: "space", spaceId: space.id, kind: space.kind });
  }
  for (const resolved of nodes.values()) {
    for (const port of resolved.model.ports) {
      const id = portVertexId(resolved.id, port.key);
      vertices.set(id, { id, type: "port", nodeId: resolved.id, portKey: port.key, port });
    }
  }

  const edges: GraphEdge[] = [
    ...buildLinkEdges(doc, nodes, issues),
    ...buildInternalEdges(doc, nodes, issues),
    ...buildSpaceEdges(nodes, spaces, issues),
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
        for (const outPort of model.ports) {
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
      for (const inPort of model.ports) {
        if (inPort.direction !== "in") continue;
        for (const outPort of model.ports) {
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

function buildSpaceEdges(
  nodes: Map<string, ResolvedNode>,
  spaces: Map<string, Space>,
  issues: ResolutionIssue[],
): GraphEdge[] {
  const edges: GraphEdge[] = [];

  for (const resolved of nodes.values()) {
    const coupling = CATEGORY_SPACE_COUPLING[resolved.model.category];
    if (!coupling) continue;
    if (resolved.node.coupling === "isolated") continue;

    const spaceId = resolved.node.spaceId;
    if (!spaceId) continue;
    const space = spaces.get(spaceId);
    if (!space) continue;
    if (space.kind !== coupling.spaceKind) {
      issues.push({ kind: "space-kind-mismatch", nodeId: resolved.id, spaceId });
      continue;
    }

    const medium: Medium = space.kind === "acoustic" ? "audio" : "video";
    const wanted = coupling.direction === "from_space" ? "out" : "in";

    for (const port of resolved.model.ports) {
      if (port.direction !== wanted) continue;
      if (!portMedia(port.signal).includes(medium)) continue;
      const portVertex = portVertexId(resolved.id, port.key);
      edges.push(
        coupling.direction === "from_space"
          ? {
              id: `space:${spaceId}:${resolved.id}:${port.key}`,
              from: spaceVertexId(spaceId),
              to: portVertex,
              kind: "space",
              media: [medium],
              nodeId: resolved.id,
              spaceId,
            }
          : {
              id: `space:${resolved.id}:${port.key}:${spaceId}`,
              from: portVertex,
              to: spaceVertexId(spaceId),
              kind: "space",
              media: [medium],
              nodeId: resolved.id,
              spaceId,
            },
      );
    }
  }

  return edges;
}

/** Every port vertex of a node matching `direction` that carries `medium`. */
export function portVertices(
  resolved: ResolvedNode,
  direction: "in" | "out",
  medium: Medium,
): VertexId[] {
  return resolved.model.ports
    .filter((port) => port.direction === direction && portMedia(port.signal).includes(medium))
    .map((port) => portVertexId(resolved.id, port.key));
}

export function nodesByCategory(graph: BuiltGraph, category: string): ResolvedNode[] {
  return [...graph.nodes.values()].filter((node) => node.model.category === category);
}

export function nodeLabel(resolved: ResolvedNode): string {
  return resolved.node.label ?? resolved.device.name;
}
