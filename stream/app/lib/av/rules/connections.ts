import type { Diagnostic, Rule } from "../diagnostics";
import type { PortVertex } from "../graph";
import { connectorFamily } from "../types";
import type { LevelKind } from "../types";

const LEVEL_LABEL: Record<LevelKind, string> = {
  mic: "マイクレベル",
  line: "ラインレベル",
  instrument: "楽器レベル",
  speaker: "スピーカーレベル",
};

type LevelProblem = { severity: "error" | "warn"; message: string };

function levelProblem(source: LevelKind, sink: LevelKind): LevelProblem | null {
  if (source === sink) return null;
  if (source === "speaker") {
    return {
      severity: "error",
      message: `スピーカー出力を${LEVEL_LABEL[sink]}入力に接続しています。機材が破損します。`,
    };
  }
  if (sink === "speaker") {
    return {
      severity: "error",
      message: `${LEVEL_LABEL[source]}出力をスピーカー入力に接続しています。パワーアンプが必要です。`,
    };
  }
  if (source === "line" && sink === "mic") {
    return {
      severity: "error",
      message: "ライン出力をマイク入力に接続しています。PAD かアッテネーターが必要です。",
    };
  }
  if (source === "mic" && sink === "line") {
    return {
      severity: "error",
      message: "マイク出力をライン入力に接続しています。ゲインが足りずほぼ無音になります。",
    };
  }
  if (source === "instrument") {
    return { severity: "warn", message: "楽器出力を直結しています。DI ボックスを挟んでください。" };
  }
  return null;
}

/** Per-cable checks: level, connector and phantom power. */
export const connectionRules: Rule = (graph) => {
  const diagnostics: Diagnostic[] = [];

  for (const edge of graph.edges) {
    if (edge.kind !== "cable" || !edge.linkId) continue;
    const from = graph.vertices.get(edge.from);
    const to = graph.vertices.get(edge.to);
    if (from?.type !== "port" || to?.type !== "port") continue;

    const nodeIds = [from.nodeId, to.nodeId];
    const linkIds = [edge.linkId];
    pushLevel(diagnostics, from, to, nodeIds, linkIds);
    pushConnector(diagnostics, from, to, nodeIds, linkIds);
    pushPhantom(diagnostics, from, to, nodeIds, linkIds);
  }

  return diagnostics;
};

function pushLevel(
  diagnostics: Diagnostic[],
  from: PortVertex,
  to: PortVertex,
  nodeIds: string[],
  linkIds: string[],
): void {
  const source = from.port.level;
  const sink = to.port.level;
  if (!source || !sink) return;
  const problem = levelProblem(source, sink);
  if (!problem) return;
  diagnostics.push({
    ruleId: "level-mismatch",
    severity: problem.severity,
    message: problem.message,
    nodeIds,
    linkIds,
  });
}

function pushConnector(
  diagnostics: Diagnostic[],
  from: PortVertex,
  to: PortVertex,
  nodeIds: string[],
  linkIds: string[],
): void {
  const sourceFamily = connectorFamily(from.port.connector);
  const sinkFamily = connectorFamily(to.port.connector);
  if (sourceFamily === null || sinkFamily === null) return;
  if (sourceFamily === sinkFamily) return;
  diagnostics.push({
    ruleId: "connector-mismatch",
    severity: "warn",
    message: `${from.port.label} (${from.port.connector}) と ${to.port.label} (${to.port.connector}) はそのままでは接続できません。変換ケーブルを当日の持ち物に加えてください。`,
    nodeIds,
    linkIds,
  });
}

/**
 * Phantom power is checked one hop only: the port the mic is plugged into.
 * That covers the overwhelmingly common case (mic straight into a mixer or
 * interface) without pretending to know whether a passive box in between
 * passes +48V through.
 */
function pushPhantom(
  diagnostics: Diagnostic[],
  from: PortVertex,
  to: PortVertex,
  nodeIds: string[],
  linkIds: string[],
): void {
  if (from.port.phantom === "requires" && to.port.phantom !== "provides") {
    diagnostics.push({
      ruleId: "phantom-missing",
      severity: "error",
      message: `${from.port.label} はファンタム電源が必要ですが、接続先が供給できません。`,
      nodeIds,
      linkIds,
    });
  }
  if (from.port.phantom === "damaged_by" && to.port.phantom === "provides") {
    diagnostics.push({
      ruleId: "phantom-hazard",
      severity: "error",
      message: `${from.port.label} はファンタム電源で破損する可能性があります。接続先チャンネルの +48V がオフになっているか確認してください。`,
      nodeIds,
      linkIds,
    });
  }
}
