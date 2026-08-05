import { describe, expect, it } from "vitest";
import { testContext } from "./fixtures";
import { buildGraph, portVertexId, spaceVertexId } from "./graph";
import type { SetupDoc } from "./schema";

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
