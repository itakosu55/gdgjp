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
        routing: [{ nodeId: "n_obs", inPort: "audio_src:1", bus: "program" }],
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

  it("merges a space patch and leaves the keys it does not carry alone", () => {
    const before = doc({ spaces: [{ ...HALL, venueKey: "hall-a" }] });

    const next = applyOperation(before, {
      kind: "update-space",
      spaceId: "sp_hall",
      patch: { reinforced: true },
    });

    expect(next.spaces[0]).toEqual({
      id: "sp_hall",
      kind: "acoustic",
      label: "メインホール",
      venueKey: "hall-a",
      reinforced: true,
    });
  });

  it("clears a declaration when the patch carries it as undefined", () => {
    const before = doc({ spaces: [{ ...HALL, reinforced: true }] });

    const next = applyOperation(before, {
      kind: "update-space",
      spaceId: "sp_hall",
      patch: { reinforced: undefined },
    });

    expect(next.spaces[0]?.reinforced).toBeUndefined();
  });
});

describe("applyFix", () => {
  it("marks fixes that still need a human decision as not auto-applicable", () => {
    expect(canApplyFix({ kind: "assign-space", nodeId: "n_mic" })).toBe(false);
    expect(canApplyFix({ kind: "add-device", category: "recorder", reason: "" })).toBe(false);
    // The line is not "hard to decide" but "who may decide": rewiring is a
    // change to the document, and a machine may make it. `declare-reinforced`
    // asserts a fact about the room, and only a person can do that — otherwise
    // the AI repair loop clears every howling finding with one checkbox.
    expect(canApplyFix({ kind: "declare-reinforced", spaceId: "sp_hall" })).toBe(false);
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

  // Same trap, and the one a muted jack falls into: `clean`'s whitelist has to
  // learn every new field or an unrelated edit silently un-mutes the mic.
  it("keeps muted jacks when a node is updated", () => {
    const doc: SetupDoc = {
      schemaVersion: 1,
      spaces: [],
      nodes: [{ id: "n_laptop", deviceId: "d_laptop", isolatedPorts: ["builtin_mic"] }],
      links: [],
      routing: [],
    };

    const next = applyOperation(doc, {
      kind: "update-node",
      nodeId: "n_laptop",
      patch: { label: "登壇者PC" },
    });

    expect(next.nodes[0]?.isolatedPorts).toEqual(["builtin_mic"]);
  });

  it("keeps assignments when a node is updated", () => {
    const doc: SetupDoc = {
      schemaVersion: 1,
      spaces: [],
      nodes: [
        {
          id: "n_obs",
          modelId: "m_obs",
          hostNodeId: "n_pc",
          assignments: [{ port: "audio_src:1", hostPort: "usb_in" }],
        },
      ],
      links: [],
      routing: [],
    };

    const next = applyOperation(doc, {
      kind: "update-node",
      nodeId: "n_obs",
      patch: { label: "配信OBS" },
    });

    expect(next.nodes[0]?.assignments).toEqual([{ port: "audio_src:1", hostPort: "usb_in" }]);
  });
});

describe("muting one jack", () => {
  const laptop: SetupDoc = {
    schemaVersion: 1,
    spaces: [],
    nodes: [{ id: "n_laptop", deviceId: "d_laptop" }],
    links: [],
    routing: [],
  };

  it("adds the port rather than isolating the whole machine", () => {
    const next = applyFix(laptop, {
      kind: "set-coupling",
      nodeId: "n_laptop",
      coupling: "isolated",
      portKey: "builtin_mic",
    });

    expect(next.nodes[0]?.isolatedPorts).toEqual(["builtin_mic"]);
    expect(next.nodes[0]?.coupling).toBeUndefined();
  });

  it("accumulates instead of replacing, so muting the speaker keeps the mic muted", () => {
    const once = applyFix(laptop, {
      kind: "set-coupling",
      nodeId: "n_laptop",
      coupling: "isolated",
      portKey: "builtin_mic",
    });
    const twice = applyFix(once, {
      kind: "set-coupling",
      nodeId: "n_laptop",
      coupling: "isolated",
      portKey: "builtin_spk",
    });

    expect(twice.nodes[0]?.isolatedPorts).toEqual(["builtin_mic", "builtin_spk"]);
  });
});

describe("sources", () => {
  const obs = MODELS.find((model) => model.id === "m_obs");
  if (!obs) throw new Error("fixture missing");

  const base = doc({
    nodes: [
      { id: "n_pc", deviceId: "d_pc" },
      {
        id: "n_obs",
        modelId: "m_obs",
        hostNodeId: "n_pc",
        ports: [
          { key: "audio_src:1", template: "audio_src", label: "登壇者マイク" },
          { key: "browser_audio:1", template: "browser_audio", label: "Meet", sourceId: "s1" },
          { key: "browser_video:1", template: "browser_video", label: "Meet", sourceId: "s1" },
        ],
      },
    ],
    links: [{ id: "l1", from: ["n_pc", "usb_in"], to: ["n_obs", "audio_src:1"] }],
    routing: [
      { nodeId: "n_obs", inPort: "audio_src:1", bus: "program" },
      { nodeId: "n_obs", inPort: "browser_audio:1", bus: "monitor" },
    ],
  });

  // A default route naming a template means "every instance of this begins
  // here", so it has to follow each source as it is added rather than be copied
  // once when the node appears.
  it("gives a new source the default cells of its template", () => {
    expect(defaultRoutesFor("n_obs", obs, [{ key: "audio_src:1", template: "audio_src" }])).toEqual(
      [{ nodeId: "n_obs", inPort: "audio_src:1", bus: "program" }],
    );
  });

  it("copies no template cell for a node that has no sources yet", () => {
    expect(defaultRoutesFor("n_obs", obs)).toEqual([]);
  });

  it("appends a source and its cells", () => {
    const next = applyOperation(base, {
      kind: "add-source",
      nodeId: "n_obs",
      ports: [{ key: "audio_src:2", template: "audio_src", label: "開演前BGM" }],
      routes: [{ nodeId: "n_obs", inPort: "audio_src:2", bus: "program" }],
    });

    expect(next.nodes[1]?.ports?.map((port) => port.key)).toEqual([
      "audio_src:1",
      "browser_audio:1",
      "browser_video:1",
      "audio_src:2",
    ]);
    expect(next.routing).toContainEqual({
      nodeId: "n_obs",
      inPort: "audio_src:2",
      bus: "program",
    });
  });

  // Same cascade `remove-node` performs: a cable or a matrix cell left pointing
  // at a jack nobody can see any more is `unknown-reference` noise.
  it("takes the cables and the matrix cells of a deleted source with it", () => {
    const next = applyOperation(base, {
      kind: "remove-source",
      nodeId: "n_obs",
      portKey: "audio_src:1",
    });

    expect(next.nodes[1]?.ports?.map((port) => port.key)).toEqual([
      "browser_audio:1",
      "browser_video:1",
    ]);
    expect(next.links).toEqual([]);
    expect(next.routing).toEqual([{ nodeId: "n_obs", inPort: "browser_audio:1", bus: "monitor" }]);
  });

  it("deletes both halves of a browser source, because they are one source", () => {
    const next = applyOperation(base, {
      kind: "remove-source",
      nodeId: "n_obs",
      portKey: "browser_video:1",
    });

    expect(next.nodes[1]?.ports?.map((port) => port.key)).toEqual(["audio_src:1"]);
    expect(next.routing).toEqual([{ nodeId: "n_obs", inPort: "audio_src:1", bus: "program" }]);
  });

  // A deleted source takes its selection with it, the same cascade `links` and
  // `routing` already get. Leaving one behind would be an `unknown-reference`
  // about a jack nobody can see.
  it("takes the device selection of a deleted source with it", () => {
    const assigned = applyOperation(base, {
      kind: "add-assignment",
      nodeId: "n_obs",
      port: "audio_src:1",
      hostPort: "usb_in",
    });
    const next = applyOperation(assigned, {
      kind: "remove-source",
      nodeId: "n_obs",
      portKey: "audio_src:1",
    });

    expect(next.nodes.find((node) => node.id === "n_obs")?.assignments).toBeUndefined();
  });

  it("renames both halves at once, and drops the name when it is cleared", () => {
    const named = applyOperation(base, {
      kind: "rename-source",
      nodeId: "n_obs",
      portKey: "browser_audio:1",
      label: "Zoom",
    });
    expect(named.nodes[1]?.ports?.filter((port) => port.sourceId === "s1")).toEqual([
      { key: "browser_audio:1", template: "browser_audio", label: "Zoom", sourceId: "s1" },
      { key: "browser_video:1", template: "browser_video", label: "Zoom", sourceId: "s1" },
    ]);

    const cleared = applyOperation(named, {
      kind: "rename-source",
      nodeId: "n_obs",
      portKey: "browser_audio:1",
      label: "",
    });
    expect(cleared.nodes[1]?.ports?.[1]).toEqual({
      key: "browser_audio:1",
      template: "browser_audio",
      sourceId: "s1",
    });
  });

  // The `clean` whitelist trap again: a node's sources are the third field that
  // an unrelated edit would silently drop if it went unlisted.
  it("keeps the sources when the node is updated for something else", () => {
    const next = applyOperation(base, {
      kind: "update-node",
      nodeId: "n_obs",
      patch: { label: "配信OBS" },
    });

    expect(next.nodes[1]?.ports).toHaveLength(3);
  });
});
