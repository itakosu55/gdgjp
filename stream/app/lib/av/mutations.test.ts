import { describe, expect, it } from "vitest";
import { MODELS, testContext } from "./fixtures";
import { lint } from "./lint";
import { applyFix, applyOperation, canApplyFix, defaultRoutesFor } from "./mutations";
import type { SetupDoc } from "./schema";

const HALL = { id: "sp_hall", kind: "acoustic", label: "メインホール" } as const;

function doc(partial: Partial<SetupDoc>): SetupDoc {
  return { schemaVersion: 1, spaces: [], nodes: [], links: [], routing: [], ...partial };
}

const howling = doc({
  spaces: [HALL],
  nodes: [
    { id: "n_mic", deviceId: "d_mic1", spaceId: "sp_hall" },
    { id: "n_mixer", deviceId: "d_mixer" },
    { id: "n_speaker", deviceId: "d_speaker", spaceId: "sp_hall" },
  ],
  links: [
    { id: "l1", from: ["n_mic", "out"], to: ["n_mixer", "ch1"] },
    { id: "l2", from: ["n_mixer", "main_out"], to: ["n_speaker", "in"] },
  ],
  routing: [{ nodeId: "n_mixer", inPort: "ch1", bus: "main" }],
});

describe("applyOperation", () => {
  it("copies the model's default matrix in when a node is added", () => {
    const mixer = MODELS.find((model) => model.id === "m_mixer");
    if (!mixer) throw new Error("fixture missing");
    const withDefaults = {
      ...mixer,
      defaultRoutes: [{ inPort: "ch1", bus: "main" }],
    };

    const next = applyOperation(doc({}), {
      kind: "add-node",
      node: { id: "n1", deviceId: "d_mixer" },
      routes: defaultRoutesFor("n1", withDefaults),
    });

    expect(next.routing).toEqual([{ nodeId: "n1", inPort: "ch1", bus: "main" }]);
  });

  it("copies nothing for a device whose internals are not a matrix", () => {
    const mic = MODELS.find((model) => model.id === "m_mic_dynamic");
    if (!mic) throw new Error("fixture missing");
    expect(defaultRoutesFor("n1", mic)).toEqual([]);
  });

  it("removes the software running on a computer along with the computer", () => {
    const next = applyOperation(
      doc({
        nodes: [
          { id: "n_pc", deviceId: "d_pc" },
          { id: "n_obs", deviceId: "d_obs", hostNodeId: "n_pc" },
          { id: "n_mixer", deviceId: "d_mixer" },
        ],
        links: [{ id: "l1", from: ["n_mixer", "usb_send"], to: ["n_pc", "usb_in"] }],
        routing: [{ nodeId: "n_obs", inPort: "audio_in", bus: "program" }],
      }),
      { kind: "remove-node", nodeId: "n_pc" },
    );

    expect(next.nodes.map((node) => node.id)).toEqual(["n_mixer"]);
    expect(next.links).toEqual([]);
    expect(next.routing).toEqual([]);
  });

  it("clears the space reference when a space is deleted", () => {
    const next = applyOperation(howling, { kind: "remove-space", spaceId: "sp_hall" });

    expect(next.spaces).toEqual([]);
    expect(next.nodes.every((node) => node.spaceId === undefined)).toBe(true);
  });

  it("toggles a routing cell on and back off", () => {
    const on = applyOperation(doc({}), {
      kind: "toggle-route",
      nodeId: "n_mixer",
      inPort: "ch1",
      bus: "aux1",
    });
    expect(on.routing).toHaveLength(1);

    const off = applyOperation(on, {
      kind: "toggle-route",
      nodeId: "n_mixer",
      inPort: "ch1",
      bus: "aux1",
    });
    expect(off.routing).toEqual([]);
  });
});

describe("applyFix", () => {
  it("marks fixes that still need a human decision as not auto-applicable", () => {
    expect(canApplyFix({ kind: "assign-space", nodeId: "n_mic" })).toBe(false);
    expect(canApplyFix({ kind: "add-device", category: "recorder", reason: "" })).toBe(false);
    expect(canApplyFix({ kind: "set-coupling", nodeId: "n_mic", coupling: "isolated" })).toBe(true);
  });

  it("leaves the document untouched for a fix it cannot decide", () => {
    expect(applyFix(howling, { kind: "assign-space", nodeId: "n_mic" })).toEqual(howling);
  });

  // This is the loop the AI phase will run: propose, lint, repair, lint again.
  it("clears the howling diagnostic when its own suggested fix is applied", () => {
    const ctx = testContext();
    const before = lint(howling, ctx);
    const loop = before.find((d) => d.ruleId === "acoustic-feedback-loop");
    expect(loop).toBeDefined();

    const fix = loop?.fixes?.find((candidate) => candidate.kind === "disable-route");
    if (!fix) throw new Error("expected a disable-route fix");

    const after = lint(applyFix(howling, fix), ctx);
    expect(after.map((d) => d.ruleId)).not.toContain("acoustic-feedback-loop");
  });

  it("also clears it via the isolation fix", () => {
    const ctx = testContext();
    const loop = lint(howling, ctx).find((d) => d.ruleId === "acoustic-feedback-loop");
    const fix = loop?.fixes?.find((candidate) => candidate.kind === "set-coupling");
    if (!fix) throw new Error("expected a set-coupling fix");

    const after = lint(applyFix(howling, fix), ctx);
    expect(after.map((d) => d.ruleId)).not.toContain("acoustic-feedback-loop");
  });
});

describe("software nodes survive an edit", () => {
  it("keeps modelId when a node is updated", () => {
    const doc: SetupDoc = {
      schemaVersion: 1,
      spaces: [{ id: "sp_mtg", kind: "transport", label: "Meet" }],
      nodes: [{ id: "n_meet", modelId: "m_meet", hostNodeId: "n_pc" }],
      links: [],
      routing: [],
    };

    // `clean` rebuilds the node from a whitelist, so a reference it does not
    // know about would be dropped silently.
    const next = applyOperation(doc, {
      kind: "update-node",
      nodeId: "n_meet",
      patch: { spaceId: "sp_mtg" },
    });

    expect(next.nodes[0]).toEqual({
      id: "n_meet",
      modelId: "m_meet",
      spaceId: "sp_mtg",
      hostNodeId: "n_pc",
    });
  });
});
