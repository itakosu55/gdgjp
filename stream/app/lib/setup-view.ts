import type { Diagnostic, Severity } from "~/lib/av/diagnostics";
import { placeKeyOf } from "~/lib/av/places";
import { resolvePorts } from "~/lib/av/ports";
import type { PortRef, SetupDoc, SetupNode, Space } from "~/lib/av/schema";
import type { DeviceModel, DeviceModelPort, SpaceKind } from "~/lib/av/types";

/**
 * View model for the setup editor.
 *
 * The three panels — the tree, the work surface and the inspector — all show
 * the same document from different angles, so they have to agree on what a node
 * is called, which room it is in and which findings point at it. Deriving that
 * once here is what keeps the tree's grouping identical to the diagram's frames
 * rather than merely similar.
 */

export type NodeInfo = {
  node: SetupNode;
  device: { id: string; name: string } | undefined;
  model: DeviceModel | undefined;
  /**
   * The jacks this node actually has: the model's, with its source templates
   * expanded into the sources the document names (§12.3). Every panel reads
   * this rather than `model.ports`, and it is the same `resolvePorts` the graph
   * calls — one implementation, or the optimistic picture and the saved
   * document disagree about how many rows OBS has.
   */
  ports: DeviceModelPort[];
  label: string;
};

export function buildNodeInfo(
  doc: SetupDoc,
  models: readonly DeviceModel[],
  available: readonly { id: string; name: string; modelId: string }[],
): NodeInfo[] {
  const modelById = new Map(models.map((model) => [model.id, model]));
  const deviceById = new Map(available.map((device) => [device.id, device]));
  return doc.nodes.map((node) => {
    // A software node names a model directly; everything else goes through the
    // ledger. `deviceById` holds only this event's gear, so a node pointing at
    // kit that was not brought still has to render — as its raw id if need be.
    const device = node.deviceId ? deviceById.get(node.deviceId) : undefined;
    const model = device
      ? modelById.get(device.modelId)
      : node.modelId
        ? modelById.get(node.modelId)
        : undefined;
    return {
      node,
      device,
      model,
      ports: model ? resolvePorts(model, node) : [],
      label: node.label ?? device?.name ?? model?.name ?? node.deviceId ?? node.modelId ?? node.id,
    };
  });
}

/**
 * The spaces worth offering as a node's 所在.
 *
 * A meeting is where a join is and a room is where everything else is, and the
 * two are never the alternative to one another. Offering both made "所在" read
 * as a free-form tag, and the nonsense combinations were then something the
 * graph had to report rather than something the form never asked.
 *
 * A room's several spaces are all offered: 所在 is a place, and each of the
 * node's jacks finds the space of that place its own medium can reach (§11.4),
 * so which of a hall's two spaces gets picked here does not change the graph.
 */
export function spacesFor(doc: SetupDoc, model: DeviceModel | undefined): Space[] {
  const wantsMeeting = model?.category === "software_conferencing";
  return doc.spaces.filter((space) =>
    wantsMeeting ? space.kind === "transport" : space.kind !== "transport",
  );
}

/**
 * A room in the tree, keyed exactly as the diagram keys its frames.
 *
 * `placeKeyOf` is the layout's own rule (`venueKey ?? id`, and never a meeting),
 * so a hall whose acoustic and visual spaces share a `venueKey` is one group
 * here for the same reason it is one frame there. Grouping by `spaceId` instead
 * would split that hall in the tree while the picture kept it whole.
 */
export type Place = {
  key: string;
  label: string;
  kinds: SpaceKind[];
  /** The spaces the place covers; the first one is what the header selects. */
  spaceIds: string[];
};

export function collectPlaces(doc: SetupDoc): Place[] {
  const places = new Map<string, Place>();
  for (const space of doc.spaces) {
    const key = placeKeyOf(space);
    if (!key) continue;
    const existing = places.get(key);
    if (existing) {
      if (!existing.kinds.includes(space.kind)) existing.kinds.push(space.kind);
      existing.spaceIds.push(space.id);
      continue;
    }
    places.set(key, { key, label: space.label, kinds: [space.kind], spaceIds: [space.id] });
  }
  return [...places.values()];
}

/** Which place a node stands in, or `null` when it has no room. */
export function placeOfNode(doc: SetupDoc, node: SetupNode): string | null {
  const space = doc.spaces.find((entry) => entry.id === node.spaceId);
  return space ? placeKeyOf(space) : null;
}

export function meetingOfNode(doc: SetupDoc, node: SetupNode): Space | undefined {
  return doc.spaces.find((space) => space.id === node.spaceId && space.kind === "transport");
}

export function describePort(nodeInfo: readonly NodeInfo[], ref: PortRef): string {
  const info = nodeInfo.find((entry) => entry.node.id === ref[0]);
  const port = info?.ports.find((entry) => entry.key === ref[1]);
  return `${info?.label ?? ref[0]} / ${port?.label ?? ref[1]}`;
}

/** Just the jack, for the inspector where the node's own name is the heading. */
export function portLabel(info: NodeInfo | undefined, portKey: string): string {
  return info?.ports.find((entry) => entry.key === portKey)?.label ?? portKey;
}

const SEVERITY_ORDER: Record<Severity, number> = { critical: 0, error: 1, warn: 2, info: 3 };

export function worse(a: Severity | undefined, b: Severity): Severity {
  return a === undefined || SEVERITY_ORDER[b] < SEVERITY_ORDER[a] ? b : a;
}

/**
 * Worst finding per node and per space, for the dots in the tree.
 *
 * The dot is what ties the dock to the tree: a finding names a path, and the
 * tree is where you go to act on one end of it.
 */
export function worstSeverities(diagnostics: readonly Diagnostic[]): {
  byNode: Map<string, Severity>;
  bySpace: Map<string, Severity>;
} {
  const byNode = new Map<string, Severity>();
  const bySpace = new Map<string, Severity>();
  for (const diagnostic of diagnostics) {
    for (const nodeId of diagnostic.nodeIds) {
      byNode.set(nodeId, worse(byNode.get(nodeId), diagnostic.severity));
    }
    for (const spaceId of diagnostic.spaceIds ?? []) {
      bySpace.set(spaceId, worse(bySpace.get(spaceId), diagnostic.severity));
    }
  }
  return { byNode, bySpace };
}
