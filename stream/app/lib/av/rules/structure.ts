import type { Diagnostic, Rule } from "../diagnostics";
import { describeNode } from "../diagnostics";
import type { BuiltGraph, ResolvedNode } from "../graph";
import { isPortWired, nodeLabel, portVertexId } from "../graph";
import { isTemplate } from "../ports";
import { spaceNeedOf } from "../types";

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
      case "no-device-reference":
        diagnostics.push({
          ruleId: UNKNOWN_REFERENCE,
          severity: "error",
          message: "機材も型番も指定されていません。",
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
      case "unknown-port-template":
        diagnostics.push({
          ruleId: UNKNOWN_REFERENCE,
          severity: "error",
          message: `型番が持たないソース種別を参照しています (${issue.template})。`,
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
      // Since assignments moved onto the node, out→out is no longer the one
      // legal exception here — it is a device selection written the old way,
      // and the fix is to delete the link and assign the jack.
      case "bad-link-direction":
        diagnostics.push({
          ruleId: "link-direction",
          severity: "error",
          message:
            "結線の向きが不正です。出力端子から入力端子へ接続してください。アプリが PC の端子を使う設定は結線ではなく、割り当てです。",
          nodeIds: [],
          linkIds: [issue.linkId],
          fixes: [{ kind: "remove-link", linkId: issue.linkId }],
        });
        break;
      case "assignment-without-host":
        diagnostics.push({
          ruleId: UNKNOWN_REFERENCE,
          severity: "error",
          message: "どの PC で動いているか決まっていないまま、端子が割り当てられています。",
          nodeIds: [issue.nodeId],
          linkIds: [],
        });
        break;
      case "unknown-assignment-port":
        diagnostics.push({
          ruleId: UNKNOWN_REFERENCE,
          severity: "error",
          message: `割り当てが存在しない端子を参照しています (${issue.portKey})。`,
          nodeIds: [issue.nodeId],
          linkIds: [],
        });
        break;
      case "bad-assignment-direction":
        diagnostics.push({
          ruleId: "link-direction",
          severity: "error",
          message: `割り当ての入出力が揃っていません (${issue.portKey})。アプリの入力には PC の入力を、出力には出力を選んでください。`,
          nodeIds: [issue.nodeId],
          linkIds: [],
        });
        break;
      case "assignment-media-mismatch":
        diagnostics.push({
          ruleId: "signal-mismatch",
          severity: "error",
          message: `音声端子と映像端子など、成立しない信号種別を割り当てています (${issue.portKey})。`,
          nodeIds: [issue.nodeId],
          linkIds: [],
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
      // A software node references a model, not a unit in the ledger, so event
      // membership is not a question that can be asked of it.
      if (!resolved.device) continue;
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

  // A jack that faces a space but reaches none.
  //
  // Since coupling moved onto the port (§11.4) this one warning covers what
  // used to be two: 所在 left blank, and 所在 pointing at a room that has no
  // space of this jack's medium — a mic in a place that only has a screen.
  // Both end the same way, with no space edge and howling undetectable, so the
  // old `space-kind-mismatch` error is not expressible any more and does not
  // need to be.
  const coupledNodes = new Set<string>();
  for (const edge of graph.edges) {
    if (edge.kind === "space" && edge.nodeId) coupledNodes.add(edge.nodeId);
  }

  for (const resolved of graph.nodes.values()) {
    if (resolved.node.coupling === "isolated") continue;
    if (coupledNodes.has(resolved.id)) continue;
    // A 所在 naming a space that does not exist is already an error above, and
    // saying it a second way would only bury it.
    if (resolved.node.spaceId && !graph.spaces.has(resolved.node.spaceId)) continue;

    const facing = [...resolved.ports.values()].filter((port) => port.couples !== null);
    if (facing.length === 0) continue;
    const need = spaceNeedOf(resolved.model.category);
    if (need === "never") continue;
    if (need === "when-wired" && !facing.some((port) => isPortWired(graph, resolved.id, port))) {
      continue;
    }

    diagnostics.push({
      ruleId: "space-unassigned",
      severity: "warn",
      message: `${nodeLabel(resolved)} がどの空間にも割り当てられていません。空間が分からないとハウリングを検出できません。`,
      nodeIds: [resolved.id],
      linkIds: [],
      fixes: [{ kind: "assign-space", nodeId: resolved.id }],
    });
  }

  // A machine is used by the apps it runs, so neither end of that relationship
  // is a candidate for `unreachable-device`. §10.4 made the machine the unit
  // the layout ranks; the linter has to say the same thing, because "this PC is
  // on no signal path" is never the finding worth reporting — a laptop is
  // carried in to run something, and what is actually missing is which of its
  // jacks that something uses. `software-io-unassigned` below says that, and
  // saying it twice helps nobody.
  const machines = new Set<string>();
  for (const resolved of graph.nodes.values()) {
    const host = resolved.node.hostNodeId;
    if (host && graph.nodes.has(host)) machines.add(host);
  }

  for (const resolved of graph.nodes.values()) {
    if (machines.has(resolved.id)) continue;
    const host = resolved.node.hostNodeId;
    if (host && graph.nodes.has(host)) continue;
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

  // An app that has selected no input or output device at all.
  //
  // The reachability check above cannot find this one: a join sitting in a
  // meeting carries the transport space's edges on both faces, so it always
  // looks touched. `isPortWired` counts cables and device selections only,
  // which is the distinction §9.10 drew for exactly this reason.
  //
  // Until the selection is written down there is no path from the room into the
  // meeting, and §9.1 — the presenter's own laptop sending the room back — is
  // invisible to every rule in this file.
  for (const resolved of graph.nodes.values()) {
    const hostId = resolved.node.hostNodeId;
    if (!hostId) continue;
    const host = graph.nodes.get(hostId);
    if (!host) continue;
    if ([...resolved.ports.values()].some((port) => isPortWired(graph, resolved.id, port)))
      continue;
    diagnostics.push({
      ruleId: "software-io-unassigned",
      severity: "info",
      message: `${nodeLabel(resolved)} が ${nodeLabel(host)} のどの端子も使っていません。使う入力・出力デバイスを割り当ててください。割り当てがないと、会場の音を拾っていても会場へ音を出していても検出できません。`,
      nodeIds: [resolved.id, host.id],
      linkIds: [],
    });
  }

  for (const resolved of graph.nodes.values()) {
    if (!ENDPOINT_CATEGORIES.has(resolved.model.category)) continue;
    const unconnected = [...resolved.ports.values()].filter(
      (port) => !isPortWired(graph, resolved.id, port),
    );
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

  diagnostics.push(...bypassRules(graph));
  diagnostics.push(...sharedStripRules(graph));

  return diagnostics;
};

/**
 * Two things arriving at one source of a broadcast app.
 *
 * A source is one row of the mixer and a row goes where its matrix cells say,
 * so two feeds sharing an instance can never be sent to different places. §12.1
 * is what that costs: with the hall mics and the meeting on one strip the
 * standard hybrid layout — monitor the meeting into the room, keep the hall mics
 * out of it — cannot be written down at all. Nothing is wrong with the document
 * yet, which is why this is a warning: the damage is done later, on the day
 * somebody turns MONITOR on for that row and the hall goes with it.
 *
 * Scoped to instances of an expandable template, because that is exactly where
 * "make another one" is an operation that exists. A mixer channel is a socket on
 * a box; two cables into it is a different mistake with a different answer, and
 * this rule has nothing to offer for it.
 */
function sharedStripRules(graph: BuiltGraph): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  for (const resolved of graph.nodes.values()) {
    for (const instance of resolved.node.ports ?? []) {
      if (!isTemplate(resolved.model, instance.template)) continue;
      const port = resolved.ports.get(instance.key);
      if (!port || port.direction !== "in") continue;

      // A device selection and a capture both feed a strip, and either can be
      // the second one. Space hops are not feeds — a source hears no room.
      const feeds = (graph.incoming.get(portVertexId(resolved.id, instance.key)) ?? []).filter(
        (edge) => edge.kind === "cable" || edge.kind === "capture" || edge.kind === "host",
      );
      if (feeds.length < 2) continue;

      const senders = new Set<string>();
      const nodeIds = new Set<string>([resolved.id]);
      for (const edge of feeds) {
        const vertex = graph.vertices.get(edge.from);
        if (vertex?.type !== "port") continue;
        senders.add(describeNode(graph, vertex.nodeId));
        nodeIds.add(vertex.nodeId);
      }

      diagnostics.push({
        ruleId: "shared-source-strip",
        severity: "warn",
        message: `${nodeLabel(resolved)} の ${port.label} に ${[...senders].join(
          " / ",
        )} が同時に入っています。ソース 1 つは 1 行なので、このままではどれか 1 つだけをモニターや配信から外すことができません。ソースを分けてください。`,
        nodeIds: [...nodeIds],
        linkIds: feeds
          .map((edge) => edge.linkId)
          .filter((linkId): linkId is string => Boolean(linkId)),
        // The fix moves cables and captures; a strip fed only by device
        // selections is a hand-edited document it could not repair.
        ...(feeds.some((edge) => edge.linkId)
          ? {
              fixes: [
                { kind: "split-source" as const, nodeId: resolved.id, portKey: instance.key },
              ],
            }
          : {}),
      });
    }
  }

  return diagnostics;
}

/**
 * A cable drawn straight into an app, past the machine it runs on.
 *
 * §2.3 says a computer is an internal patchbay: a signal reaches an app by
 * arriving at one of the machine's jacks and being selected there. So
 * `ハンドマイク.out → join.mic_in` describes a cable that does not exist, and
 * the setup it stands for is one where the mic is plugged into something.
 *
 * This became sayable only once the legitimate bypass had a name of its own.
 * OBS taking the Meet window on the same PC touches no jack either, and while
 * both were plain cables the mistake and the correct thing were the same
 * document (§12.4.1, §11.8).
 */
function bypassRules(graph: BuiltGraph): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  for (const edge of graph.edges) {
    if (edge.kind !== "cable" || !edge.linkId) continue;
    const from = endpointOf(graph, edge.from);
    const to = endpointOf(graph, edge.to);
    if (!from || !to) continue;

    // Whichever end is an app that named a machine. A join whose PC nobody
    // wrote down is skipped: there is no machine to bypass, and §9.3 says a
    // document that never mentioned it is finished.
    const app = from.node.hostNodeId ? from : to.node.hostNodeId ? to : null;
    if (!app) continue;
    const other = app === from ? to : from;
    // Two apps on one machine is the capture case, and it is already its own
    // edge kind — but two apps on *different* machines is still a cable that
    // never reaches either one.
    if (other.node.hostNodeId === app.node.hostNodeId) continue;

    const host = graph.nodes.get(app.node.hostNodeId ?? "");
    diagnostics.push({
      ruleId: "cable-bypasses-host",
      severity: "warn",
      message: `${nodeLabel(other)} が ${nodeLabel(app)} へ直接結線されています。アプリが受け取れるのは${
        host ? ` ${nodeLabel(host)} ` : "動かしている PC "
      }の端子に届いた信号だけなので、ケーブルの行き先をその PC にして、アプリ側は割り当てで選んでください。`,
      nodeIds: [other.id, app.id],
      linkIds: [edge.linkId],
      fixes: [{ kind: "remove-link", linkId: edge.linkId }],
    });
  }

  return diagnostics;
}

function endpointOf(graph: BuiltGraph, vertexId: string): ResolvedNode | null {
  const vertex = graph.vertices.get(vertexId);
  return vertex?.type === "port" ? (graph.nodes.get(vertex.nodeId) ?? null) : null;
}
