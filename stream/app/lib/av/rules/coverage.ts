import type { Diagnostic, Rule } from "../diagnostics";
import type { BuiltGraph, ResolvedNode, VertexId } from "../graph";
import { nodeLabel, portVertexId, portVertices } from "../graph";
import { reachableFrom } from "../paths";
import { sourceGroups } from "../ports";
import type { DeviceCategory, DeviceModelPort, Medium, SpaceKind } from "../types";
import { portMedia } from "../types";

/**
 * Somewhere a signal begins.
 *
 * There are two kinds, and every rule in this file has to see the same set of
 * them or they disagree about what the event is carrying: a jack that hears the
 * room, and an input with no upstream at all — a video file, the BGM (§12.5).
 *
 * A list of sources rather than a list of nodes, because one OBS holds several.
 * "The video reached nobody but the stream" is a fact about one row of its
 * mixer, and reporting it against the app would name the wrong thing to fix.
 */
type Source = {
  /** How the finding refers to it: a mic's name, or "OBSのオープニング動画". */
  label: string;
  nodeId: string;
  starts: VertexId[];
};

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

  const audioSources = sourcesOf(graph, "mic", "audio");
  const videoSources = sourcesOf(graph, "camera", "video");

  const audioReach = reachFrom(graph, audioSources, "audio");
  const videoReach = reachFrom(graph, videoSources, "video");

  for (const node of broadcast) {
    const audioInputs = portVertices(node, "in", "audio");
    if (audioInputs.length > 0 && !audioInputs.some((vertex) => audioReach.has(vertex))) {
      diagnostics.push({
        ruleId: "no-audio-to-stream",
        severity: "critical",
        message:
          audioSources.length === 0
            ? `${nodeLabel(node)} に音声が届いていません。構成に音源がありません。`
            : `${nodeLabel(node)} にどの音源の音声も届いていません。配信が無音になります。`,
        nodeIds: [node.id],
        linkIds: [],
        fixes:
          audioSources.length === 0
            ? [{ kind: "add-device", category: "mic", reason: "配信に乗せる音源がありません" }]
            : undefined,
      });
    }

    const videoInputs = portVertices(node, "in", "video");
    if (
      videoSources.length > 0 &&
      videoInputs.length > 0 &&
      !videoInputs.some((vertex) => videoReach.has(vertex))
    ) {
      diagnostics.push({
        ruleId: "video-not-reaching-stream",
        severity: "info",
        message: `${nodeLabel(node)} にどの映像ソースも届いていません。`,
        nodeIds: [node.id],
        linkIds: [],
      });
    }
  }

  diagnostics.push(...audienceRules(graph, audioSources, broadcast));
  diagnostics.push(...partialSourceRules(graph, broadcast));

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
 *
 * That reasoning has one exception, and it is the reason `Space.reinforced`
 * cuts both ways (§13.5). A room that declares it reinforces has said the
 * quiet part out loud — its mics *do* come out of its speakers — so silence in
 * the hall stops being the deliberate choice and starts looking like a missing
 * cable. Still not critical; the declaration raises info to warn and no
 * further, because the room may simply not want *this* source.
 */
function audienceRules(
  graph: BuiltGraph,
  sources: readonly Source[],
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
    const reach = reachableFrom(graph, source.starts, { medium: "audio" });
    // A source that reaches no audience at all is `no-audio-to-stream`'s
    // business. Saying the same thing again from a second angle helps nobody,
    // and the useful finding here is the asymmetry between the audiences.
    if (!reaches(program, reach)) continue;

    if (meeting.size > 0 && !reaches(meeting, reach)) {
      diagnostics.push({
        ruleId: "source-not-reaching-remote",
        severity: "warn",
        message: `${source.label} の音は配信には乗っていますが、オンライン会議には送られていません。リモート参加者にだけ聞こえません。`,
        nodeIds: [source.nodeId],
        linkIds: [],
      });
    }

    if (room.size > 0 && !reaches(room, reach)) {
      // Any one reinforced room the source is missing is enough. `room` is
      // every acoustic space with a speaker in it, and asking `every` would
      // let a single undeclared overflow room silence the question.
      const reinforced = Array.from(room).some((vertexId) => {
        const vertex = graph.vertices.get(vertexId);
        return vertex?.type === "space" && graph.spaces.get(vertex.spaceId)?.reinforced === true;
      });

      diagnostics.push({
        ruleId: "source-not-reaching-room",
        severity: reinforced ? "warn" : "info",
        message: reinforced
          ? `${source.label} の音は配信には乗っていますが、会場のスピーカーからは出ていません。拡声すると宣言された部屋があるので、結線漏れかもしれません。`
          : `${source.label} の音は配信には乗っていますが、会場のスピーカーからは出ていません。`,
        nodeIds: [source.nodeId],
        linkIds: [],
      });
    }
  }

  return diagnostics;
}

