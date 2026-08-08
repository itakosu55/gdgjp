import { describe, expect, it } from "vitest";
import { DEVICES, MODELS } from "~/lib/av/fixtures";
import type { SetupDoc } from "~/lib/av/schema";
import type { IntentCatalog } from "~/lib/setup-intents";
import { applyIntent, isOptimistic } from "~/lib/setup-intents";

/**
 * The editor applies these in the browser and the server applies them again on
 * the way to D1, so what they cover is really the claim that both arrive at the
 * same document. Anything asserted here holds on both sides by construction —
 * which is the whole reason the mapping was pulled out of the route.
 */

const catalog: IntentCatalog = {
  models: new Map(MODELS.map((model) => [model.id, model])),
  devices: new Map(DEVICES.map((device) => [device.id, device])),
};

function doc(partial: Partial<SetupDoc> = {}): SetupDoc {
  return { schemaVersion: 1, spaces: [], nodes: [], links: [], routing: [], ...partial };
}

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.append(key, value);
  return data;
}

function applied(base: SetupDoc, fields: Record<string, string>): SetupDoc {
  const outcome = applyIntent(base, form(fields), catalog);
  if (outcome.kind !== "doc") throw new Error(`expected a document, got ${outcome.kind}`);
  return outcome.doc;
}

function failed(base: SetupDoc, fields: Record<string, string>): string {
  const outcome = applyIntent(base, form(fields), catalog);
  if (outcome.kind !== "error") throw new Error(`expected an error, got ${outcome.kind}`);
  return outcome.error;
}

