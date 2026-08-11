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
    const cancellable = isAecCancellable(graph, resolved, acoustic);
    diagnostics.push({
      ruleId: "remote-echo-acoustic",
      severity: cancellable ? "warn" : "critical",
      message: cancellable
        ? `${describeNode(graph, resolved.id)} は同じ PC の内蔵スピーカーと内蔵マイクだけで回り込んでいます (${describePath(graph, nodeIds)})。会議アプリのエコーキャンセラが消せる範囲なので通常は問題になりませんが、音量を上げると破綻します。`
        : `${describeNode(graph, resolved.id)} の音声がスピーカーからマイクへ回り込んで送信側に戻っています (${describePath(graph, nodeIds)})。ヘッドセットにするか、該当スピーカーを配信専用 (isolated) にしてください。`,
      nodeIds,
      linkIds: linkIdsOf(acoustic),
      cycle: acoustic,
      fixes: isolationFixes(graph, acoustic),
    });
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
 * Is this the echo the conferencing app's own canceller removes?
 *
 * AEC subtracts what the app itself played, out of the device it played it on.
 * That reference exists exactly when the return trip stayed inside this machine
 * — its own built-in speaker, its own built-in mic — and went nowhere else. The
 * moment a mixer or a house PA joins the path the signal has been re-timed and
 * re-mixed, the reference no longer matches, and cancellation fails.
 *
 * Since a built-in transducer became a *port of the machine* (§11.4), ownership
 * is a fact the path states outright rather than something inferred from its
 * shape. The old version counted six nodes and checked their categories,
 * because a cable drawn straight from a join to a speaker node was expressible
 * and proved nothing about who owned that speaker. There is nothing left to
 * infer: every port on the path either belongs to the app or to the machine it
 * runs on, or the path left the machine.
 */
function isAecCancellable(
  graph: BuiltGraph,
  join: ResolvedNode,
  path: readonly GraphEdge[],
): boolean {
  const host = join.node.hostNodeId;
  if (!host) return false;

  for (const edge of path) {
    for (const vertexId of [edge.from, edge.to]) {
      const vertex = graph.vertices.get(vertexId);
      if (vertex?.type !== "port") continue;
      if (vertex.nodeId !== join.id && vertex.nodeId !== host) return false;
    }
  }

  // Into one room and straight back out of the same room.
  const hops = path.filter((edge) => edge.kind === "space");
  if (hops.length !== 2) return false;
  const spaceId = hops[0]?.spaceId;
  if (!spaceId || hops[1]?.spaceId !== spaceId) return false;
  return graph.spaces.get(spaceId)?.kind === "acoustic";
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
