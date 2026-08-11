import type { Diagnostic, Fix, Rule } from "../diagnostics";
import { describeNode, describePath, routeFixes } from "../diagnostics";
import type { BuiltGraph, GraphEdge, ResolvedNode } from "../graph";
import { portVertices } from "../graph";
import { findCycle, findPath, pathNodeIds } from "../paths";

/**
 * Every rule here is one cycle search over the same graph.
 *
 * Howling, the infinite mirror, a remote participant hearing themselves, and a
 * presenter's laptop feeding the room back through a second join of the same
 * meeting are the same defect wearing different clothes: signal returns to
 * where it came from. Modelling the room — and the meeting — as a graph vertex
 * is what makes them all reachable by a single algorithm.
 *
 * Only one loop is reported per space. Loops overlap heavily in practice, and
 * a single loop routinely passes through several spaces at once, so listing
 * them all buries the finding that matters; fix one and re-run.
 */
export const loopRules: Rule = (graph) => {
  const diagnostics: Diagnostic[] = [];
  const covered = new Set<string>();

  const claim = (diagnostic: Diagnostic) => {
    for (const spaceId of diagnostic.spaceIds ?? []) covered.add(spaceId);
    diagnostics.push(diagnostic);
  };

  // Pass 1 — rooms and sightlines. A loop that crosses a meeting is reachable
  // from the room it passes through, so it is found here first and the meeting
  // is marked covered along with the room.
  for (const vertex of graph.vertices.values()) {
    if (vertex.type !== "space" || vertex.kind === "transport") continue;
    if (covered.has(vertex.spaceId)) continue;

    const medium = vertex.kind === "acoustic" ? "audio" : "video";
    const cycle = findCycle(graph, vertex.id, { medium });
    if (!cycle) continue;

    claim(
      vertex.kind === "acoustic"
        ? acousticDiagnostic(graph, cycle)
        : visualDiagnostic(graph, cycle),
    );
  }

  // Pass 2 — meetings that no reported cycle already names. This is the loop
  // that never touches a modelled room: two rooms nobody wrote down, joined by
  // a satellite feed closed at both ends.
  for (const space of graph.spaces.values()) {
    if (space.kind !== "transport" || covered.has(space.id)) continue;
    const cycle = transportCycle(graph, space.id);
    if (cycle) claim(transportDiagnostic(graph, cycle));
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
        message: `${describeNode(graph, resolved.id)} が受信した音声が送信側に戻っています (${describePath(graph, nodeIds)})。リモート登壇者に自分の声が遅れて返ります。リモート音声を送出バスから外してください (Mix-Minus)。`,
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
    const hop = roomHop(graph, acoustic);
    const canceller = hop ? aecCanceller(graph, resolved, hop, acoustic) : null;
    diagnostics.push({
      ruleId: "remote-echo-acoustic",
      severity: canceller ? "warn" : "critical",
      message: canceller
        ? `${describeNode(graph, resolved.id)} の音声は ${describeNode(graph, canceller)} の中だけで回り込んでいます (${describePath(graph, nodeIds)})。鳴らしている機材と拾っている機材が同じなので、その機材のエコーキャンセラが消せる範囲ですが、音量を上げると破綻します。`
        : `${describeNode(graph, resolved.id)} の音声がスピーカーからマイクへ回り込んで送信側に戻っています (${describePath(graph, nodeIds)})。ヘッドセットにするか、該当スピーカーを配信専用 (isolated) にしてください。`,
      nodeIds,
      linkIds: linkIdsOf(acoustic),
      cycle: acoustic,
      fixes: isolationFixes(graph, acoustic),
    });

    const stranded = hop ? strandedCanceller(graph, hop) : null;
    if (stranded) {
      diagnostics.push({
        ruleId: "aec-reference-missing",
        severity: "warn",
        message: `${describeNode(graph, stranded.nodeId)} はエコーキャンセラを内蔵していますが、${
          stranded.deaf
            ? "部屋から戻ってくる音がこの機材を通っていません。消すべき音を受け取れません"
            : "部屋へ送り出す音がこの機材を通っていません。自分が鳴らした音を参照できません"
        } (${describePath(graph, nodeIds)})。マイクとスピーカーの両方を ${describeNode(graph, stranded.nodeId)} 経由にしないと、エコーキャンセラは働きません。`,
        nodeIds: [stranded.nodeId],
        linkIds: linkIdsOf(acoustic),
        cycle: acoustic,
      });
    }
  }

  return diagnostics;
};

