import { describe, expect, it } from "vitest";
import type { Diagnostic } from "./diagnostics";
import { laptopOnlyMeeting, satelliteRooms, testContext, twoJoinsInOneHall } from "./fixtures";
import { lint } from "./lint";
import type { SetupDoc } from "./schema";

const HALL = { id: "sp_hall", kind: "acoustic", label: "メインホール" } as const;
const SCREEN = { id: "sp_screen", kind: "visual", label: "正面スクリーン" } as const;

function doc(partial: Partial<SetupDoc>): SetupDoc {
  return { schemaVersion: 1, spaces: [], nodes: [], links: [], routing: [], ...partial };
}

function ruleIds(diagnostics: Diagnostic[]): string[] {
  return diagnostics.map((diagnostic) => diagnostic.ruleId);
}

describe("acoustic feedback", () => {
  const nodes = [
    { id: "n_mic", deviceId: "d_mic1", spaceId: "sp_hall" },
    { id: "n_mixer", deviceId: "d_mixer" },
    { id: "n_speaker", deviceId: "d_speaker", spaceId: "sp_hall" },
  ];
  const links = [
    { id: "l1", from: ["n_mic", "out"], to: ["n_mixer", "ch1"] },
    { id: "l2", from: ["n_mixer", "main_out"], to: ["n_speaker", "in"] },
  ] satisfies SetupDoc["links"];

  it("reports a howling loop when the mic is routed to the bus feeding the speaker", () => {
    const found = lint(
      doc({
        spaces: [HALL],
        nodes,
        links,
        routing: [{ nodeId: "n_mixer", inPort: "ch1", bus: "main" }],
      }),
      testContext(),
    );

    const loop = found.find((d) => d.ruleId === "acoustic-feedback-loop");
    expect(loop).toBeDefined();
    expect(loop?.severity).toBe("critical");
    expect(loop?.nodeIds).toEqual(expect.arrayContaining(["n_mic", "n_mixer", "n_speaker"]));
    expect(loop?.fixes).toEqual(
      expect.arrayContaining([
        { kind: "disable-route", nodeId: "n_mixer", inPort: "ch1", bus: "main" },
      ]),
    );
  });

  it("clears once the mic is routed to AUX only", () => {
    const found = lint(
      doc({
        spaces: [HALL],
        nodes,
        links,
        routing: [{ nodeId: "n_mixer", inPort: "ch1", bus: "aux1" }],
      }),
      testContext(),
    );

    expect(ruleIds(found)).not.toContain("acoustic-feedback-loop");
  });

  it("clears when the mic is isolated (headset or in-ear)", () => {
    const found = lint(
      doc({
        spaces: [HALL],
        nodes: [{ ...nodes[0], coupling: "isolated" as const }, nodes[1], nodes[2]],
        links,
        routing: [{ nodeId: "n_mixer", inPort: "ch1", bus: "main" }],
      }),
      testContext(),
    );

    expect(ruleIds(found)).not.toContain("acoustic-feedback-loop");
  });

  it("classifies the loop as a stream monitor loop when it passes through OBS", () => {
    const found = lint(
      doc({
        spaces: [HALL],
        nodes: [
          { id: "n_mic", deviceId: "d_mic1", spaceId: "sp_hall" },
          { id: "n_mixer", deviceId: "d_mixer" },
          { id: "n_pc", deviceId: "d_pc" },
          { id: "n_obs", deviceId: "d_obs", hostNodeId: "n_pc" },
          { id: "n_speaker", deviceId: "d_speaker", spaceId: "sp_hall" },
        ],
        links: [
          { id: "l1", from: ["n_mic", "out"], to: ["n_mixer", "ch1"] },
          { id: "l2", from: ["n_mixer", "usb_send"], to: ["n_pc", "usb_in"] },
          { id: "l3", from: ["n_pc", "usb_in"], to: ["n_obs", "audio_in"] },
          { id: "l4", from: ["n_obs", "monitor_out"], to: ["n_pc", "headphone_out"] },
          { id: "l5", from: ["n_pc", "headphone_out"], to: ["n_speaker", "in"] },
        ],
        routing: [
          { nodeId: "n_mixer", inPort: "ch1", bus: "usb" },
          { nodeId: "n_obs", inPort: "audio_in", bus: "monitor" },
        ],
      }),
      testContext(),
    );

    expect(ruleIds(found)).toContain("stream-monitor-loop");
    expect(ruleIds(found)).not.toContain("acoustic-feedback-loop");
  });
});

