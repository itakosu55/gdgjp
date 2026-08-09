import type { Fix } from "~/lib/av/diagnostics";
import type { CatalogLookup } from "~/lib/av/graph";
import { orientHostAssignment } from "~/lib/av/graph";
import { applyFix, applyOperation, defaultRoutesFor, sourceRoutes } from "~/lib/av/mutations";
import { initialPorts, newSource, resolvePorts } from "~/lib/av/ports";
import type { PortRef, SetupDoc } from "~/lib/av/schema";
import { safeParseSetupDoc } from "~/lib/av/schema";
import type { DeviceModel, SpaceKind } from "~/lib/av/types";
import { SPACE_KINDS } from "~/lib/av/types";
import { emptyToNull, text } from "~/lib/form";
import { newDocId } from "~/lib/id";

/**
 * What one submitted form does to a setup document.
 *
 * This used to live inside the route's `action`, which was fine while the server
 * was the only thing that knew what an intent meant. The editor now applies the
 * same submission locally so the diagram and the linter react to a click before
 * the round trip lands, and two copies of "what does `toggle-route` do" would
 * drift the moment either changed — the optimistic picture would then disagree
 * with what was actually saved, which is worse than no optimism at all.
 *
 * So it lives here, pure and shared: the action calls it with a catalog read
 * from D1, the browser calls it with the catalog the loader already sent. It
 * sits outside `av/` deliberately, because `FormData` is a detail of this
 * editor and `av/` is the model the CLI and the OBS extension will consume.
 */

/**
 * Deliberately the same shape `buildGraph` and `lint` take, so the editor
 * resolves a `deviceId` exactly once and every consumer agrees. It must hold
 * every unit a node could name rather than only the gear brought to this event:
 * a node pointing at kit left behind has to keep resolving, or
 * `device-not-in-event` degrades into `unknown-reference`.
 */
export type IntentCatalog = CatalogLookup;

export type IntentOutcome =
  | { kind: "doc"; doc: SetupDoc }
  | { kind: "error"; error: string }
  /** Not an edit to the document — the setup row itself. Only the server can. */
  | { kind: "elsewhere" };

/**
 * Intents the browser is allowed to apply before the server answers.
 *
 * Everything that edits the document is here except `replace-doc`: the server
 * is what decides whether pasted text is a valid document at all, and applying
 * it locally would reformat the textarea under whoever is still typing in it.
 */
const OPTIMISTIC = new Set([
  "add-space",
  "remove-space",
  "add-node",
  "update-node",
  "remove-node",
  "add-source",
  "remove-source",
  "rename-source",
  "add-link",
  "add-assignment",
  "remove-link",
  "toggle-route",
  "set-notes",
  "apply-fix",
]);

export function isOptimistic(intent: string): boolean {
  return OPTIMISTIC.has(intent);
}

