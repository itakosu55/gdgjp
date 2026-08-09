import type { Fix } from "./diagnostics";
import { isTemplate, sourceGroup } from "./ports";
import type {
  NodePort,
  PortRef,
  SetupDoc,
  SetupLink,
  SetupNode,
  SetupRoute,
  Space,
} from "./schema";
import type { DeviceModel } from "./types";

/**
 * Every edit to a setup is one of these, applied purely.
 *
 * Keeping mutation out of the routes matters more than it looks: the AI phase
 * needs exactly this — take a document, apply a proposed change, re-lint — and
 * `applyFix` below is already that loop's inner step.
 */
export type SetupOperation =
  | { kind: "add-space"; space: Space }
  | { kind: "remove-space"; spaceId: string }
  | { kind: "add-node"; node: SetupNode; routes: SetupRoute[] }
  // Repointing a node at different gear is not an edit anyone makes, and while
  // `deviceId` was mandatory it was structurally impossible. Now that both
  // references are optional, excluding them here is what stops `clean` from
  // producing a node that names neither.
  | {
      kind: "update-node";
      nodeId: string;
      patch: Partial<Omit<SetupNode, "id" | "deviceId" | "modelId">>;
    }
  | { kind: "remove-node"; nodeId: string }
  // A source is a row of a broadcast app's mixer, and its count belongs to the
  // setup rather than the model (§12.3). `ports` is a list because a browser
  // source is a picture and a sound added in one act.
  | { kind: "add-source"; nodeId: string; ports: NodePort[]; routes: SetupRoute[] }
  | { kind: "remove-source"; nodeId: string; portKey: string }
  | { kind: "rename-source"; nodeId: string; portKey: string; label: string }
  | { kind: "add-link"; link: SetupLink }
  | { kind: "remove-link"; linkId: string }
  | { kind: "toggle-route"; nodeId: string; inPort: string; bus: string }
  | { kind: "set-notes"; notes: string };

export function applyOperation(doc: SetupDoc, op: SetupOperation): SetupDoc {
  switch (op.kind) {
    case "add-space":
      return { ...doc, spaces: [...doc.spaces, op.space] };

    case "remove-space":
      return {
        ...doc,
        spaces: doc.spaces.filter((space) => space.id !== op.spaceId),
        // Leaving a stale spaceId behind would surface as `unknown-reference`
        // noise rather than the `space-unassigned` warning that actually
        // describes the situation.
        nodes: doc.nodes.map((node) =>
          node.spaceId === op.spaceId ? omit(node, "spaceId") : node,
        ),
      };

    case "add-node":
      return {
        ...doc,
        nodes: [...doc.nodes, op.node],
        routing: [...doc.routing, ...op.routes],
      };

    case "update-node":
      return {
        ...doc,
        nodes: doc.nodes.map((node) =>
          node.id === op.nodeId ? clean({ ...node, ...op.patch }) : node,
        ),
      };

    case "remove-node":
      return removeNodes(doc, collectNodeAndHosted(doc, op.nodeId));

    case "add-source":
      if (op.ports.length === 0) return doc;
      return {
        ...doc,
        nodes: doc.nodes.map((node) =>
          node.id === op.nodeId ? { ...node, ports: [...(node.ports ?? []), ...op.ports] } : node,
        ),
        routing: [...doc.routing, ...op.routes],
      };

    case "remove-source": {
      const node = doc.nodes.find((entry) => entry.id === op.nodeId);
      if (!node) return doc;
      const removing = new Set(sourceGroup(node, op.portKey));
      if (removing.size === 0) return doc;
      const touches = (ref: PortRef) => ref[0] === op.nodeId && removing.has(ref[1]);
      return {
        ...doc,
        nodes: doc.nodes.map((entry) =>
          entry.id === op.nodeId
            ? clean({
                ...entry,
                ports: (entry.ports ?? []).filter((port) => !removing.has(port.key)),
              })
            : entry,
        ),
        // A deleted source takes its cables and its matrix row with it, the
        // cascade `remove-node` already performs. Leaving either behind would
        // turn into `unknown-reference` noise about a jack nobody can see.
        links: doc.links.filter((link) => !touches(link.from) && !touches(link.to)),
        routing: doc.routing.filter(
          (route) => !(route.nodeId === op.nodeId && removing.has(route.inPort)),
        ),
      };
    }

    case "rename-source": {
      const node = doc.nodes.find((entry) => entry.id === op.nodeId);
      if (!node) return doc;
      const renaming = new Set(sourceGroup(node, op.portKey));
      return {
        ...doc,
        nodes: doc.nodes.map((entry) =>
          entry.id === op.nodeId
            ? {
                ...entry,
                ports: (entry.ports ?? []).map((port) =>
                  renaming.has(port.key)
                    ? op.label
                      ? { ...port, label: op.label }
                      : omit(port, "label")
                    : port,
                ),
              }
            : entry,
        ),
      };
    }

    case "add-link":
      return { ...doc, links: [...doc.links, op.link] };

    case "remove-link":
      return { ...doc, links: doc.links.filter((link) => link.id !== op.linkId) };

    case "toggle-route": {
      const exists = doc.routing.some(
        (route) => route.nodeId === op.nodeId && route.inPort === op.inPort && route.bus === op.bus,
      );
      return {
        ...doc,
        routing: exists
          ? doc.routing.filter(
              (route) =>
                !(route.nodeId === op.nodeId && route.inPort === op.inPort && route.bus === op.bus),
            )
          : [...doc.routing, { nodeId: op.nodeId, inPort: op.inPort, bus: op.bus }],
      };
    }

    case "set-notes":
      return op.notes ? { ...doc, notes: op.notes } : omit(doc, "notes");
  }
}

