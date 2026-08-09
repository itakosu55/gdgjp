import type { Diagnostic, Rule } from "../diagnostics";
import { isPortWired, nodeLabel } from "../graph";
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

  return diagnostics;
};
