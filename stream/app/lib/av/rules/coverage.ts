import type { Diagnostic, Rule } from "../diagnostics";
import type { BuiltGraph } from "../graph";
import { nodeLabel, portVertices } from "../graph";
import { reachableFrom } from "../paths";
import type { DeviceCategory, Medium } from "../types";

/** Does the signal that must reach the stream actually get there? */
export const coverageRules: Rule = (graph) => {
  const diagnostics: Diagnostic[] = [];

  for (const node of nodesOf(graph, "blackbox")) {
    diagnostics.push({
      ruleId: "blackbox-assumption",
      severity: "warn",
      message: `${nodeLabel(node)} は内部が不明なため、全入力が全出力に流れるものとして検査しています。当日に会場で実際の内部ルーティングを確認してください。`,
      nodeIds: [node.id],
      linkIds: [],
    });
  }

  // The remaining rules all ask "does this reach the stream?", which is only a
  // question worth asking once something is streaming.
  const broadcast = nodesOf(graph, "software_broadcast");
  if (broadcast.length === 0) return diagnostics;

  const mics = nodesOf(graph, "mic");
  const cameras = nodesOf(graph, "camera");

  const audioReach = reachFrom(graph, mics, "audio");
  const videoReach = reachFrom(graph, cameras, "video");

  for (const node of broadcast) {
    const audioInputs = portVertices(node, "in", "audio");
    if (audioInputs.length > 0 && !audioInputs.some((vertex) => audioReach.has(vertex))) {
      diagnostics.push({
        ruleId: "no-audio-to-stream",
        severity: "critical",
        message:
          mics.length === 0
            ? `${nodeLabel(node)} に音声が届いていません。構成にマイクがありません。`
            : `${nodeLabel(node)} にどのマイクの音声も届いていません。配信が無音になります。`,
        nodeIds: [node.id],
        linkIds: [],
        fixes:
          mics.length === 0
            ? [{ kind: "add-device", category: "mic", reason: "配信に乗せる音源がありません" }]
            : undefined,
      });
    }

    const videoInputs = portVertices(node, "in", "video");
    if (
      cameras.length > 0 &&
      videoInputs.length > 0 &&
      !videoInputs.some((vertex) => videoReach.has(vertex))
    ) {
      diagnostics.push({
        ruleId: "video-not-reaching-stream",
        severity: "info",
        message: `${nodeLabel(node)} にカメラ映像が届いていません。`,
        nodeIds: [node.id],
        linkIds: [],
      });
    }
  }

  if (nodesOf(graph, "recorder").length === 0) {
    diagnostics.push({
      ruleId: "no-backup-recording",
      severity: "warn",
      message: "バックアップ収録機がありません。配信が落ちるとアーカイブも失われます。",
      nodeIds: [],
      linkIds: [],
      fixes: [{ kind: "add-device", category: "recorder", reason: "音声のバックアップ収録" }],
    });
  }

  return diagnostics;
};

function nodesOf(graph: BuiltGraph, category: DeviceCategory) {
  return [...graph.nodes.values()].filter((node) => node.model.category === category);
}

function reachFrom(
  graph: BuiltGraph,
  sources: ReturnType<typeof nodesOf>,
  medium: Medium,
): Set<string> {
  const starts = sources.flatMap((node) => portVertices(node, "out", medium));
  return starts.length === 0 ? new Set() : reachableFrom(graph, starts, { medium });
}