// A cycle found from a space vertex always re-enters that space, so its own id
// is already in `spaceIdsOf` — along with every other space it crossed, which
// is what `covered` needs.
function acousticDiagnostic(graph: BuiltGraph, cycle: GraphEdge[]): Diagnostic {
  const nodeIds = pathNodeIds(graph, cycle);
  const spaceIds = spaceIdsOf(cycle);
  const meetings = spaceIds.filter((id) => graph.spaces.get(id)?.kind === "transport");

  // Transport wins over broadcast. A loop crossing a meeting is a delayed echo
  // rather than oscillation; the symptom, the message and the fix all differ,
  // and the offending machine is usually a laptop that appears nowhere on the
  // patch sheet.
  if (meetings.length > 0) return transportDiagnostic(graph, cycle);

  const viaBroadcast = nodeIds.some(
    (id) => graph.nodes.get(id)?.model.category === "software_broadcast",
  );
  const fixes: Fix[] = [...routeFixes(graph, cycle), ...isolationFixes(graph, cycle)];

  if (viaBroadcast) {
    return {
      ruleId: "stream-monitor-loop",
      severity: "critical",
      message: `配信ソフトのモニター出力が会場に戻り、閉ループになっています (${describePath(graph, nodeIds)})。配信のモニタリングをオフにするか、モニターをヘッドホンに切り替えてください。`,
      nodeIds,
      linkIds: linkIdsOf(cycle),
      spaceIds,
      cycle,
      fixes,
    };
  }

  // A closed loop is howling's necessary condition, not its sufficient one —
  // that one is loop gain, and §3.5 holds no levels anywhere on purpose, so it
  // is unknowable here in principle. A room that declares it reinforces is a
  // room whose operator has taken the gain on themselves, so the finding stops
  // asserting the outcome and describes the loop instead. Every space on the
  // cycle has to say so: one undeclared room and the claim is not made.
  const isReinforced = (id: string) => graph.spaces.get(id)?.reinforced === true;
  const reinforced = spaceIds.length > 0 && spaceIds.every(isReinforced);

  return {
    ruleId: "acoustic-feedback-loop",
    severity: reinforced ? "warn" : "critical",
    message: reinforced
      ? `音声が閉ループになっています (${describePath(graph, nodeIds)})。この部屋は拡声すると宣言されているため、ハウリングするかどうかはマイクとスピーカーの位置とゲイン次第です。音量を上げると破綻します。`
      : `ハウリングが発生する閉ループがあります (${describePath(graph, nodeIds)})。スピーカーへ送るバスからこのマイクを外すか、マイクをヘッドセットにしてください。`,
    nodeIds,
    linkIds: linkIdsOf(cycle),
    spaceIds,
    cycle,
    // Only rooms that have not declared yet. On a demoted finding this is
    // empty, which is the point: the declaration is not offered to a room that
    // already made it.
    fixes: [
      ...fixes,
      ...spaceIds
        .filter((id) => !isReinforced(id))
        .map((spaceId) => ({ kind: "declare-reinforced" as const, spaceId })),
    ],
  };
}

function visualDiagnostic(graph: BuiltGraph, cycle: GraphEdge[]): Diagnostic {
  const nodeIds = pathNodeIds(graph, cycle);
  return {
    ruleId: "visual-feedback-loop",
    severity: "warn",
    message: `映像が閉ループになっています (${describePath(graph, nodeIds)})。会場スクリーンをカメラが写し込む無限鏡になります。`,
    nodeIds,
    linkIds: linkIdsOf(cycle),
    spaceIds: spaceIdsOf(cycle),
    cycle,
  };
}

/**
 * A loop through a meeting is not howling, it is a delayed echo that becomes
 * howling — and no echo canceller can remove it, because the sound came back
 * through *another* join's speaker and so has no reference signal.
 */
