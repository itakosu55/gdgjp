import { describe, expect, it } from "vitest";
import { testContext, twoJoinsInOneHall } from "./fixtures";
import {
  buildGraph,
  isHostAssignment,
  orientHostAssignment,
  portVertexId,
  spaceVertexId,
  transportVertexId,
} from "./graph";
import type { PortRef, SetupDoc } from "./schema";

const HALL = { id: "sp_hall", kind: "acoustic", label: "メインホール" } as const;

function doc(partial: Partial<SetupDoc>): SetupDoc {
  return { schemaVersion: 1, spaces: [], nodes: [], links: [], routing: [], ...partial };
}

function build(partial: Partial<SetupDoc>) {
  const ctx = testContext();
  return buildGraph(doc(partial), { devices: ctx.devices, models: ctx.models });
}

function hasEdge(
  graph: ReturnType<typeof build>,
  from: string,
  to: string,
  kind?: string,
): boolean {
  return graph.edges.some(
    (edge) => edge.from === from && edge.to === to && (kind ? edge.kind === kind : true),
  );
}

describe("internal routing", () => {
  it("creates matrix edges only for the cells the setup enables", () => {
    const graph = build({
      nodes: [{ id: "n_mixer", deviceId: "d_mixer" }],
      routing: [{ nodeId: "n_mixer", inPort: "ch1", bus: "aux1" }],
    });

    expect(
      hasEdge(graph, portVertexId("n_mixer", "ch1"), portVertexId("n_mixer", "aux1_out")),
    ).toBe(true);
    expect(
      hasEdge(graph, portVertexId("n_mixer", "ch1"), portVertexId("n_mixer", "main_out")),
    ).toBe(false);
  });

  it("passes every input to every output on a passthrough device", () => {
    const graph = build({ nodes: [{ id: "n_cap", deviceId: "d_capture" }] });

    expect(hasEdge(graph, portVertexId("n_cap", "hdmi_in"), portVertexId("n_cap", "usb_out"))).toBe(
      true,
    );
  });

  it("never connects a conferencing app's input to its own output", () => {
    const graph = build({
      nodes: [
        { id: "n_pc", deviceId: "d_pc" },
        { id: "n_meet", deviceId: "d_meet", hostNodeId: "n_pc" },
      ],
    });

    expect(
      hasEdge(graph, portVertexId("n_meet", "mic_in"), portVertexId("n_meet", "spk_out")),
    ).toBe(false);
  });
});

describe("space coupling", () => {
  it("feeds mics from the room and feeds the room from speakers", () => {
    const graph = build({
      spaces: [HALL],
      nodes: [
        { id: "n_mic", deviceId: "d_mic1", spaceId: "sp_hall" },
        { id: "n_speaker", deviceId: "d_speaker", spaceId: "sp_hall" },
      ],
    });

    expect(hasEdge(graph, spaceVertexId("sp_hall"), portVertexId("n_mic", "out"), "space")).toBe(
      true,
    );
    expect(hasEdge(graph, portVertexId("n_speaker", "in"), spaceVertexId("sp_hall"), "space")).toBe(
      true,
    );
  });

  it("suppresses coupling for an isolated mic", () => {
    const graph = build({
      spaces: [HALL],
      nodes: [{ id: "n_mic", deviceId: "d_mic1", spaceId: "sp_hall", coupling: "isolated" }],
    });

    expect(graph.edges.filter((edge) => edge.kind === "space")).toHaveLength(0);
  });

  it("records a mismatch when audio gear is assigned to a visual space", () => {
    const graph = build({
      spaces: [{ id: "sp_screen", kind: "visual", label: "スクリーン" }],
      nodes: [{ id: "n_mic", deviceId: "d_mic1", spaceId: "sp_screen" }],
    });

    expect(graph.issues).toContainEqual({
      kind: "space-kind-mismatch",
      nodeId: "n_mic",
      spaceId: "sp_screen",
    });
  });
});