describe("remote participant echo", () => {
  const nodes = [
    { id: "n_mixer", deviceId: "d_mixer" },
    { id: "n_pc", deviceId: "d_pc" },
    { id: "n_meet", deviceId: "d_meet", hostNodeId: "n_pc" },
  ];
  const links = [
    { id: "l1", from: ["n_mixer", "usb_send"], to: ["n_pc", "usb_in"] },
    { id: "l2", from: ["n_pc", "usb_in"], to: ["n_meet", "mic_in"] },
    { id: "l3", from: ["n_meet", "spk_out"], to: ["n_pc", "usb_out"] },
    { id: "l4", from: ["n_pc", "usb_out"], to: ["n_mixer", "usb_in"] },
  ] satisfies SetupDoc["links"];

  it("reports an electrical Mix-Minus violation and names the matrix cell to clear", () => {
    const found = lint(
      doc({
        nodes,
        links,
        routing: [{ nodeId: "n_mixer", inPort: "usb_in", bus: "usb" }],
      }),
      testContext(),
    );

    const echo = found.find((d) => d.ruleId === "remote-echo-electrical");
    expect(echo).toBeDefined();
    expect(echo?.severity).toBe("critical");
    expect(echo?.fixes).toEqual(
      expect.arrayContaining([
        { kind: "disable-route", nodeId: "n_mixer", inPort: "usb_in", bus: "usb" },
      ]),
    );
  });

  it("clears once the USB return is kept off the USB send bus", () => {
    const found = lint(doc({ nodes, links, routing: [] }), testContext());
    expect(ruleIds(found)).not.toContain("remote-echo-electrical");
  });

  it("distinguishes an acoustic return path from an electrical one", () => {
    const found = lint(
      doc({
        spaces: [HALL],
        nodes: [
          { id: "n_mic", deviceId: "d_mic1", spaceId: "sp_hall" },
          { id: "n_mixer", deviceId: "d_mixer" },
          { id: "n_speaker", deviceId: "d_speaker", spaceId: "sp_hall" },
          { id: "n_pc", deviceId: "d_pc" },
          { id: "n_meet", deviceId: "d_meet", hostNodeId: "n_pc" },
        ],
        links: [
          { id: "l1", from: ["n_mic", "out"], to: ["n_mixer", "ch1"] },
          { id: "l2", from: ["n_mixer", "usb_send"], to: ["n_pc", "usb_in"] },
          { id: "l3", from: ["n_pc", "usb_in"], to: ["n_meet", "mic_in"] },
          { id: "l4", from: ["n_meet", "spk_out"], to: ["n_pc", "headphone_out"] },
          { id: "l5", from: ["n_pc", "headphone_out"], to: ["n_speaker", "in"] },
        ],
        routing: [{ nodeId: "n_mixer", inPort: "ch1", bus: "usb" }],
      }),
      testContext(),
    );

    expect(ruleIds(found)).toContain("remote-echo-acoustic");
    expect(ruleIds(found)).not.toContain("remote-echo-electrical");
    // Pinned: a mixer in the return path is past what AEC can cancel, so the
    // §9.7.4 downgrade must not reach this one.
    expect(found.find((d) => d.ruleId === "remote-echo-acoustic")?.severity).toBe("critical");
  });

  it("downgrades the loop a laptop's own canceller removes", () => {
    const found = lint(laptopOnlyMeeting(), testContext());
    const echo = found.find((d) => d.ruleId === "remote-echo-acoustic");
    expect(echo).toBeDefined();
    expect(echo?.severity).toBe("warn");
  });
});

