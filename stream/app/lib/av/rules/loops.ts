import type { Diagnostic, Fix, Rule } from "../diagnostics";
import { describePath, routeFixes } from "../diagnostics";
import type { BuiltGraph, GraphEdge } from "../graph";
import { nodeLabel, portVertices } from "../graph";
import { findCycle, findPath, pathNodeIds } from "../paths";

/**
 * Every rule here is one cycle search over the same graph.
 *
 * Howling, the infinite mirror, and a remote participant hearing themselves
 * are the same defect wearing different clothes: signal returns to where it
 * came from. Modelling the room as a graph vertex is what makes them all
 * reachable by a single algorithm.
 *
 * Only one loop is reported per space (and per conferencing app). Loops
 * overlap heavily in practice, so listing them all buries the finding that
 * matters; fix one and re-run.
 */
export const loopRules: Rule = (graph) => {
  const diagnostics: Diagnostic[] = [];

  for (const vertex of graph.vertices.values()) {
    if (vertex.type !== "space") continue;

    if (vertex.kind === "acoustic") {
      const cycle = findCycle(graph, vertex.id, { medium: "audio" });
      if (cycle) diagnostics.push(acousticDiagnostic(graph, vertex.spaceId, cycle));
      continue;
    }

    const cycle = findCycle(graph, vertex.id, { medium: "video" });
    if (!cycle) continue;
    const nodeIds = pathNodeIds(graph, cycle);
    diagnostics.push({
      ruleId: "visual-feedback-loop",
      severity: "warn",
      message: `映像が閉ループになっています (${describePath(graph, nodeIds)})。会場スクリーンをカメラが写し込む無限鏡になります。`,
      nodeIds,
      linkIds: linkIdsOf(cycle),
      spaceIds: [vertex.spaceId],
      cycle,
    });
  }

  for (const resolved of graph.nodes.values()) {
    if (resolved.model.category !== "software_conferencing") continue;

    const outputs = portVertices(resolved, "out", "audio");
    const inputs = new Set(portVertices(resolved, "in", "audio"));
    if (outputs.length === 0 || inputs.size === 0) continue;

    const electrical = findPath(graph, outputs, inputs, { medium: "audio", allowSpaces: false });
    if (electrical) {
      const nodeIds = pathNodeIds(graph, electrical);
      diagnostics.push({
        ruleId: "remote-echo-electrical",
        severity: "critical",
        message: `${nodeLabel(resolved)} が受信した音声が送信側に戻っています (${describePath(graph, nodeIds)})。リモート登壇者に自分の声が遅れて返ります。リモート音声を送出バスから外してください (Mix-Minus)。`,
        nodeIds,
        linkIds: linkIdsOf(electrical),
        cycle: electrical,
        fixes: routeFixes(graph, electrical),
      });
      continue;
    }

    const acoustic = findPath(graph, outputs, inputs, { medium: "audio" });
    if (!acoustic) continue;
    const nodeIds = pathNodeIds(graph, acoustic);
    diagnostics.push({
      ruleId: "remote-echo-acoustic",
      severity: "critical",
      message: `${nodeLabel(resolved)} の音声がスピーカーからマイクへ回り込んで送信側に戻っています (${describePath(graph, nodeIds)})。ヘッドセットにするか、該当スピーカーを配信専用 (isolated) にしてください。`,
      nodeIds,
      linkIds: linkIdsOf(acoustic),
      cycle: acoustic,
      fixes: isolationFixes(graph, nodeIds),
    });
  }

  return diagnostics;
};

function acousticDiagnostic(graph: BuiltGraph, spaceId: string, cycle: GraphEdge[]): Diagnostic {
  const nodeIds = pathNodeIds(graph, cycle);
  const viaBroadcast = nodeIds.some(
    (id) => graph.nodes.get(id)?.model.category === "software_broadcast",
  );
  const fixes: Fix[] = [...routeFixes(graph, cycle), ...isolationFixes(graph, nodeIds)];

  if (viaBroadcast) {
    return {
      ruleId: "stream-monitor-loop",
      severity: "critical",
      message: `配信ソフトのモニター出力が会場に戻り、閉ループになっています (${describePath(graph, nodeIds)})。配信のモニタリングをオフにするか、モニターをヘッドホンに切り替えてください。`,
      nodeIds,
      linkIds: linkIdsOf(cycle),
      spaceIds: [spaceId],
      cycle,
      fixes,
    };
  }

  return {
    ruleId: "acoustic-feedback-loop",
    severity: "critical",
    message: `ハウリングが発生する閉ループがあります (${describePath(graph, nodeIds)})。スピーカーへ送るバスからこのマイクを外すか、マイクをヘッドセットにしてください。`,
    nodeIds,
    linkIds: linkIdsOf(cycle),
    spaceIds: [spaceId],
    cycle,
    fixes,
  };
}

/** Suggest isolating the mics and speakers a loop passes through. */
function isolationFixes(graph: BuiltGraph, nodeIds: readonly string[]): Fix[] {
  const fixes: Fix[] = [];
  for (const id of nodeIds) {
    const category = graph.nodes.get(id)?.model.category;
    if (category !== "mic" && category !== "speaker") continue;
    fixes.push({ kind: "set-coupling", nodeId: id, coupling: "isolated" });
  }
  return fixes;
}

function linkIdsOf(path: readonly GraphEdge[]): string[] {
  const ids: string[] = [];
  for (const edge of path) {
    if (edge.linkId && !ids.includes(edge.linkId)) ids.push(edge.linkId);
  }
  return ids;
}