describe("host links", () => {
  it("accepts a software output wired to a physical output of its host", () => {
    const graph = build({
      nodes: [
        { id: "n_pc", deviceId: "d_pc" },
        { id: "n_meet", deviceId: "d_meet", hostNodeId: "n_pc" },
      ],
      links: [{ id: "l1", from: ["n_meet", "spk_out"], to: ["n_pc", "headphone_out"] }],
    });

    expect(graph.issues).toHaveLength(0);
    expect(
      hasEdge(
        graph,
        portVertexId("n_meet", "spk_out"),
        portVertexId("n_pc", "headphone_out"),
        "host",
      ),
    ).toBe(true);
  });

  it("accepts a physical input of the host feeding the software", () => {
    const graph = build({
      nodes: [
        { id: "n_pc", deviceId: "d_pc" },
        { id: "n_meet", deviceId: "d_meet", hostNodeId: "n_pc" },
      ],
      links: [{ id: "l1", from: ["n_pc", "usb_in"], to: ["n_meet", "mic_in"] }],
    });

    expect(graph.issues).toHaveLength(0);
    expect(
      hasEdge(graph, portVertexId("n_pc", "usb_in"), portVertexId("n_meet", "mic_in"), "host"),
    ).toBe(true);
  });

  it("rejects the same shape between devices with no host relationship", () => {
    const graph = build({
      nodes: [
        { id: "n_pc", deviceId: "d_pc" },
        { id: "n_meet", deviceId: "d_meet" },
      ],
      links: [{ id: "l1", from: ["n_meet", "spk_out"], to: ["n_pc", "headphone_out"] }],
    });

    expect(graph.issues).toContainEqual({ kind: "bad-link-direction", linkId: "l1" });
  });
});

describe("signal media", () => {
  it("refuses to connect an audio port to a video port", () => {
    const graph = build({
      nodes: [
        { id: "n_mixer", deviceId: "d_mixer" },
        { id: "n_pc", deviceId: "d_pc" },
      ],
      links: [{ id: "l1", from: ["n_mixer", "main_out"], to: ["n_pc", "capture_in"] }],
    });

    expect(graph.issues).toContainEqual({ kind: "link-media-mismatch", linkId: "l1" });
  });
});

// `links` carries two relationships that behave nothing alike, and the editor
// has to tell them apart to stop asking people to know the out→out rule.
describe("telling a device selection from a cable", () => {
  const setup = doc({
    nodes: [
      { id: "n_mixer", deviceId: "d_mixer" },
      { id: "n_pc", deviceId: "d_pc" },
      { id: "n_obs", deviceId: "d_obs", hostNodeId: "n_pc" },
    ],
    links: [
      { id: "l1", from: ["n_mixer", "usb_send"], to: ["n_pc", "usb_in"] },
      { id: "l2", from: ["n_pc", "usb_in"], to: ["n_obs", "audio_in"] },
      { id: "l3", from: ["n_obs", "monitor_out"], to: ["n_pc", "headphone_out"] },
    ],
  });

  it("calls a cable a cable", () => {
    const cable = setup.links.find((link) => link.id === "l1");
    expect(cable && isHostAssignment(setup, cable)).toBe(false);
  });

  it("recognises a selection whichever way round the link is stored", () => {
    for (const id of ["l2", "l3"]) {
      const link = setup.links.find((entry) => entry.id === id);
      expect(link && isHostAssignment(setup, link)).toBe(true);
    }
  });

  it("does not mistake two unrelated nodes for a host pair", () => {
    const unrelated = doc({
      nodes: [
        { id: "n_mixer", deviceId: "d_mixer" },
        { id: "n_pc", deviceId: "d_pc" },
      ],
      links: [{ id: "l1", from: ["n_mixer", "usb_send"], to: ["n_pc", "usb_in"] }],
    });
    const link = unrelated.links[0];
    expect(link && isHostAssignment(unrelated, link)).toBe(false);
  });
});