describe("transport echo", () => {
  it("reports a loop closed through a second join of the same meeting", () => {
    const found = lint(twoJoinsInOneHall(), testContext());
    const loop = found.find((d) => d.ruleId === "transport-echo-loop");

    expect(loop).toBeDefined();
    expect(loop?.severity).toBe("critical");
    // The presenter's own laptop is the machine nobody wrote down, and naming
    // it is the whole point of the rule.
    expect(loop?.nodeIds).toContain("n_laptop_mic");
    expect(loop?.nodeIds).toContain("n_speaker");
    // Not oscillation in the room; §9.7.3 keeps the two apart.
    expect(ruleIds(found)).not.toContain("acoustic-feedback-loop");
  });

  it("tells the two joins apart by the machine each runs on", () => {
    const loop = lint(twoJoinsInOneHall(), testContext()).find(
      (d) => d.ruleId === "transport-echo-loop",
    );

    // Both joins are the same model, so an unqualified path would read
    // "Google Meet → Google Meet" and name neither laptop — which is the one
    // thing this rule exists to do.
    expect(loop?.message).toContain("Google Meet (登壇者ノートPC)");
    expect(loop?.message).toContain("Google Meet (配信PC)");
  });

  it("couples two rooms that share nothing but a meeting", () => {
    const found = lint(satelliteRooms(), testContext());
    const loops = found.filter((d) => d.ruleId === "transport-echo-loop");

    expect(loops).toHaveLength(1);
    expect(loops[0]?.spaceIds).toEqual(
      expect.arrayContaining(["sp_hall", "sp_satellite", "sp_mtg"]),
    );
  });

  it("says nothing about a meeting with a single join", () => {
    const single = twoJoinsInOneHall();
    const found = lint(
      {
        ...single,
        nodes: single.nodes.filter((node) => node.id !== "n_join_laptop"),
        links: single.links.filter((link) => link.id !== "l6"),
      },
      testContext(),
    );

    expect(ruleIds(found)).not.toContain("transport-echo-loop");
  });
});

describe("stream coverage", () => {
  it("reports a silent stream when no mic reaches the broadcast software", () => {
    const found = lint(
      doc({
        spaces: [HALL],
        nodes: [
          { id: "n_mic", deviceId: "d_mic1", spaceId: "sp_hall" },
          { id: "n_pc", deviceId: "d_pc" },
          { id: "n_obs", deviceId: "d_obs", hostNodeId: "n_pc" },
        ],
      }),
      testContext(),
    );

    const silent = found.find((d) => d.ruleId === "no-audio-to-stream");
    expect(silent?.severity).toBe("critical");
  });

  it("stays quiet when the mic reaches OBS over USB", () => {
    const found = lint(
      doc({
        spaces: [HALL],
        nodes: [
          { id: "n_mic", deviceId: "d_mic1", spaceId: "sp_hall" },
          { id: "n_mixer", deviceId: "d_mixer" },
          { id: "n_pc", deviceId: "d_pc" },
          { id: "n_obs", deviceId: "d_obs", hostNodeId: "n_pc" },
        ],
        links: [
          { id: "l1", from: ["n_mic", "out"], to: ["n_mixer", "ch1"] },
          { id: "l2", from: ["n_mixer", "usb_send"], to: ["n_pc", "usb_in"] },
          { id: "l3", from: ["n_pc", "usb_in"], to: ["n_obs", "audio_in"] },
        ],
        routing: [{ nodeId: "n_mixer", inPort: "ch1", bus: "usb" }],
      }),
      testContext(),
    );

    expect(ruleIds(found)).not.toContain("no-audio-to-stream");
  });

  it("warns that a house PA is checked on an all-pass assumption", () => {
    const found = lint(
      doc({
        nodes: [{ id: "n_pa", deviceId: "d_house_pa" }],
      }),
      testContext(),
    );

    expect(ruleIds(found)).toContain("blackbox-assumption");
  });
});