/**
 * One source, half of it on the stream.
 *
 * "The picture is there and the sound is not" is the commonest browser-source
 * and screen-share accident there is, and it is the reason §12.4 refused to
 * merge audio and video into one port: a combined port cannot be half wrong.
 * Keeping them apart left the opposite gap, though — nothing said the two ports
 * were one thing — and `sourceKey` / `sourceId` are that missing name.
 *
 * Reaching PROGRAM, not merely being wired: a source row switched off in the
 * matrix is off the stream just as surely as one nothing feeds.
 */
function partialSourceRules(graph: BuiltGraph, broadcast: readonly ResolvedNode[]): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const program: Record<Medium, Set<VertexId>> = {
    audio: new Set(broadcast.flatMap((node) => programVertices(node, "audio"))),
    video: new Set(broadcast.flatMap((node) => programVertices(node, "video"))),
  };
  if (program.audio.size === 0 || program.video.size === 0) return diagnostics;

  for (const node of graph.nodes.values()) {
    for (const group of sourceGroups([...node.ports.values()], node.node)) {
      const half = (medium: Medium) => {
        const ports = group.ports.filter((port) => portMedia(port.signal).includes(medium));
        if (ports.length === 0) return null;
        const starts = ports.map((port) => portVertexId(node.id, port.key));
        return {
          port: ports[0],
          onStream: reaches(program[medium], reachableFrom(graph, starts, { medium })),
        };
      };

      const audio = half("audio");
      const video = half("video");
      // A group with only one medium in it names a feature rather than a pair,
      // and two halves that agree are simply a source somebody chose to leave
      // off the stream.
      if (!audio || !video || audio.onStream === video.onStream) continue;

      const present = audio.onStream ? audio.port : video.port;
      const missing = audio.onStream ? video.port : audio.port;
      diagnostics.push({
        ruleId: "partial-source",
        severity: "warn",
        message: `${nodeLabel(node)} の ${halfLabel(present)} は配信に乗っていますが、${halfLabel(missing)} が乗っていません。`,
        nodeIds: [node.id],
        linkIds: [],
      });
    }
  }

  return diagnostics;
}

/**
 * Names one half of a source unambiguously.
 *
 * An instance's two halves carry the same name — a browser source called "Meet"
 * is "Meet" twice — so the medium has to be said out loud. A catalogued jack
 * usually says it already.
 */
function halfLabel(port: DeviceModelPort): string {
  const medium = portMedia(port.signal).includes("video") ? "映像" : "音声";
  return port.label.includes(medium) ? port.label : `${port.label}の${medium}`;
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

/**
 * Every start of a signal in this medium.
 *
 * `transducer` is the category whose jacks pick the world up — a mic for sound,
 * a camera for pictures. It is one source however many jacks it has, because a
 * stereo pair is one microphone, and because the finding "this mic is not in
 * the room" is about the mic.
 *
 * An `origin` port is one source each. Two videos on one OBS are two things
 * that can separately fail to reach an audience, and the row is what somebody
 * would go and change.
 */
function sourcesOf(graph: BuiltGraph, transducer: DeviceCategory, medium: Medium): Source[] {
  const sources: Source[] = [];

  for (const node of graph.nodes.values()) {
    const ports = [...node.ports.values()].filter((port) =>
      portMedia(port.signal).includes(medium),
    );

    if (node.model.category === transducer) {
      // The coupling, not merely the direction: since §11.2 a mic model may
      // carry jacks that face no room, and only the ones that do are the sound.
      const facing = ports.filter(
        (port) => port.direction === "out" && port.couples === "from_space",
      );
      if (facing.length > 0) {
        sources.push({
          label: nodeLabel(node),
          nodeId: node.id,
          starts: facing.map((port) => portVertexId(node.id, port.key)),
        });
      }
    }

    for (const port of ports) {
      if (!port.origin) continue;
      sources.push({
        label: `${nodeLabel(node)}の${port.label}`,
        nodeId: node.id,
        starts: [portVertexId(node.id, port.key)],
      });
    }
  }

  return sources;
}

function reachFrom(graph: BuiltGraph, sources: readonly Source[], medium: Medium): Set<VertexId> {
  const starts = sources.flatMap((source) => source.starts);
  return starts.length === 0 ? new Set() : reachableFrom(graph, starts, { medium });
}