describe("orienting a device selection", () => {
  const app = ["n_obs", "audio_in"] as PortRef;
  const host = ["n_pc", "usb_in"] as PortRef;

  // An app capturing from a jack: the signal runs host → app.
  it("points a capture at the app", () => {
    const oriented = orientHostAssignment(
      { ref: app, direction: "in" },
      { ref: host, direction: "in" },
    );
    expect(oriented).toEqual({ from: host, to: app });
  });

  // An app playing into a jack: the signal runs app → host.
  it("points playback at the host", () => {
    const oriented = orientHostAssignment(
      { ref: ["n_obs", "monitor_out"], direction: "out" },
      { ref: ["n_pc", "headphone_out"], direction: "out" },
    );
    expect(oriented).toEqual({
      from: ["n_obs", "monitor_out"],
      to: ["n_pc", "headphone_out"],
    });
  });

  it("refuses a pair whose directions disagree", () => {
    expect(
      orientHostAssignment({ ref: app, direction: "in" }, { ref: host, direction: "out" }),
    ).toBeNull();
  });
});

describe("transport spaces", () => {
  const ctx = testContext();
  const graph = buildGraph(twoJoinsInOneHall(), { devices: ctx.devices, models: ctx.models });
  const fromStream = transportVertexId("sp_mtg", "n_join_stream");
  const fromLaptop = transportVertexId("sp_mtg", "n_join_laptop");

  it("splits the meeting into one vertex per sending join", () => {
    expect(graph.vertices.get(fromStream)).toMatchObject({ type: "space", kind: "transport" });
    expect(graph.vertices.get(fromLaptop)).toMatchObject({ type: "space", kind: "transport" });
    // No undivided vertex: a meeting is only ever entered as somebody's send.
    expect(graph.vertices.get(spaceVertexId("sp_mtg"))).toBeUndefined();
  });

  it("carries a join's input into its own sender vertex", () => {
    expect(hasEdge(graph, portVertexId("n_join_laptop", "mic_in"), fromLaptop, "space")).toBe(true);
  });

  it("never returns a join its own audio", () => {
    // The absent self-edge *is* the Mix-Minus a conference bridge performs
    // internally. Expressing it as a missing edge is what keeps `paths.ts` a
    // generic search with no knowledge of join identity.
    expect(hasEdge(graph, fromLaptop, portVertexId("n_join_laptop", "spk_out"))).toBe(false);
    expect(hasEdge(graph, fromLaptop, portVertexId("n_join_stream", "spk_out"))).toBe(true);
  });

  it("keeps audio and video on separate edges through one meeting", () => {
    const audio = graph.edges.find(
      (edge) => edge.from === fromLaptop && edge.to === portVertexId("n_join_stream", "spk_out"),
    );
    const video = graph.edges.find(
      (edge) =>
        edge.from === fromLaptop && edge.to === portVertexId("n_join_stream", "cam_video_out"),
    );
    expect(audio?.media).toEqual(["audio"]);
    expect(video?.media).toEqual(["video"]);
  });

  it("leaves a single-join meeting a dead end", () => {
    const single = twoJoinsInOneHall();
    const graph = buildGraph(
      {
        ...single,
        nodes: single.nodes.filter((node) => node.id !== "n_join_laptop"),
        links: single.links.filter((link) => link.id !== "l6"),
      },
      { devices: ctx.devices, models: ctx.models },
    );

    // One online speaker is the commonest setup by far, and §9.3 requires it to
    // behave exactly as it did before transport spaces existed.
    expect(graph.outgoing.get(transportVertexId("sp_mtg", "n_join_stream")) ?? []).toEqual([]);
  });

  it("resolves a node that names a model instead of a ledger unit", () => {
    expect(graph.nodes.get("n_join_stream")?.device).toBeNull();
    expect(graph.nodes.get("n_join_stream")?.model.id).toBe("m_meet");
    expect(graph.issues).toEqual([]);
  });
});
