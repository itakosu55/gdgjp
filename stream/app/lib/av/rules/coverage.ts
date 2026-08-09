import type { Diagnostic, Rule } from "../diagnostics";
import type { BuiltGraph, ResolvedNode, VertexId } from "../graph";
import { nodeLabel, portVertexId, portVertices } from "../graph";
import { reachableFrom } from "../paths";
import type { DeviceCategory, Medium, SpaceKind } from "../types";
import { portMedia } from "../types";

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

  diagnostics.push(...audienceRules(graph, mics, broadcast));

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

/**
 * Three audiences hear an event, and the stream is only one of them.
 *
 * "The video played and only the remote participants heard silence" is one of
 * the commonest hybrid-event accidents there is, and on the graph it is plain:
 * the broadcast PROGRAM never gets back to a join. The room is the same
 * question asked of the acoustic space. Nothing new is needed for either —
 * meetings became vertices in §9, and `reachableFrom` is already a per-medium
 * search (§12.6).
 *
 * Neither finding is critical, because not being heard is frequently the
 * correct answer: keeping the hall mic out of the hall speakers is how howling
 * is avoided. A critical that a correct setup cannot clear would break the
 * "fix one and re-run" loop the dock is built around.
 */
function audienceRules(
  graph: BuiltGraph,
  sources: readonly ResolvedNode[],
  broadcast: readonly ResolvedNode[],
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  // Being on the stream means reaching a PROGRAM output, not merely arriving at
  // the broadcast software: an input routed to no bus goes nowhere at all.
  const program = new Set(broadcast.flatMap((node) => programVertices(node, "audio")));
  if (program.size === 0) return diagnostics;

  const meeting = fedSpaceVertices(graph, "transport", "audio");
  const room = fedSpaceVertices(graph, "acoustic", "audio");
  if (meeting.size === 0 && room.size === 0) return diagnostics;

  for (const source of sources) {
    const starts = portVertices(source, "out", "audio");
    if (starts.length === 0) continue;
    const reach = reachableFrom(graph, starts, { medium: "audio" });
    // A source that reaches no audience at all is `no-audio-to-stream`'s
    // business. Saying the same thing again from a second angle helps nobody,
    // and the useful finding here is the asymmetry between the audiences.
    if (!reaches(program, reach)) continue;

    if (meeting.size > 0 && !reaches(meeting, reach)) {
      diagnostics.push({
        ruleId: "source-not-reaching-remote",
        severity: "warn",
        message: `${nodeLabel(source)} の音は配信には乗っていますが、オンライン会議には送られていません。リモート参加者にだけ聞こえません。`,
        nodeIds: [source.id],
        linkIds: [],
      });
    }

    if (room.size > 0 && !reaches(room, reach)) {
      diagnostics.push({
        ruleId: "source-not-reaching-room",
        severity: "info",
        message: `${nodeLabel(source)} の音は配信には乗っていますが、会場のスピーカーからは出ていません。`,
        nodeIds: [source.id],
        linkIds: [],
      });
    }
  }

  return diagnostics;
}

function reaches(targets: ReadonlySet<VertexId>, reach: ReadonlySet<VertexId>): boolean {
  for (const target of targets) {
    if (reach.has(target)) return true;
  }
  return false;
}

/** A broadcast node's PROGRAM outputs — what the stream actually carries. */
function programVertices(node: ResolvedNode, medium: Medium): VertexId[] {
  const program = new Set(
    node.model.buses.filter((bus) => bus.kind === "main").map((bus) => bus.key),
  );
  return [...node.ports.values()]
    .filter(
      (port) =>
        port.direction === "out" &&
        port.busKey !== null &&
        program.has(port.busKey) &&
        portMedia(port.signal).includes(medium),
    )
    .map((port) => portVertexId(node.id, port.key));
}

/**
 * The space vertices something actually emits into.
 *
 * A room with no speaker in it can never be reached, and a meeting nobody has
 * joined has no vertex at all, so asking whether a sound got there is asking
 * about an audience that does not exist yet. Both cases have to stay silent for
 * the same reason §9.3 gives: an unfinished document must not be charged a
 * warning for what it has not written down yet.
 */
function fedSpaceVertices(graph: BuiltGraph, kind: SpaceKind, medium: Medium): Set<VertexId> {
  const fed = new Set<VertexId>();
  for (const vertex of graph.vertices.values()) {
    if (vertex.type !== "space" || vertex.kind !== kind) continue;
    const incoming = graph.incoming.get(vertex.id) ?? [];
    if (!incoming.some((edge) => edge.media.includes(medium))) continue;
    fed.add(vertex.id);
  }
  return fed;
}

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