export function applyIntent(doc: SetupDoc, form: FormData, catalog: IntentCatalog): IntentOutcome {
  const intent = text(form.get("intent"));
  const ok = (next: SetupDoc): IntentOutcome => ({ kind: "doc", doc: next });

  switch (intent) {
    // The setup row, not the document: a name and a soft delete are columns.
    case "rename-setup":
    case "delete-setup":
      return { kind: "elsewhere" };

    case "add-space": {
      const label = text(form.get("label"));
      if (!label) return { kind: "error", error: "空間の名前は必須です。" };
      const requested = text(form.get("kind"));
      const kind: SpaceKind = SPACE_KINDS.includes(requested as SpaceKind)
        ? (requested as SpaceKind)
        : "acoustic";
      return ok(
        applyOperation(doc, {
          kind: "add-space",
          space: {
            id: newDocId(
              "sp",
              doc.spaces.map((space) => space.id),
            ),
            kind,
            label,
            ...(emptyToNull(form.get("venueKey")) ? { venueKey: text(form.get("venueKey")) } : {}),
            ...(emptyToNull(form.get("meetingKey"))
              ? { meetingKey: text(form.get("meetingKey")) }
              : {}),
          },
        }),
      );
    }

    case "remove-space":
      return ok(applyOperation(doc, { kind: "remove-space", spaceId: text(form.get("spaceId")) }));

    case "add-node": {
      // One select, two option groups. `d:` is a unit from the ledger, `m:` is
      // a model referenced directly — software has no physical unit (§9.6).
      const choice = text(form.get("deviceId"));
      if (!choice) return { kind: "error", error: "機材を選んでください。" };

      let reference: { deviceId: string } | { modelId: string };
      let model: DeviceModel | undefined;
      if (choice.startsWith("m:")) {
        const modelId = choice.slice(2);
        model = catalog.models.get(modelId);
        if (!model) return { kind: "error", error: "型番が見つかりません。" };
        reference = { modelId };
      } else {
        const deviceId = choice.startsWith("d:") ? choice.slice(2) : choice;
        const device = catalog.devices.get(deviceId);
        if (!device) return { kind: "error", error: "機材が見つかりません。" };
        model = catalog.models.get(device.modelId);
        reference = { deviceId };
      }

      const nodeId = newDocId(
        "n",
        doc.nodes.map((node) => node.id),
      );
      const hostNodeId = emptyToNull(form.get("hostNodeId"));
      // A broadcast app arrives with one audio source and one video source, the
      // representative setup §12.8 asks for: an OBS whose mixer has no rows at
      // all is not a document anyone would have wanted, and §9.3 forbids
      // charging the ordinary case extra data entry.
      const ports = model ? initialPorts(model) : [];
      return ok(
        applyOperation(doc, {
          kind: "add-node",
          node: {
            id: nodeId,
            ...reference,
            ...(ports.length > 0 ? { ports } : {}),
            ...(hostNodeId ? { hostNodeId } : {}),
          },
          routes: model ? defaultRoutesFor(nodeId, model, ports) : [],
        }),
      );
    }

    case "update-node": {
      const spaceId = emptyToNull(form.get("spaceId"));
      const coupling = text(form.get("coupling"));
      const hostNodeId = emptyToNull(form.get("hostNodeId"));
      return ok(
        applyOperation(doc, {
          kind: "update-node",
          nodeId: text(form.get("nodeId")),
          patch: {
            label: emptyToNull(form.get("label")) ?? undefined,
            spaceId: spaceId ?? undefined,
            coupling: coupling === "isolated" ? "isolated" : undefined,
            hostNodeId: hostNodeId ?? undefined,
            // Unchecked boxes send nothing, so an absent list is indistinguishable
            // from "all cleared" — hence the marker. Without it, a form that never
            // rendered the checkboxes (a node with no jack facing a space) would
            // silently un-mute whatever a fix had muted.
            ...(form.has("isolatedPortsForm")
              ? { isolatedPorts: form.getAll("isolatedPorts").map((value) => text(value)) }
              : {}),
          },
        }),
      );
    }

    case "remove-node":
      return ok(applyOperation(doc, { kind: "remove-node", nodeId: text(form.get("nodeId")) }));

    // A source is a row of a broadcast app's mixer. Adding one is the operation
    // §12.1 showed to be missing: without it the hall mics and the meeting share
    // a single strip, and every fix the linter can offer for the resulting
    // critical makes the event worse.
    case "add-source": {
      const nodeId = text(form.get("nodeId"));
      const node = doc.nodes.find((entry) => entry.id === nodeId);
      if (!node) return { kind: "error", error: "機材が見つかりません。" };
      const model = modelOf(node, catalog);
      if (!model) return { kind: "error", error: "型番が見つかりません。" };

      const ports = newSource(model, node, text(form.get("template")));
      if (ports.length === 0) return { kind: "error", error: "ソースの種別を選んでください。" };
      const label = emptyToNull(form.get("label"));
      const named = label ? ports.map((port) => ({ ...port, label })) : ports;

      return ok(
        applyOperation(doc, {
          kind: "add-source",
          nodeId,
          ports: named,
          routes: sourceRoutes(nodeId, model, named),
        }),
      );
    }

    case "remove-source":
      return ok(
        applyOperation(doc, {
          kind: "remove-source",
          nodeId: text(form.get("nodeId")),
          portKey: text(form.get("portKey")),
        }),
      );

    case "rename-source":
      return ok(
        applyOperation(doc, {
          kind: "rename-source",
          nodeId: text(form.get("nodeId")),
          portKey: text(form.get("portKey")),
          label: text(form.get("label")),
        }),
      );

    case "add-link": {
      const from = splitPortRef(form.get("from"));
      const to = splitPortRef(form.get("to"));
      if (!from || !to) return { kind: "error", error: "接続元と接続先を選んでください。" };
      return ok(
        applyOperation(doc, {
          kind: "add-link",
          link: { id: newLinkId(doc), from, to },
        }),
      );
    }

    // Kept apart from `add-link` on purpose: a device selection is not a cable,
    // and its direction follows from the two ports rather than from the user.
    case "add-assignment": {
      const app = splitPortRef(form.get("app"));
      const host = splitPortRef(form.get("host"));
      if (!app || !host) {
        return { kind: "error", error: "アプリ側と PC 側のポートを選んでください。" };
      }

      const appNode = doc.nodes.find((node) => node.id === app[0]);
      if (!appNode || appNode.hostNodeId !== host[0]) {
        return { kind: "error", error: "選んだ PC は、このアプリのホストではありません。" };
      }

      const appDirection = directionOf(doc, catalog, app);
      const hostDirection = directionOf(doc, catalog, host);
      if (!appDirection || !hostDirection) {
        return { kind: "error", error: "ポートが見つかりません。" };
      }

      const oriented = orientHostAssignment(
        { ref: app, direction: appDirection },
        { ref: host, direction: hostDirection },
      );
      if (!oriented) {
        return {
          kind: "error",
          error:
            "入出力の向きが揃っていません。アプリの入力には PC の入力を、アプリの出力には PC の出力を選んでください。",
        };
      }

      return ok(
        applyOperation(doc, { kind: "add-link", link: { id: newLinkId(doc), ...oriented } }),
      );
    }

    case "remove-link":
      return ok(applyOperation(doc, { kind: "remove-link", linkId: text(form.get("linkId")) }));

    case "toggle-route":
      return ok(
        applyOperation(doc, {
          kind: "toggle-route",
          nodeId: text(form.get("nodeId")),
          inPort: text(form.get("inPort")),
          bus: text(form.get("bus")),
        }),
      );

    case "set-notes":
      return ok(applyOperation(doc, { kind: "set-notes", notes: text(form.get("notes")) }));

    case "apply-fix": {
      let fix: Fix;
      try {
        fix = JSON.parse(text(form.get("fix"))) as Fix;
      } catch {
        return { kind: "error", error: "修正内容を読み取れませんでした。" };
      }
      return ok(applyFix(doc, fix));
    }

    case "replace-doc": {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text(form.get("doc")));
      } catch {
        return { kind: "error", error: "JSON として読み取れません。" };
      }
      const result = safeParseSetupDoc(parsed);
      if (!result.success) {
        return {
          kind: "error",
          error: `スキーマに適合しません: ${result.error.issues[0]?.message ?? ""}`,
        };
      }
      return ok(result.data);
    }

    default:
      return { kind: "error", error: `不明な操作です: ${intent}` };
  }
}

function newLinkId(doc: SetupDoc): string {
  return newDocId(
    "l",
    doc.links.map((link) => link.id),
  );
}

/** Whichever of the two references a node carries, resolved to a model. */
function modelOf(node: SetupDoc["nodes"][number], catalog: IntentCatalog): DeviceModel | undefined {
  const modelId = node.deviceId ? catalog.devices.get(node.deviceId)?.modelId : node.modelId;
  return modelId ? catalog.models.get(modelId) : undefined;
}

/** A port's direction. Resolved, so a source of a broadcast app is found too. */
function directionOf(doc: SetupDoc, catalog: IntentCatalog, ref: PortRef) {
  const node = doc.nodes.find((entry) => entry.id === ref[0]);
  if (!node) return undefined;
  const model = modelOf(node, catalog);
  return model
    ? resolvePorts(model, node).find((port) => port.key === ref[1])?.direction
    : undefined;
}

export function splitPortRef(value: FormDataEntryValue | null): PortRef | null {
  const [nodeId, portKey] = text(value).split("::");
  return nodeId && portKey ? [nodeId, portKey] : null;
}