describe("applyIntent", () => {
  it("copies the model's default matrix in when a device is added", () => {
    const mixer = catalog.models.get("m_mixer");
    if (!mixer) throw new Error("fixture missing");
    // A mixer with no routing rows passes no audio, which is correct — so the
    // editor is what pre-fills them from the template as the node goes in.
    const withTemplate: IntentCatalog = {
      devices: catalog.devices,
      models: new Map(catalog.models).set("m_mixer", {
        ...mixer,
        defaultRoutes: [{ inPort: "ch1", bus: "main" }],
      }),
    };

    const outcome = applyIntent(
      doc(),
      form({ intent: "add-node", deviceId: "d:d_mixer" }),
      withTemplate,
    );
    if (outcome.kind !== "doc") throw new Error("expected a document");

    expect(outcome.doc.nodes).toEqual([{ id: "n1", deviceId: "d_mixer" }]);
    expect(outcome.doc.routing).toEqual([{ nodeId: "n1", inPort: "ch1", bus: "main" }]);
  });

  // Software is not a physical unit, so it is named by model and skips the
  // ledger entirely — two joins into one meeting are two nodes of one model.
  it("adds software by model id", () => {
    const next = applied(doc(), { intent: "add-node", deviceId: "m:m_meet" });

    expect(next.nodes).toEqual([{ id: "n1", modelId: "m_meet" }]);
  });

  it("numbers a new node from the ids already taken", () => {
    const base = doc({ nodes: [{ id: "n1", deviceId: "d_mic1" }] });

    expect(applied(base, { intent: "add-node", deviceId: "d:d_mic2" }).nodes[1]?.id).toBe("n2");
  });

  it("drops a field the form left blank rather than storing an empty string", () => {
    const base = doc({ nodes: [{ id: "n1", deviceId: "d_mic1", spaceId: "sp1", label: "旧名" }] });

    const next = applied(base, {
      intent: "update-node",
      nodeId: "n1",
      label: "",
      spaceId: "",
      coupling: "open",
      hostNodeId: "",
    });

    expect(next.nodes[0]).toEqual({ id: "n1", deviceId: "d_mic1" });
  });

  it("toggles a matrix cell both ways", () => {
    const cell = { intent: "toggle-route", nodeId: "n1", inPort: "ch1", bus: "main" };
    const on = applied(doc({ nodes: [{ id: "n1", deviceId: "d_mixer" }] }), cell);

    expect(on.routing).toEqual([{ nodeId: "n1", inPort: "ch1", bus: "main" }]);
    expect(applied(on, cell).routing).toEqual([]);
  });

  it("takes the software running on a computer down with it", () => {
    const base = doc({
      nodes: [
        { id: "n1", deviceId: "d_pc" },
        { id: "n2", modelId: "m_obs", hostNodeId: "n1" },
      ],
      links: [{ id: "l1", from: ["n1", "usb_in"], to: ["n2", "audio_in"] }],
    });

    const next = applied(base, { intent: "remove-node", nodeId: "n1" });

    expect(next.nodes).toEqual([]);
    expect(next.links).toEqual([]);
  });

  describe("an app's device selection", () => {
    const base = doc({
      nodes: [
        { id: "n1", deviceId: "d_pc" },
        { id: "n2", modelId: "m_obs", hostNodeId: "n1" },
      ],
    });

    // The form never asks which way round it goes, and neither does the drag:
    // out→out is the app playing into the machine, in→in is it capturing from
    // one. Both ends are on the same face, so only the directions can say.
    it("runs input to input when the app is capturing", () => {
      const next = applied(base, {
        intent: "add-assignment",
        app: "n2::audio_in",
        host: "n1::usb_in",
      });

      expect(next.links).toEqual([{ id: "l1", from: ["n1", "usb_in"], to: ["n2", "audio_in"] }]);
    });

    it("runs output to output when the app is playing out", () => {
      const next = applied(base, {
        intent: "add-assignment",
        app: "n2::monitor_out",
        host: "n1::headphone_out",
      });

      expect(next.links).toEqual([
        { id: "l1", from: ["n2", "monitor_out"], to: ["n1", "headphone_out"] },
      ]);
    });

    it("refuses to cross the faces, which would be a cable and not a selection", () => {
      expect(
        failed(base, { intent: "add-assignment", app: "n2::audio_in", host: "n1::usb_out" }),
      ).toContain("向き");
    });

    it("refuses a computer that is not this app's host", () => {
      const twoMachines = doc({
        nodes: [...base.nodes, { id: "n3", deviceId: "d_laptop" }],
      });

      expect(
        failed(twoMachines, { intent: "add-assignment", app: "n2::audio_in", host: "n3::usb_in" }),
      ).toContain("ホストではありません");
    });
  });

  it("reports unreadable JSON rather than throwing", () => {
    expect(failed(doc(), { intent: "replace-doc", doc: "{ not json" })).toContain("JSON");
  });

  it("reports a document that does not match the schema", () => {
    expect(failed(doc(), { intent: "replace-doc", doc: '{"schemaVersion": 99}' })).toContain(
      "スキーマ",
    );
  });

  // The name and the soft delete are columns on the setup row, so the browser
  // has nothing to apply and the server has to be asked.
  it("hands the setup row's own fields back to the caller", () => {
    expect(applyIntent(doc(), form({ intent: "rename-setup", name: "本番" }), catalog).kind).toBe(
      "elsewhere",
    );
    expect(applyIntent(doc(), form({ intent: "delete-setup" }), catalog).kind).toBe("elsewhere");
  });

  it("rejects an intent it does not know", () => {
    expect(failed(doc(), { intent: "drop-database" })).toContain("drop-database");
  });
});

describe("isOptimistic", () => {
  it("covers every document edit", () => {
    for (const intent of ["add-node", "update-node", "add-link", "toggle-route", "apply-fix"]) {
      expect(isOptimistic(intent)).toBe(true);
    }
  });

  // The server is what decides whether pasted text is a document at all, and
  // applying it locally would reformat the box someone is still typing in.
  it("leaves the pasted document, the name and the delete to the server", () => {
    expect(isOptimistic("replace-doc")).toBe(false);
    expect(isOptimistic("rename-setup")).toBe(false);
    expect(isOptimistic("delete-setup")).toBe(false);
  });
});
