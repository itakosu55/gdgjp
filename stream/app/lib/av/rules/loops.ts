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
      message: cancellerMessage(graph, resolved, canceller, nodeIds),
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
 * howling. Usually no echo canceller can remove it, because the sound came back
 * through *another* join's speaker and so has no reference signal — but that is
 * a fact about the wiring and not about meetings, so it is asked rather than
 * assumed. A remote guest on their laptop's built-in pair closes this loop with
 * a hop their own join both played and heard, which is the one thing AEC is for
 * (§9.7.4), and calling that uncancellable is a finding correct wiring cannot
 * clear.
 *
 * Any one hop is enough. A loop is broken wherever its gain is broken, so the
 * quantifier is the opposite of `reinforced`'s (§13.4) — that one is a claim
 * made per room, so every room on the cycle has to make it.
 */
function transportDiagnostic(graph: BuiltGraph, cycle: GraphEdge[]): Diagnostic {
  const nodeIds = pathNodeIds(graph, cycle);
  const spaceIds = spaceIdsOf(cycle);
  const meeting = spaceIds.find((id) => graph.spaces.get(id)?.kind === "transport");
  const label = (meeting && graph.spaces.get(meeting)?.label) ?? "ミーティング";

  let canceller: string | null = null;
  for (const hop of acousticHops(graph, cycle)) {
    canceller = selfCancelledHop(graph, cycle, hop);
    if (canceller) break;
  }

  return {
    ruleId: "transport-echo-loop",
    severity: canceller ? "warn" : "critical",
    message: canceller
      ? `${label} を経由して音声が戻る閉ループがありますが、${describeNode(graph, canceller)} が鳴らした音を同じ機材が拾っているので、そのエコーキャンセラは参照信号を持っています (${describePath(graph, nodeIds)})。消えるのはその 1 箇所ぶんで、ループ自体は閉じたままなので、音量を上げると遅延したエコーとして戻ります。`
      : `${label} を経由して音声が戻る閉ループがあります (${describePath(graph, nodeIds)})。別の join のスピーカーを経由して戻る音は参照信号を持たないため、会議アプリのエコーキャンセラでは消せません。遅延したエコーになり、やがてハウリングします。ミーティングに入っている PC のマイクとスピーカーを切る (isolated) か、その join を退出させてください。`,
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
type Canceller = { nodeId: string; shape: "faces" | "declared" };

function aecCanceller(
  graph: BuiltGraph,
  join: ResolvedNode,
  hop: RoomHop,
  path: readonly GraphEdge[],
): Canceller | null {
  const host = join.node.hostNodeId;
  if (!host) return null;

  const owner = selfCancelledHop(graph, path, hop);
  if (owner) return { nodeId: owner, shape: "faces" };

  for (const nodeId of hop.toRoom) {
    // The join stands on both legs by construction — the path starts at its
    // speaker and ends at its microphone — so a conferencing model that claimed
    // `echoCancels` would demote every setup it appeared in, which is the
    // findings-level suppression §13.8 turned down. The join and the machine it
    // runs on are what the first shape judges, under the stricter test.
    if (nodeId === join.id || nodeId === host) continue;
    if (!hop.fromRoom.has(nodeId)) continue;
    if (graph.nodes.get(nodeId)?.model.echoCancels) return { nodeId, shape: "declared" };
  }
  return null;
}

/**
 * The two shapes are two different facts, so they get two different sentences.
 * "Rings out of the same box it is picked up by" is true of a laptop and simply
 * false of a room DSP, which owns neither transducer and is only in a position
 * to subtract because of where it was patched.
 */
function cancellerMessage(
  graph: BuiltGraph,
  join: ResolvedNode,
  canceller: Canceller | null,
  nodeIds: readonly string[],
): string {
  const who = describeNode(graph, join.id);
  const where = describePath(graph, nodeIds);
  if (!canceller) {
    return `${who} の音声がスピーカーからマイクへ回り込んで送信側に戻っています (${where})。ヘッドセットにするか、該当スピーカーを配信専用 (isolated) にしてください。`;
  }
  const unit = describeNode(graph, canceller.nodeId);
  return canceller.shape === "faces"
    ? `${who} の音声は ${unit} の中だけで回り込んでいます (${where})。鳴らしている機材と拾っている機材が同じなので、その機材のエコーキャンセラが消せる範囲ですが、音量を上げると破綻します。`
    : `${who} の音声がスピーカーからマイクへ回り込んでいますが、${unit} が部屋への送出と部屋からの受けの両方に入っています (${where})。${unit} のエコーキャンセラが消せる範囲ですが、音量を上げると破綻します。`;
}

/**
 * The first shape, asked of one room hop rather than of a whole path.
 *
 * Written this way because the same question has to be answerable about a hop
 * sitting in the middle of a transport cycle, where the path enters two rooms
 * and crosses a meeting twice and so is not the `join → room → join` shape at
 * all. Everything the answer depends on is local to the hop: who owns its two
 * faces, and what stands between those faces and the join driving them. So the
 * walk starts at the room and stops at the first conferencing app it meets in
 * either direction — the same join on both sides, or this is somebody else's
 * sound coming back and there is no reference for it.
 */
function selfCancelledHop(
  graph: BuiltGraph,
  path: readonly GraphEdge[],
  hop: AcousticHop,
): string | null {
  const faces = faceOwner(graph, hop.into);
  if (!faces || faces !== faceOwner(graph, hop.outOf)) return null;

  const played = legToJoin(graph, path, hop.at - 1, -1);
  const heard = legToJoin(graph, path, hop.at + 2, 1);
  if (!played || !heard || played.join !== heard.join) return null;

  const host = graph.nodes.get(played.join)?.node.hostNodeId;
  if (!host) return null;

  // A mixer or a house PA in between re-times and re-mixes what was played and
  // the reference stops matching, so nothing may stand here but the join, the
  // machine it runs on, and the unit that is the room's two faces — which is
  // the machine itself for a laptop's built-in pair, and a separate box for a
  // speakerphone hanging off it.
  for (const nodeId of [...played.touched, ...heard.touched]) {
    if (nodeId !== played.join && nodeId !== host && nodeId !== faces) return null;
  }
  return faces;
}

/**
 * Walks away from a room hop until it reaches a conferencing app, collecting
 * what it touched on the way. Wraps around the ends of a cycle, which is where
 * the interesting hop usually sits.
 */
function legToJoin(
  graph: BuiltGraph,
  path: readonly GraphEdge[],
  from: number,
  step: 1 | -1,
): { join: string; touched: Set<string> } | null {
  const closed = isClosed(path);
  const touched = new Set<string>();
  let index = from;

  for (let taken = 0; taken < path.length; taken += 1) {
    if (index < 0 || index >= path.length) {
      if (!closed) return null;
      index = ((index % path.length) + path.length) % path.length;
    }
    const edge = path[index];
    if (!edge) return null;

    const ids = [...nodesTouched(graph, [edge])];
    for (const nodeId of ids) touched.add(nodeId);
    const join = ids.find(
      (nodeId) => graph.nodes.get(nodeId)?.model.category === "software_conferencing",
    );
    if (join) return { join, touched };

    index += step;
  }

  return null;
}

function isClosed(path: readonly GraphEdge[]): boolean {
  const first = path[0];
  const last = path[path.length - 1];
  return path.length > 1 && Boolean(first && last && first.from === last.to);
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

/** One acoustic room, entered and left again. `at` indexes `into` in the path. */
type AcousticHop = { into: GraphEdge; outOf: GraphEdge; at: number };

/** A hop on a one-way path, where the two legs are also whole stretches of it. */
type RoomHop = AcousticHop & {
  /** What carries the sound to the room, and what carries it back. */
  toRoom: Set<string>;
  fromRoom: Set<string>;
};

/**
 * Every acoustic room a path enters and leaves, in traversal order.
 *
 * A hop is two space edges meeting at the room's own vertex — the only shape a
 * space vertex has, since cables end at the air and the air ends at cables.
 * Pairing on that vertex rather than on `spaceId` is what lets a cycle be read
 * exactly like a one-way path, wrap included: a cycle is cut at an arbitrary
 * edge, and the hop straddling the cut is a hop like any other.
 */
function acousticHops(graph: BuiltGraph, path: readonly GraphEdge[]): AcousticHop[] {
  const closed = isClosed(path);
  const hops: AcousticHop[] = [];

  for (let at = 0; at < path.length; at += 1) {
    const into = path[at];
    const outOf = at === path.length - 1 ? (closed ? path[0] : undefined) : path[at + 1];
    if (!into || !outOf) continue;
    if (into.kind !== "space" || outOf.kind !== "space" || into.to !== outOf.from) continue;
    if (!into.spaceId || graph.spaces.get(into.spaceId)?.kind !== "acoustic") continue;
    hops.push({ into, outOf, at });
  }

  return hops;
}

function roomHop(graph: BuiltGraph, path: readonly GraphEdge[]): RoomHop | null {
  const spaceEdges = path.flatMap((edge, index) => (edge.kind === "space" ? [index] : []));
  if (spaceEdges.length !== 2) return null;
  const [hop] = acousticHops(graph, path);
  if (!hop) return null;

  // The hop edges themselves carry the faces, so each leg keeps its own.
  return {
    ...hop,
    toRoom: nodesTouched(graph, path.slice(0, hop.at + 1)),
    fromRoom: nodesTouched(graph, path.slice(hop.at + 1)),
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
