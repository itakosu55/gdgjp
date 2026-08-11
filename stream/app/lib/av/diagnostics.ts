import type { BuiltGraph, GraphEdge } from "./graph";
import { nodeLabel } from "./graph";
import type { SetupDoc } from "./schema";
import type { Device, DeviceCategory, DeviceModel } from "./types";

export type Severity = "critical" | "error" | "warn" | "info";

/**
 * A machine-applicable repair. Diagnostics carry these so the editor can offer
 * one-click fixes today, and so a future AI proposal can be validated and
 * repaired automatically: generate → lint → apply fixes → lint again.
 */
export type Fix =
  | { kind: "disable-route"; nodeId: string; inPort: string; bus: string }
  /** With `portKey`, mutes that one jack; without, the whole node. */
  | { kind: "set-coupling"; nodeId: string; coupling: "isolated"; portKey?: string }
  | { kind: "assign-space"; nodeId: string }
  | { kind: "remove-link"; linkId: string }
  | { kind: "add-device"; category: DeviceCategory; reason: string }
  | { kind: "declare-reinforced"; spaceId: string };

export type Diagnostic = {
  ruleId: string;
  severity: Severity;
  /** Japanese, written for the person setting the gear up on the day. */
  message: string;
  nodeIds: string[];
  linkIds: string[];
  spaceIds?: string[];
  /** Present on cycle rules: the exact loop, edge by edge. */
  cycle?: GraphEdge[];
  fixes?: Fix[];
};

export type LintContext = {
  models: Map<string, DeviceModel>;
  devices: Map<string, Device>;
  /** Gear actually brought to the event. Omit to skip `device-not-in-event`. */
  eventDeviceIds?: ReadonlySet<string>;
  /**
   * Setups that run at the same time as this one. Always empty today —
   * simultaneous tracks are not modelled yet — but the parameter exists so
   * adding cross-track rules later does not change every rule's signature.
   * See docs/260805_stream_av_designer.md §8.
   */
  siblingSetups?: SetupDoc[];
};

export type Rule = (graph: BuiltGraph, ctx: LintContext) => Diagnostic[];

const SEVERITY_ORDER: Record<Severity, number> = {
  critical: 0,
  error: 1,
  warn: 2,
  info: 3,
};

export function sortDiagnostics(diagnostics: Diagnostic[]): Diagnostic[] {
  return [...diagnostics].sort((a, b) => {
    const bySeverity = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    if (bySeverity !== 0) return bySeverity;
    return a.ruleId.localeCompare(b.ruleId);
  });
}

/**
 * A node's name for a message.
 *
 * Two joins into one meeting are two nodes of the same model, so an unlabelled
 * software node is qualified by the machine it runs on. Without this, the
 * finding that matters most reads "Google Meet → Google Meet" and names neither
 * laptop — and the whole point of the rule is naming the machine that appears
 * on no patch sheet.
 */
export function describeNode(graph: BuiltGraph, nodeId: string): string {
  const resolved = graph.nodes.get(nodeId);
  if (!resolved) return nodeId;
  const label = nodeLabel(resolved);
  if (resolved.node.label) return label;
  const host = resolved.node.hostNodeId;
  const hostNode = host ? graph.nodes.get(host) : undefined;
  return hostNode ? `${label} (${nodeLabel(hostNode)})` : label;
}

/** "登壇者マイク → MG10XU → 配信PC" for use in messages. */
export function describePath(graph: BuiltGraph, nodeIds: readonly string[]): string {
  return nodeIds.map((id) => describeNode(graph, id)).join(" → ");
}

/**
 * Turns the internal routing hops of a path into `disable-route` fixes. These
 * are the cells of the routing matrix whose removal breaks the loop.
 */
export function routeFixes(graph: BuiltGraph, path: readonly GraphEdge[]): Fix[] {
  const fixes: Fix[] = [];
  for (const edge of path) {
    if (edge.kind !== "internal" || !edge.nodeId || !edge.busKey) continue;
    const vertex = graph.vertices.get(edge.from);
    if (vertex?.type !== "port") continue;
    fixes.push({
      kind: "disable-route",
      nodeId: edge.nodeId,
      inPort: vertex.portKey,
      bus: edge.busKey,
    });
  }
  return fixes;
}