function transportDiagnostic(graph: BuiltGraph, cycle: GraphEdge[]): Diagnostic {
  const nodeIds = pathNodeIds(graph, cycle);
  const spaceIds = spaceIdsOf(cycle);
  const meeting = spaceIds.find((id) => graph.spaces.get(id)?.kind === "transport");
  const label = (meeting && graph.spaces.get(meeting)?.label) ?? "ミーティング";

  return {
    ruleId: "transport-echo-loop",
    severity: "critical",
    message: `${label} を経由して音声が戻る閉ループがあります (${describePath(graph, nodeIds)})。別の join のスピーカーを経由して戻る音は参照信号を持たないため、会議アプリのエコーキャンセラでは消せません。遅延したエコーになり、やがてハウリングします。ミーティングに入っている PC のマイクとスピーカーを切る (isolated) か、その join を退出させてください。`,
    nodeIds,
    linkIds: linkIdsOf(cycle),
    spaceIds,
    cycle,
    fixes: [...routeFixes(graph, cycle), ...isolationFixes(graph, cycle)],
  };
}

/** The first cycle through any sender vertex of one meeting. */
function transportCycle(graph: BuiltGraph, spaceId: string): GraphEdge[] | null {
  for (const vertex of graph.vertices.values()) {
    if (vertex.type !== "space" || vertex.kind !== "transport") continue;
    if (vertex.spaceId !== spaceId) continue;
    const cycle = findCycle(graph, vertex.id, { medium: "audio" });
    if (cycle) return cycle;
  }
  return null;
}

/**
 * Which unit's own canceller removes this echo, if any.
 *
 * AEC subtracts what was played out of what was picked up, so it needs one unit
 * holding both ends of that reference. Two shapes give it one, and only the
 * first is something the wiring proves by itself: the unit that is both faces
 * of the room (§11.3) — a laptop's built-in pair, a speakerphone — with nothing
 * between it and the app, because a mixer or a house PA in between re-times and
 * re-mixes what was played and the reference stops matching. Since a built-in
 * transducer became a *port of the machine* (§11.4), who owns those two jacks
 * is a fact the path states outright; the earlier version counted six nodes and
 * checked their categories, because a cable drawn straight from a join to a
 * speaker node was expressible and proved nothing about who owned that speaker.
 *
 * The second shape the wiring cannot prove. A room DSP owns neither transducer
 * and stands exactly where a plain analog mixer stands, so `echoCancels` on the
 * model is what tells them apart (§13.7). The wiring still decides: the claim
 * counts only for a unit standing on both legs of the room hop, sending into
 * the room and hearing it back, because that is what having a reference means.
 * A model may claim the hardware; it may not claim the installation.
 */
function aecCanceller(
  graph: BuiltGraph,
  join: ResolvedNode,
  hop: RoomHop,
  path: readonly GraphEdge[],
): string | null {
  const host = join.node.hostNodeId;
  if (!host) return null;

  const faces = faceOwner(graph, hop.into);
  if (faces && faces === faceOwner(graph, hop.outOf)) {
    const between = [...nodesTouched(graph, path)].filter(
      (nodeId) => nodeId !== join.id && nodeId !== host && nodeId !== faces,
    );
    if (between.length === 0) return faces;
  }

  for (const nodeId of hop.toRoom) {
    if (!hop.fromRoom.has(nodeId)) continue;
    if (graph.nodes.get(nodeId)?.model.echoCancels) return nodeId;
  }
  return null;
}

/**
 * A unit that says it cancels echo, wired where it cannot.
 *
 * §13.5's condition on any declaration: it has to be able to create findings
 * and not only remove them, or it is a lint-disable with a nicer name. This is
 * the finding `echoCancels` creates. A DSP hearing a room whose PA is fed from
 * somewhere it never sees has nothing to subtract, and a DSP feeding a room it
 * never hears has nothing to subtract it from — the commonest way these rooms
 * are got wrong, and invisible until someone joins the meeting.
 */
