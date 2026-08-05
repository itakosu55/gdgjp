import type { Diagnostic, Rule } from "../diagnostics";
import { nodeLabel, portVertexId } from "../graph";
import { CATEGORY_SPACE_COUPLING } from "../types";

const UNKNOWN_REFERENCE = "unknown-reference";

/** Categories where an unconnected port is a mistake rather than a spare channel. */
const ENDPOINT_CATEGORIES = new Set(["mic", "speaker", "camera", "display", "recorder"]);

/** Referential integrity, event membership and obviously unfinished wiring. */
export const structureRules: Rule = (graph, ctx) => {
  const diagnostics: Diagnostic[] = [];

  for (const issue of graph.issues) {
    switch (issue.kind) {
      case "unknown-device":
        diagnostics.push({
          ruleId: UNKNOWN_REFERENCE,
          severity: "error",
          message: `機材台帳に存在しない機材を参照しています (${issue.deviceId})。`,
          nodeIds: [issue.nodeId],
          linkIds: [],
        });
        break;
      case "unknown-model":
        diagnostics.push({
          ruleId: UNKNOWN_REFERENCE,
          severity: "error",
          message: `型番カタログに存在しない型番を参照しています (${issue.modelId})。`,
          nodeIds: [issue.nodeId],
          linkIds: [],
        });
        break;
      case "unknown-space":
        diagnostics.push({
          ruleId: UNKNOWN_REFERENCE,
          severity: "error",
          message: `存在しない空間に割り当てられています (${issue.spaceId})。`,
          nodeIds: [issue.nodeId],
          linkIds: [],
        });
        break;
      case "unknown-host":
        diagnostics.push({
          ruleId: UNKNOWN_REFERENCE,
          severity: "error",
          message: `ホストに指定された PC が構成にありません (${issue.hostNodeId})。`,
          nodeIds: [issue.nodeId],
          linkIds: [],
        });
        break;
      case "space-kind-mismatch":
        diagnostics.push({
          ruleId: "space-kind-mismatch",
          severity: "error",
          message: "音響機材と視覚空間、あるいはその逆の組み合わせで割り当てられています。",
          nodeIds: [issue.nodeId],
          linkIds: [],
          spaceIds: [issue.spaceId],
        });
        break;
      case "unknown-link-node":
        diagnostics.push({
          ruleId: UNKNOWN_REFERENCE,
          severity: "error",
          message: `結線が存在しないノードを参照しています (${issue.nodeId})。`,
          nodeIds: [],
          linkIds: [issue.linkId],
        });
        break;
      case "unknown-link-port":
        diagnostics.push({
          ruleId: UNKNOWN_REFERENCE,
          severity: "error",
          message: `結線が存在しない端子を参照しています (${issue.nodeId} の ${issue.portKey})。`,
          nodeIds: [issue.nodeId],
          linkIds: [issue.linkId],
        });
        break;
      case "bad-link-direction":
        diagnostics.push({
          ruleId: "link-direction",
          severity: "error",
          message: "結線の向きが不正です。出力端子から入力端子へ接続してください。",
          nodeIds: [],
          linkIds: [issue.linkId],
          fixes: [{ kind: "remove-link", linkId: issue.linkId }],
        });
        break;
      case "link-media-mismatch":
        diagnostics.push({
          ruleId: "signal-mismatch",
          severity: "error",
          message: "音声端子と映像端子など、成立しない信号種別どうしを接続しています。",
          nodeIds: [],
          linkIds: [issue.linkId],
          fixes: [{ kind: "remove-link", linkId: issue.linkId }],
        });
        break;
      case "unknown-route-node":
        diagnostics.push({
          ruleId: UNKNOWN_REFERENCE,
          severity: "error",
          message: `ルーティング設定が存在しないノードを参照しています (${issue.nodeId})。`,
          nodeIds: [],
          linkIds: [],
        });
        break;
      case "unknown-route-port":
        diagnostics.push({
          ruleId: UNKNOWN_REFERENCE,
          severity: "error",
          message: `ルーティング設定が存在しない入力端子を参照しています (${issue.portKey})。`,
          nodeIds: [issue.nodeId],
          linkIds: [],
        });
        break;
      case "unknown-route-bus":
        diagnostics.push({
          ruleId: UNKNOWN_REFERENCE,
          severity: "error",
          message: `ルーティング設定が存在しないバスを参照しています (${issue.busKey})。`,
          nodeIds: [issue.nodeId],
          linkIds: [],
        });
        break;
    }
  }

  if (ctx.eventDeviceIds) {
    for (const resolved of graph.nodes.values()) {
      if (ctx.eventDeviceIds.has(resolved.device.id)) continue;
      diagnostics.push({
        ruleId: "device-not-in-event",
        severity: "error",
        message: `${nodeLabel(resolved)} はこのイベントの利用可能機材に登録されていません。`,
        nodeIds: [resolved.id],
        linkIds: [],
      });
    }
  }

  for (const resolved of graph.nodes.values()) {
    const coupling = CATEGORY_SPACE_COUPLING[resolved.model.category];
    if (!coupling) continue;
    if (resolved.node.coupling === "isolated") continue;
    if (resolved.node.spaceId) continue;
    diagnostics.push({
      ruleId: "space-unassigned",
      severity: "warn",
      message: `${nodeLabel(resolved)} がどの空間にも割り当てられていません。空間が分からないとハウリングを検出できません。`,
      nodeIds: [resolved.id],
      linkIds: [],
      fixes: [{ kind: "assign-space", nodeId: resolved.id }],
    });
  }

  for (const resolved of graph.nodes.values()) {
    const touched = graph.edges.some((edge) => {
      const from = graph.vertices.get(edge.from);
      const to = graph.vertices.get(edge.to);
      return (
        (from?.type === "port" && from.nodeId === resolved.id) ||
        (to?.type === "port" && to.nodeId === resolved.id)
      );
    });
    if (touched) continue;
    diagnostics.push({
      ruleId: "unreachable-device",
      severity: "info",
      message: `${nodeLabel(resolved)} はどの信号経路にも参加していません。`,
      nodeIds: [resolved.id],
      linkIds: [],
    });
  }

  for (const resolved of graph.nodes.values()) {
    if (!ENDPOINT_CATEGORIES.has(resolved.model.category)) continue;
    const unconnected = resolved.model.ports.filter((port) => {
      const vertexId = portVertexId(resolved.id, port.key);
      const edges =
        port.direction === "out"
          ? (graph.outgoing.get(vertexId) ?? [])
          : (graph.incoming.get(vertexId) ?? []);
      return !edges.some((edge) => edge.kind === "cable" || edge.kind === "host");
    });
    if (unconnected.length === 0) continue;
    diagnostics.push({
      ruleId: "dangling-port",
      severity: "info",
      message: `${nodeLabel(resolved)} の ${unconnected
        .map((port) => port.label)
        .join(" / ")} が結線されていません。`,
      nodeIds: [resolved.id],
      linkIds: [],
    });
  }

  return diagnostics;
};