/** Removing a computer removes the software running on it. */
function collectNodeAndHosted(doc: SetupDoc, nodeId: string): Set<string> {
  const removing = new Set([nodeId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of doc.nodes) {
      if (node.hostNodeId && removing.has(node.hostNodeId) && !removing.has(node.id)) {
        removing.add(node.id);
        changed = true;
      }
    }
  }
  return removing;
}

function removeNodes(doc: SetupDoc, removing: Set<string>): SetupDoc {
  return {
    ...doc,
    nodes: doc.nodes.filter((node) => !removing.has(node.id)),
    links: doc.links.filter((link) => !removing.has(link.from[0]) && !removing.has(link.to[0])),
    routing: doc.routing.filter((route) => !removing.has(route.nodeId)),
  };
}

/**
 * The matrix a node starts with — the model's template, copied in. From then on
 * the document is authoritative and the template is never consulted again.
 */
export function defaultRoutesFor(
  nodeId: string,
  model: DeviceModel,
  ports: readonly NodePort[] = [],
): SetupRoute[] {
  if (model.internalRouting !== "matrix") return [];
  const fixed = model.defaultRoutes
    .filter((route) => !isTemplate(model, route.inPort))
    .map((route) => ({ nodeId, inPort: route.inPort, bus: route.bus }));
  return [...fixed, ...sourceRoutes(nodeId, model, ports)];
}

/**
 * The cells a set of freshly created sources starts with.
 *
 * A default route naming a template means "every instance of this begins here",
 * so 音声ソース → PROGRAM has to follow each source as it is added rather than
 * be copied once when the node appears.
 */
export function sourceRoutes(
  nodeId: string,
  model: DeviceModel,
  ports: readonly NodePort[],
): SetupRoute[] {
  return model.defaultRoutes.flatMap((route) =>
    ports
      .filter((port) => port.template === route.inPort)
      .map((port) => ({ nodeId, inPort: port.key, bus: route.bus })),
  );
}

/** Fixes a person (or, later, the AI repair loop) can apply without choosing anything. */
export function canApplyFix(fix: Fix): boolean {
  return fix.kind === "disable-route" || fix.kind === "set-coupling" || fix.kind === "remove-link";
}

export function applyFix(doc: SetupDoc, fix: Fix): SetupDoc {
  switch (fix.kind) {
    case "disable-route":
      return {
        ...doc,
        routing: doc.routing.filter(
          (route) =>
            !(route.nodeId === fix.nodeId && route.inPort === fix.inPort && route.bus === fix.bus),
        ),
      };
    case "set-coupling": {
      if (!fix.portKey) {
        return applyOperation(doc, {
          kind: "update-node",
          nodeId: fix.nodeId,
          patch: { coupling: fix.coupling },
        });
      }
      const node = doc.nodes.find((entry) => entry.id === fix.nodeId);
      if (!node) return doc;
      const isolated = node.isolatedPorts ?? [];
      if (isolated.includes(fix.portKey)) return doc;
      return applyOperation(doc, {
        kind: "update-node",
        nodeId: fix.nodeId,
        patch: { isolatedPorts: [...isolated, fix.portKey] },
      });
    }
    case "remove-link":
      return applyOperation(doc, { kind: "remove-link", linkId: fix.linkId });
    // `assign-space` and `add-device` need a human to pick which space or which
    // piece of gear, so they are surfaced as guidance rather than applied.
    case "assign-space":
    case "add-device":
      return doc;
  }
}

function omit<T extends object, K extends keyof T>(value: T, key: K): Omit<T, K> {
  const { [key]: _dropped, ...rest } = value;
  return rest;
}

/** Drops keys an update set to undefined so the document stays free of nulls. */
function clean(node: SetupNode): SetupNode {
  const result: SetupNode = { id: node.id };
  if (node.deviceId) result.deviceId = node.deviceId;
  if (node.modelId) result.modelId = node.modelId;
  if (node.label) result.label = node.label;
  if (node.spaceId) result.spaceId = node.spaceId;
  if (node.coupling) result.coupling = node.coupling;
  if (node.isolatedPorts?.length) result.isolatedPorts = node.isolatedPorts;
  if (node.ports?.length) result.ports = node.ports;
  if (node.hostNodeId) result.hostNodeId = node.hostNodeId;
  return result;
}