function strandedCanceller(
  graph: BuiltGraph,
  hop: RoomHop,
): { nodeId: string; deaf: boolean } | null {
  for (const nodeId of hop.toRoom) {
    if (hop.fromRoom.has(nodeId)) continue;
    if (graph.nodes.get(nodeId)?.model.echoCancels) return { nodeId, deaf: true };
  }
  for (const nodeId of hop.fromRoom) {
    if (hop.toRoom.has(nodeId)) continue;
    if (graph.nodes.get(nodeId)?.model.echoCancels) return { nodeId, deaf: false };
  }
  return null;
}

/** One acoustic room, entered once and left once — the only shape AEC addresses. */
type RoomHop = {
  into: GraphEdge;
  outOf: GraphEdge;
  /** What carries the sound to the room, and what carries it back. */
  toRoom: Set<string>;
  fromRoom: Set<string>;
};

function roomHop(graph: BuiltGraph, path: readonly GraphEdge[]): RoomHop | null {
  const at = path.flatMap((edge, index) => (edge.kind === "space" ? [index] : []));
  const [first, second] = at;
  if (at.length !== 2 || first === undefined || second === undefined) return null;

  const into = path[first];
  const outOf = path[second];
  if (!into || !outOf || !into.spaceId || into.spaceId !== outOf.spaceId) return null;
  if (graph.spaces.get(into.spaceId)?.kind !== "acoustic") return null;

  // The hop edges themselves carry the faces, so each leg keeps its own.
  return {
    into,
    outOf,
    toRoom: nodesTouched(graph, path.slice(0, first + 1)),
    fromRoom: nodesTouched(graph, path.slice(second)),
  };
}

/** The node holding the jack a room hop leaves the cables by, or arrives at. */
function faceOwner(graph: BuiltGraph, hop: GraphEdge): string | null {
  for (const vertexId of [hop.from, hop.to]) {
    const vertex = graph.vertices.get(vertexId);
    if (vertex?.type === "port") return vertex.nodeId;
  }
  return null;
}

/** Every node a stretch of path touches a jack of. */
function nodesTouched(graph: BuiltGraph, edges: readonly GraphEdge[]): Set<string> {
  const ids = new Set<string>();
  for (const edge of edges) {
    for (const vertexId of [edge.from, edge.to]) {
      const vertex = graph.vertices.get(vertexId);
      if (vertex?.type === "port") ids.add(vertex.nodeId);
    }
  }
  return ids;
}

/** Every distinct space a cycle passes through, in traversal order. */
function spaceIdsOf(cycle: readonly GraphEdge[]): string[] {
  const ids: string[] = [];
  for (const edge of cycle) {
    if (edge.kind !== "space" || !edge.spaceId) continue;
    if (!ids.includes(edge.spaceId)) ids.push(edge.spaceId);
  }
  return ids;
}

/**
 * Suggest muting the jacks the loop actually leaves and enters the space by.
 *
 * This used to pick whole nodes by category, which was the only thing it could
 * do while a device coupled as a unit. Now that the jack is what couples, the
 * jack is what the fix names — and it has to be: a laptop is one node whose mic
 * and speaker are both on the loop, and "isolate the laptop" would deafen the
 * presenter to fix a mic. What people do on the day is mute the mic and leave
 * the sound on (§11.6), and §4.3 says the offered fix must be that operation.
 *
 * Every jack on the cycle is offered rather than a guess at the right one:
 * which end to cut is the person's decision, and both ends are real.
 */
function isolationFixes(graph: BuiltGraph, cycle: readonly GraphEdge[]): Fix[] {
  const fixes: Fix[] = [];
  const seen = new Set<string>();
  for (const edge of cycle) {
    if (edge.kind !== "space") continue;
    for (const vertexId of [edge.from, edge.to]) {
      const vertex = graph.vertices.get(vertexId);
      if (vertex?.type !== "port") continue;
      const key = `${vertex.nodeId}::${vertex.portKey}`;
      if (seen.has(key)) continue;
      seen.add(key);
      fixes.push({
        kind: "set-coupling",
        nodeId: vertex.nodeId,
        coupling: "isolated",
        portKey: vertex.portKey,
      });
    }
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
