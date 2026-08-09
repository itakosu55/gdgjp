import type { NodePort, SetupNode } from "./schema";
import type { DeviceModel, DeviceModelPort } from "./types";

/**
 * The ports a node actually has.
 *
 * A physical mixer's channel count is a property of its model. A broadcast
 * app's is not: OBS's audio mixer has one strip per source, and the sources are
 * chosen on the day. So the model declares what *kinds* of input exist and the
 * document declares how many and what each one is (§12.2–12.3).
 *
 * Everything but the key and the name is inherited, which is what keeps the
 * catalog the authority on what an OBS is: nothing here can invent a jack the
 * model never declared, the property §3.1 protects for the sake of the AI phase.
 *
 * `graph.resolveNode` and `setup-view.buildNodeInfo` both call this. Two
 * implementations of "which ports does this node have" would drift, and the
 * editor applies the same edit twice — once optimistically, once on the server —
 * so a drift here shows up as the picture disagreeing with what was saved.
 */

const INSTANCE_SEPARATOR = ":";

export function isTemplate(model: DeviceModel, portKey: string): boolean {
  return model.ports.some((port) => port.key === portKey && port.expandable);
}

export function hasTemplates(model: DeviceModel): boolean {
  return model.ports.some((port) => port.expandable);
}

export function resolvePorts(model: DeviceModel, node: SetupNode): DeviceModelPort[] {
  const instances = node.ports ?? [];
  if (instances.length === 0 && !hasTemplates(model)) return model.ports;

  // Fixed keys are claimed up front: a hand-edited document naming an existing
  // jack gets the existing jack rather than a second port that `links` and
  // `routing` could not tell apart.
  const taken = new Set(model.ports.filter((port) => !port.expandable).map((port) => port.key));
  const ports: DeviceModelPort[] = [];

  for (const port of model.ports) {
    if (!port.expandable) {
      ports.push(port);
      continue;
    }
    // Instances stand where their template stood, so the sources read before
    // the outputs the way the mixer window does, and a node's jacks keep one
    // order across the diagram, the matrix and the wiring form.
    for (const instance of instances) {
      if (instance.template !== port.key || taken.has(instance.key)) continue;
      taken.add(instance.key);
      ports.push({
        ...port,
        key: instance.key,
        label: instance.label ?? port.label,
        expandable: false,
      });
    }
  }

  return ports;
}

/** Instances naming a template this model does not declare. */
export function unknownTemplates(model: DeviceModel, node: SetupNode): string[] {
  return (node.ports ?? [])
    .filter((instance) => !isTemplate(model, instance.template))
    .map((instance) => instance.template);
}

/**
 * The sources a node starts with: one of each unpaired template.
 *
 * §9.3 asks that an ordinary setup cost no extra data entry, and an OBS with no
 * audio row at all is not a document anyone would have wanted. Paired templates
 * are left out on purpose — nobody has *a* browser source by default, and one
 * that appears without being asked for is one more thing to delete.
 */
export function initialPorts(model: DeviceModel): NodePort[] {
  return model.ports
    .filter((port) => port.expandable && port.sourceKey === null)
    .map((port) => ({ key: nextKey([], port.key), template: port.key }));
}

/**
 * The instances one "add this source" makes.
 *
 * A browser source is a picture and a sound. They stay two ports, because "the
 * video is on the stream but its audio is not" is the commonest accident there
 * is and one merged port hides it (§12.4) — but they are added in one operation
 * and share one `sourceId`, which is the relationship that was missing.
 */
export function newSource(model: DeviceModel, node: SetupNode, template: string): NodePort[] {
  const port = model.ports.find((entry) => entry.key === template && entry.expandable);
  if (!port) return [];
  const group = port.sourceKey
    ? model.ports.filter((entry) => entry.expandable && entry.sourceKey === port.sourceKey)
    : [port];

  const existing = node.ports ?? [];
  const sourceId = port.sourceKey ? nextSourceId(existing) : undefined;
  return group.map((entry) => ({
    key: nextKey(existing, entry.key),
    template: entry.key,
    ...(sourceId ? { sourceId } : {}),
  }));
}

/**
 * Every instance that belongs to the same source as this one.
 *
 * Deleting or renaming a browser source is one act on one source, not two acts
 * on two ports.
 */
export function sourceGroup(node: SetupNode, portKey: string): string[] {
  const ports = node.ports ?? [];
  const target = ports.find((port) => port.key === portKey);
  if (!target) return [];
  if (!target.sourceId) return [target.key];
  return ports.filter((port) => port.sourceId === target.sourceId).map((port) => port.key);
}

/**
 * `<template>:<n>`, counting from the highest already used.
 *
 * Numbers are never reused, so deleting the middle source leaves a gap. The
 * alternative is renumbering, which means rewriting `links` and `routing` in the
 * same breath — and the document is a single JSON column, so a half-applied
 * renumber is a real way to lose a setup (§12.8).
 */
function nextKey(ports: readonly NodePort[], template: string): string {
  const prefix = `${template}${INSTANCE_SEPARATOR}`;
  let highest = 0;
  for (const port of ports) {
    if (!port.key.startsWith(prefix)) continue;
    const n = Number(port.key.slice(prefix.length));
    if (Number.isInteger(n) && n > highest) highest = n;
  }
  return `${prefix}${highest + 1}`;
}

function nextSourceId(ports: readonly NodePort[]): string {
  let highest = 0;
  for (const port of ports) {
    const n = Number(port.sourceId?.slice(1));
    if (port.sourceId?.startsWith("s") && Number.isInteger(n) && n > highest) highest = n;
  }
  return `s${highest + 1}`;
}
