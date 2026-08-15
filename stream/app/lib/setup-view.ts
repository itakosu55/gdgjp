import type { Diagnostic, Severity } from "~/lib/av/diagnostics";
import { inPlaceOrder, placeKeyOf } from "~/lib/av/places";
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
  /**
   * The spaces the place covers, air before sight (`inPlaceOrder`); the first
   * one is what the header selects and where the label comes from.
   */
  spaceIds: string[];
};

export function collectPlaces(doc: SetupDoc): Place[] {
  const grouped = new Map<string, Space[]>();
  for (const space of doc.spaces) {
    const key = placeKeyOf(space);
    if (!key) continue;
    const found = grouped.get(key);
    if (found) found.push(space);
    else grouped.set(key, [space]);
  }

  // Rooms keep document order; the spaces inside one do not, so which half of a
  // hall was added first decides neither its caption nor what the header picks.
  return [...grouped].map(([key, spaces]) => {
    const ordered = inPlaceOrder(spaces);
    return {
      key,
      label: ordered[0]?.label ?? key,
      kinds: [...new Set(ordered.map((space) => space.kind))],
      spaceIds: ordered.map((space) => space.id),
    };
  });
}

/** Which place a node stands in, or `null` when it has no room. */
export function placeOfNode(doc: SetupDoc, node: SetupNode): string | null {
  const space = doc.spaces.find((entry) => entry.id === node.spaceId);
  return space ? placeKeyOf(space) : null;
}

export function meetingOfNode(doc: SetupDoc, node: SetupNode): Space | undefined {
  return doc.spaces.find((space) => space.id === node.spaceId && space.kind === "transport");
}

/**
 * The 所在 a node can be given: one entry per room, or the meetings for a join.
 *
 * A meeting is where a join is and a room is where everything else is, and the
 * two are never the alternative to one another. Offering both made "所在" read
 * as a free-form tag, and the nonsense combinations were then something the
 * graph had to report rather than something the form never asked.
 *
 * Rooms and not spaces, because a hall's air and its sightline are one answer
 * to "where is it": every jack of the node finds the space of that place its
 * own medium can reach (§11.4), so either half builds the same graph. Listing
 * both therefore put the same room on screen twice, under one name, as a choice
 * with no consequence — and once a room is added as a room the two entries are
 * not even told apart by their labels. The value stays a space id because
 * `spaceId` names a space; the first of the place's spaces serves, since
 * `inPlaceOrder` fixes which one that is regardless of how the room was typed.
 */
export type LocationOption = { value: string; label: string };

export function locationOptions(doc: SetupDoc, model: DeviceModel | undefined): LocationOption[] {
  if (model?.category === "software_conferencing") {
    return doc.spaces
      .filter((space) => space.kind === "transport")
      .map((space) => ({ value: space.id, label: space.label }));
  }
  return collectPlaces(doc).flatMap((place) => {
    const [first] = place.spaceIds;
    return first ? [{ value: first, label: place.label }] : [];
  });
}

/**
 * Which of those entries the node currently stands on.
 *
 * A node may point at either half of a hall — the graph does not mind, and a
 * document can arrive by paste or from the editor that asked one space at a
 * time — but the list holds one entry per room, valued at the room's first
 * space. Handing the raw `spaceId` to `defaultValue` would leave a node in the
 * sight half matching no option at all, and a select with no matching option
 * shows its first: the room would read as 「（割り当てなし）」, and the next
 * unrelated edit through the same form would make that true.
 */
export function locationValue(doc: SetupDoc, node: SetupNode): string {
  const space = doc.spaces.find((entry) => entry.id === node.spaceId);
  if (!space) return "";
  const key = placeKeyOf(space);
  // A meeting is not a place, so it is offered as itself and stands for itself.
  if (!key) return space.id;
  return collectPlaces(doc).find((place) => place.key === key)?.spaceIds[0] ?? space.id;
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
