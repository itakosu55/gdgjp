import { describe, expect, it } from "vitest";
import { testContext } from "./fixtures";
import { buildGraph } from "./graph";
import { layoutGraph } from "./layout";
import type { SetupDoc } from "./schema";

const HALL = { id: "sp_hall", kind: "acoustic", label: "メインホール" } as const;

function doc(partial: Partial<SetupDoc>): SetupDoc {
  return { schemaVersion: 1, spaces: [], nodes: [], links: [], routing: [], ...partial };
}

function layoutOf(partial: Partial<SetupDoc>) {
  const ctx = testContext();
  return layoutGraph(buildGraph(doc(partial), { devices: ctx.devices, models: ctx.models }));
}

function columnOf(layout: ReturnType<typeof layoutOf>, key: string): number | undefined {
  return layout.nodes.find((node) => node.key === key)?.column;
}

describe("layoutGraph", () => {
  it("orders a straight signal chain left to right", () => {
    const layout = layoutOf({
      nodes: [
        { id: "n_mic", deviceId: "d_mic1" },
        { id: "n_mixer", deviceId: "d_mixer" },
        { id: "n_pc", deviceId: "d_pc" },
      ],
      links: [
        { id: "l1", from: ["n_mic", "out"], to: ["n_mixer", "ch1"] },
        { id: "l2", from: ["n_mixer", "usb_send"], to: ["n_pc", "usb_in"] },
      ],
      routing: [{ nodeId: "n_mixer", inPort: "ch1", bus: "usb" }],
    });

    const mic = columnOf(layout, "n_mic") ?? -1;
    const mixer = columnOf(layout, "n_mixer") ?? -1;
    const pc = columnOf(layout, "n_pc") ?? -1;
    expect(mic).toBeLessThan(mixer);
    expect(mixer).toBeLessThan(pc);
  });

  it("includes the room as its own box", () => {
    const layout = layoutOf({
      spaces: [HALL],
      nodes: [{ id: "n_mic", deviceId: "d_mic1", spaceId: "sp_hall" }],
    });

    const space = layout.nodes.find((node) => node.key === "space:sp_hall");
    expect(space?.spaceKind).toBe("acoustic");
    expect(space?.label).toBe("メインホール");
  });

  // Cycles are the point of the tool, so ranking must not assume a DAG.
  describe("on a graph that howls", () => {
    const howling = {
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
    } satisfies Partial<SetupDoc>;

    it("terminates and keeps every node", () => {
      const layout = layoutOf(howling);
      expect(layout.nodes.map((node) => node.key).sort()).toEqual([
        "n_mic",
        "n_mixer",
        "n_speaker",
        "space:sp_hall",
      ]);
      expect(layout.columns).toBeGreaterThan(0);
    });

    // Relaxing around the loop used to add a column per pass, so a four-node
    // setup rendered thousands of pixels wide.
    it("never uses more columns than there are nodes", () => {
      const layout = layoutOf(howling);
      expect(layout.columns).toBeLessThanOrEqual(layout.nodes.length);
    });

    it("still orders the acyclic part of the chain left to right", () => {
      const layout = layoutOf(howling);
      expect(columnOf(layout, "n_mic") ?? -1).toBeLessThan(columnOf(layout, "n_mixer") ?? -1);
      expect(columnOf(layout, "n_mixer") ?? -1).toBeLessThan(columnOf(layout, "n_speaker") ?? -1);
    });
  });

  it("collapses the many port-level edges between two devices", () => {
    const layout = layoutOf({
      nodes: [
        { id: "n_cap", deviceId: "d_capture" },
        { id: "n_pc", deviceId: "d_pc" },
      ],
      links: [{ id: "l1", from: ["n_cap", "usb_out"], to: ["n_pc", "capture_in"] }],
    });

    const between = layout.edges.filter((edge) => edge.from === "n_cap" && edge.to === "n_pc");
    expect(between).toHaveLength(1);
  });
});
