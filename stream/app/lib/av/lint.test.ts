import { describe, expect, it } from "vitest";
import type { Diagnostic } from "./diagnostics";
import {
  laptopOnlyMeeting,
  satelliteRooms,
  speakerphoneMeeting,
  testContext,
  twoJoinsInOneHall,
} from "./fixtures";
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
    // it is the whole point of the rule. Its mic is a port of it now, so the
    // laptop itself is what the path names.
    expect(loop?.nodeIds).toContain("n_laptop");
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

  // §11.6's requirement, end to end: the actual fix on the day is muting the
  // presenter's mic, not deafening their laptop, and the loop has to clear from
  // exactly that.
  it("clears when only the presenter's built-in mic is muted", () => {
    const base = twoJoinsInOneHall();
    const found = lint(
      {
        ...base,
        nodes: base.nodes.map((node) =>
          node.id === "n_laptop" ? { ...node, isolatedPorts: ["builtin_mic"] } : node,
        ),
      },
      testContext(),
    );

    expect(ruleIds(found)).not.toContain("transport-echo-loop");
  });

  it("offers that mute as a fix, naming the jack rather than the laptop", () => {
    const loop = lint(twoJoinsInOneHall(), testContext()).find(
      (d) => d.ruleId === "transport-echo-loop",
    );

    expect(loop?.fixes).toContainEqual({
      kind: "set-coupling",
      nodeId: "n_laptop",
      coupling: "isolated",
      portKey: "builtin_mic",
    });
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
        links: single.links.filter((link) => link.id !== "l5"),
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

describe("who hears it", () => {
  const MEETING = { id: "sp_mtg", kind: "transport", label: "登壇 Meet" } as const;

  // The hall mic is on the stream and nothing else: it goes to the USB bus, the
  // mixer's USB send feeds the streaming PC, and OBS routes it to PROGRAM.
  const onStreamOnly = {
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
    ] satisfies SetupDoc["links"],
    routing: [
      { nodeId: "n_mixer", inPort: "ch1", bus: "usb" },
      { nodeId: "n_obs", inPort: "audio_in", bus: "program" },
    ],
  };

  it("reports a source that is on the stream but never reaches the meeting", () => {
    const found = lint(
      doc({
        spaces: [HALL, MEETING],
        nodes: [
          ...onStreamOnly.nodes,
          { id: "n_join", modelId: "m_meet", hostNodeId: "n_pc", spaceId: "sp_mtg" },
        ],
        links: onStreamOnly.links,
        routing: onStreamOnly.routing,
      }),
      testContext(),
    );

    const finding = found.find((d) => d.ruleId === "source-not-reaching-remote");
    expect(finding?.severity).toBe("warn");
    expect(finding?.nodeIds).toEqual(["n_mic"]);
    // The stream is not silent, so the older rule has nothing to say and this
    // one is not a second wording of it.
    expect(ruleIds(found)).not.toContain("no-audio-to-stream");
  });

  it("clears once the mic is also fed into the join", () => {
    const found = lint(
      doc({
        spaces: [HALL, MEETING],
        nodes: [
          ...onStreamOnly.nodes,
          { id: "n_join", modelId: "m_meet", hostNodeId: "n_pc", spaceId: "sp_mtg" },
        ],
        links: [
          ...onStreamOnly.links,
          { id: "l4", from: ["n_pc", "usb_in"], to: ["n_join", "mic_in"] },
        ],
        routing: onStreamOnly.routing,
      }),
      testContext(),
    );

    expect(ruleIds(found)).not.toContain("source-not-reaching-remote");
  });

  it("says nothing about the meeting when nobody has joined one", () => {
    const found = lint(
      doc({ spaces: [HALL], ...onStreamOnly, links: onStreamOnly.links }),
      testContext(),
    );

    expect(ruleIds(found)).not.toContain("source-not-reaching-remote");
  });

  it("mentions the hall only at info, because keeping the mic out of it is correct", () => {
    const found = lint(
      doc({
        spaces: [HALL],
        nodes: [
          ...onStreamOnly.nodes,
          { id: "n_speaker", deviceId: "d_speaker", spaceId: "sp_hall" },
        ],
        links: [
          ...onStreamOnly.links,
          { id: "l4", from: ["n_mixer", "main_out"], to: ["n_speaker", "in"] },
        ],
        routing: onStreamOnly.routing,
      }),
      testContext(),
    );

    const finding = found.find((d) => d.ruleId === "source-not-reaching-room");
    expect(finding?.severity).toBe("info");
    expect(finding?.nodeIds).toEqual(["n_mic"]);
    // Routing the mic to MAIN instead is what howls, so this must never be
    // raised to a severity that pushes someone into doing it.
    expect(found.some((d) => d.severity === "critical")).toBe(false);
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

describe("unfinished wiring", () => {
  const laptopRunningMeet = doc({
    spaces: [HALL],
    nodes: [
      { id: "n_laptop", deviceId: "d_laptop", spaceId: "sp_hall" },
      { id: "n_join", modelId: "m_meet", hostNodeId: "n_laptop" },
    ],
  });

  it("does not accuse a machine of being unused while it is running an app", () => {
    const found = lint(laptopRunningMeet, testContext());

    // The laptop is on no path because its Meet has picked no devices, not
    // because the laptop is surplus. Reporting it as surplus reads as "delete
    // this", which is the opposite of what has to happen.
    expect(ruleIds(found)).not.toContain("unreachable-device");
  });

  it("names the app that has selected no input or output device", () => {
    const found = lint(laptopRunningMeet, testContext());
    const finding = found.find((d) => d.ruleId === "software-io-unassigned");

    expect(finding?.severity).toBe("info");
    expect(finding?.nodeIds).toEqual(["n_join", "n_laptop"]);
    expect(finding?.message).toContain("登壇者ノートPC");
  });

  it("reports a join whose meeting alone makes it look wired", () => {
    const found = lint(
      doc({
        spaces: [HALL, { id: "sp_mtg", kind: "transport", label: "打ち合わせ" }],
        nodes: [
          { id: "n_laptop", deviceId: "d_laptop", spaceId: "sp_hall" },
          { id: "n_join", modelId: "m_meet", hostNodeId: "n_laptop", spaceId: "sp_mtg" },
          { id: "n_pc", deviceId: "d_pc", spaceId: "sp_hall" },
          { id: "n_join2", modelId: "m_meet", hostNodeId: "n_pc", spaceId: "sp_mtg" },
        ],
      }),
      testContext(),
    );

    // Both joins carry the transport space's edges on both faces, so a
    // reachability check can never find this state — only `isPortWired` can.
    const reported = found
      .filter((d) => d.ruleId === "software-io-unassigned")
      .map((d) => d.nodeIds[0]);
    expect(reported).toEqual(["n_join", "n_join2"]);
  });

  it("clears once the app is assigned to the machine's jacks", () => {
    const found = lint(laptopOnlyMeeting(), testContext());

    expect(ruleIds(found)).not.toContain("software-io-unassigned");
    expect(ruleIds(found)).not.toContain("unreachable-device");
  });

  it("still reports gear that is attached to nothing", () => {
    const found = lint(doc({ nodes: [{ id: "n_mixer", deviceId: "d_mixer" }] }), testContext());

    expect(ruleIds(found)).toContain("unreachable-device");
  });
});

// Coupling is a property of the jack now, so "which room is this in?" is asked
// of whatever has a jack facing one — and a device can have two facing opposite
// ways (§11.2–11.4).
describe("where a jack faces", () => {
  it("asks a mic for its room the moment it is added", () => {
    const found = lint(doc({ nodes: [{ id: "n_mic", deviceId: "d_mic1" }] }), testContext());
    const finding = found.find((d) => d.ruleId === "space-unassigned");

    expect(finding?.severity).toBe("warn");
    expect(finding?.nodeIds).toEqual(["n_mic"]);
  });

  // What used to be `space-kind-mismatch` (error). The mic reaches no space
  // either way, so it is the same hole and gets the same wording.
  it("says the same thing about a mic in a place that only has a screen", () => {
    const found = lint(
      doc({
        spaces: [SCREEN],
        nodes: [{ id: "n_mic", deviceId: "d_mic1", spaceId: "sp_screen" }],
      }),
      testContext(),
    );

    expect(ruleIds(found)).toContain("space-unassigned");
    expect(ruleIds(found)).not.toContain("space-kind-mismatch");
  });

  it("clears once the place has air as well as a screen", () => {
    const found = lint(
      doc({
        spaces: [
          { ...SCREEN, venueKey: "hall" },
          { id: "sp_air", kind: "acoustic", label: "ホール", venueKey: "hall" },
        ],
        nodes: [{ id: "n_mic", deviceId: "d_mic1", spaceId: "sp_screen" }],
      }),
      testContext(),
    );

    expect(ruleIds(found)).not.toContain("space-unassigned");
  });

  // §11.6's price, and the answer to it. A jack that is incidental to the
  // device — a speakerphone's two faces, later a laptop's built-in mic — costs
  // nothing until someone plugs into it; then the missing room is a real hole,
  // because that is the machine picking the room up (§9.1).
  it("leaves a speakerphone alone until something is plugged into it", () => {
    const found = lint(
      doc({ nodes: [{ id: "n_phone", deviceId: "d_speakerphone" }] }),
      testContext(),
    );

    expect(ruleIds(found)).not.toContain("space-unassigned");
  });

  it("asks for the room once the speakerphone is wired to a PC", () => {
    const found = lint(
      doc({
        nodes: [
          { id: "n_phone", deviceId: "d_speakerphone" },
          { id: "n_pc", deviceId: "d_pc" },
        ],
        links: [{ id: "l1", from: ["n_phone", "usb_out"], to: ["n_pc", "usb_in"] }],
      }),
      testContext(),
    );
    const finding = found.find((d) => d.ruleId === "space-unassigned");

    expect(finding?.nodeIds).toEqual(["n_phone"]);
  });

  it("charges a join nothing for a meeting nobody wrote down", () => {
    const found = lint(laptopOnlyMeeting(), testContext());

    expect(found.filter((d) => d.ruleId === "space-unassigned").map((d) => d.nodeIds[0])).toEqual(
      [],
    );
  });

  it("is satisfied by one speakerphone standing in the room", () => {
    const found = lint(speakerphoneMeeting(), testContext());

    expect(ruleIds(found)).not.toContain("space-unassigned");
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