describe("infinite mirror", () => {
  it("reports a video loop through the projector and camera", () => {
    const found = lint(
      doc({
        spaces: [SCREEN],
        nodes: [
          { id: "n_cam", deviceId: "d_camera", spaceId: "sp_screen" },
          { id: "n_cap", deviceId: "d_capture" },
          { id: "n_pc", deviceId: "d_pc" },
          { id: "n_obs", deviceId: "d_obs", hostNodeId: "n_pc" },
          { id: "n_proj", deviceId: "d_projector", spaceId: "sp_screen" },
        ],
        links: [
          { id: "l1", from: ["n_cam", "hdmi_out"], to: ["n_cap", "hdmi_in"] },
          { id: "l2", from: ["n_cap", "usb_out"], to: ["n_pc", "capture_in"] },
          { id: "l3", from: ["n_pc", "capture_in"], to: ["n_obs", "video_in"] },
          { id: "l4", from: ["n_obs", "program_video"], to: ["n_pc", "hdmi_out"] },
          { id: "l5", from: ["n_pc", "hdmi_out"], to: ["n_proj", "hdmi_in"] },
        ],
        routing: [{ nodeId: "n_obs", inPort: "video_in", bus: "program" }],
      }),
      testContext(),
    );

    expect(ruleIds(found)).toContain("visual-feedback-loop");
  });
});

describe("per-cable checks", () => {
  it("flags a mic-level source plugged into a line input, and the adapter needed", () => {
    const found = lint(
      doc({
        spaces: [HALL],
        nodes: [
          { id: "n_mic", deviceId: "d_mic1", spaceId: "sp_hall" },
          { id: "n_pc", deviceId: "d_pc" },
        ],
        links: [{ id: "l1", from: ["n_mic", "out"], to: ["n_pc", "line_in"] }],
      }),
      testContext(),
    );

    expect(ruleIds(found)).toContain("level-mismatch");
    expect(ruleIds(found)).toContain("connector-mismatch");
  });

  it("flags a condenser mic with no phantom power at the input it is plugged into", () => {
    const found = lint(
      doc({
        spaces: [HALL],
        nodes: [
          { id: "n_mic", deviceId: "d_condenser", spaceId: "sp_hall" },
          { id: "n_pc", deviceId: "d_pc" },
        ],
        links: [{ id: "l1", from: ["n_mic", "out"], to: ["n_pc", "line_in"] }],
      }),
      testContext(),
    );

    expect(ruleIds(found)).toContain("phantom-missing");
  });

  it("accepts a condenser mic on a mixer channel that supplies +48V", () => {
    const found = lint(
      doc({
        spaces: [HALL],
        nodes: [
          { id: "n_mic", deviceId: "d_condenser", spaceId: "sp_hall" },
          { id: "n_mixer", deviceId: "d_mixer" },
        ],
        links: [{ id: "l1", from: ["n_mic", "out"], to: ["n_mixer", "ch1"] }],
      }),
      testContext(),
    );

    expect(ruleIds(found)).not.toContain("phantom-missing");
  });

  it("rejects a link wired output-to-output between unrelated devices", () => {
    const found = lint(
      doc({
        nodes: [
          { id: "n_mic", deviceId: "d_mic1", spaceId: "sp_hall" },
          { id: "n_mic2", deviceId: "d_mic2", spaceId: "sp_hall" },
        ],
        links: [{ id: "l1", from: ["n_mic", "out"], to: ["n_mic2", "out"] }],
      }),
      testContext(),
    );

    expect(ruleIds(found)).toContain("link-direction");
  });
});

describe("event membership", () => {
  it("reports gear that was not brought to the event", () => {
    const found = lint(
      doc({
        nodes: [
          { id: "n_mic", deviceId: "d_mic1", spaceId: "sp_hall" },
          { id: "n_mixer", deviceId: "d_mixer" },
        ],
        spaces: [HALL],
      }),
      testContext({ eventDeviceIds: new Set(["d_mic1"]) }),
    );

    const missing = found.filter((d) => d.ruleId === "device-not-in-event");
    expect(missing).toHaveLength(1);
    expect(missing[0]?.nodeIds).toEqual(["n_mixer"]);
  });

  it("skips the check when the event device list is not supplied", () => {
    const found = lint(doc({ nodes: [{ id: "n_mixer", deviceId: "d_mixer" }] }), testContext());

    expect(ruleIds(found)).not.toContain("device-not-in-event");
  });
});

describe("severity ordering", () => {
  it("returns the most severe finding first", () => {
    const found = lint(
      doc({
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
      }),
      testContext(),
    );

    expect(found[0]?.severity).toBe("critical");
  });
});
