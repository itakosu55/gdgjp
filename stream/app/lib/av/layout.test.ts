import { describe, expect, it } from "vitest";
import { testContext } from "./fixtures";
import { buildGraph } from "./graph";
import type { LayoutNode } from "./layout";
import { layoutGraph } from "./layout";
import { lint } from "./lint";
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

  // A cable ends at a jack. Wiring by hand later needs the jack, not the box.
  describe("ports", () => {
    it("anchors a cable on the ports the link names", () => {
      const layout = layoutOf({
        nodes: [
          { id: "n_mic", deviceId: "d_mic1" },
          { id: "n_mixer", deviceId: "d_mixer" },
        ],
        links: [{ id: "l1", from: ["n_mic", "out"], to: ["n_mixer", "ch1"] }],
      });

      const cable = layout.edges.find((edge) => edge.linkId === "l1");
      expect(cable?.fromPort).toBe("out");
      expect(cable?.toPort).toBe("ch1");

      const mixer = layout.nodes.find((node) => node.key === "n_mixer");
      const ch1 = mixer?.ports.find((port) => port.key === "ch1");
      expect(ch1?.side).toBe("left");
      expect(cable?.points.at(-1)).toEqual({ x: ch1?.x, y: ch1?.y });
    });

    it("places every port of the model, wired or not", () => {
      const layout = layoutOf({ nodes: [{ id: "n_mixer", deviceId: "d_mixer" }] });

      const mixer = layout.nodes.find((node) => node.key === "n_mixer");
      const ctx = testContext();
      const model = ctx.models.get(ctx.devices.get("d_mixer")?.modelId ?? "");
      expect(mixer?.ports.map((port) => port.key)).toEqual(model?.ports.map((port) => port.key));
    });

    // The anchors must not depend on which links exist, or drawing one cable
    // would move the ones already on screen.
    it("keeps a port anchor still when another cable is added", () => {
      const nodes = [
        { id: "n_mic", deviceId: "d_mic1" },
        { id: "n_mic2", deviceId: "d_mic2" },
        { id: "n_mixer", deviceId: "d_mixer" },
      ];
      const before = layoutOf({
        nodes,
        links: [{ id: "l1", from: ["n_mic", "out"], to: ["n_mixer", "ch1"] }],
      });
      const after = layoutOf({
        nodes,
        links: [
          { id: "l1", from: ["n_mic", "out"], to: ["n_mixer", "ch1"] },
          { id: "l2", from: ["n_mic2", "out"], to: ["n_mixer", "ch2"] },
        ],
      });

      const offsetOfCh1 = (layout: ReturnType<typeof layoutOf>) => {
        const mixer = layout.nodes.find((node) => node.key === "n_mixer");
        const port = mixer?.ports.find((entry) => entry.key === "ch1");
        return mixer && port ? port.y - mixer.y : null;
      };
      expect(offsetOfCh1(after)).not.toBeNull();
      expect(offsetOfCh1(after)).toBe(offsetOfCh1(before));
    });
  });

  // Long edges used to be one straight line, so they were drawn straight over
  // whatever sat in the columns in between.
  it("routes an edge that skips a column clear of the boxes there", () => {
    const layout = layoutOf({
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

    for (const edge of layout.edges) {
      for (const box of layout.nodes) {
        if (box.key === edge.from || box.key === edge.to) continue;
        expect(crosses(edge.points, box)).toBe(false);
      }
    }
  });

  // Longest path alone put a device wherever the wiring led, and which edge got
  // cut to break a loop depended on the order the search happened to visit.
  describe("column bands", () => {
    const stage = {
      spaces: [HALL],
      nodes: [
        { id: "n_mic", deviceId: "d_mic1", spaceId: "sp_hall" },
        { id: "n_mic2", deviceId: "d_mic2", spaceId: "sp_hall" },
        { id: "n_mixer", deviceId: "d_mixer" },
        { id: "n_speaker", deviceId: "d_speaker", spaceId: "sp_hall" },
        { id: "n_pc", deviceId: "d_pc" },
        { id: "n_obs", deviceId: "d_obs", hostNodeId: "n_pc" },
      ],
      links: [
        { id: "l1", from: ["n_mic", "out"], to: ["n_mixer", "ch1"] },
        { id: "l2", from: ["n_mic2", "out"], to: ["n_mixer", "ch2"] },
        { id: "l3", from: ["n_mixer", "main_out"], to: ["n_speaker", "in"] },
        { id: "l4", from: ["n_mixer", "usb_send"], to: ["n_pc", "usb_in"] },
        { id: "l5", from: ["n_pc", "usb_in"], to: ["n_obs", "audio_in"] },
      ],
      routing: [
        { nodeId: "n_mixer", inPort: "ch1", bus: "main" },
        { nodeId: "n_mixer", inPort: "ch1", bus: "usb" },
        { nodeId: "n_mixer", inPort: "ch2", bus: "main" },
      ],
    } satisfies Partial<SetupDoc>;

    // Two identical mics used to split across columns, because the loop search
    // reached one through the room and the other through the mixer.
    it("puts two of the same device in the same column", () => {
      const layout = layoutOf(stage);
      expect(columnOf(layout, "n_mic2")).toBe(columnOf(layout, "n_mic"));
    });

    it("pins every input to the leftmost column", () => {
      const layout = layoutOf(stage);
      for (const node of layout.nodes) {
        if (node.role === "input") expect(node.column).toBe(0);
      }
    });

    it("puts the outputs right of everything that is not one", () => {
      const layout = layoutOf(stage);
      // OBS is an output too, but it runs on the PC and sits with it — see the
      // host-pinning test below.
      const outputs = layout.nodes.filter((node) => node.role === "output" && node.key !== "n_obs");
      const rest = layout.nodes.filter((node) => node.role === "input" || node.role === "hub");
      const deepest = Math.max(...rest.map((node) => node.column));
      expect(outputs.length).toBeGreaterThan(0);
      for (const output of outputs) expect(output.column).toBeGreaterThan(deepest);
    });

    // An app is inside the machine, not another stage of the chain. Ranking it
    // by where the signal reaches put OBS out among the speakers.
    it("sits an app in the same column as the computer it runs on", () => {
      const layout = layoutOf(stage);
      expect(columnOf(layout, "n_obs")).toBe(columnOf(layout, "n_pc"));
    });

    it("draws the link to the host inside the column, not as a return path", () => {
      const layout = layoutOf(stage);
      const hostLink = layout.edges.find((edge) => edge.linkId === "l5");
      expect(hostLink?.back).toBe(false);
      const spread = (hostLink?.points ?? []).map((point) => point.x);
      const pc = layout.nodes.find((node) => node.key === "n_pc");
      // It never leaves the neighbourhood of the column it lives in.
      for (const x of spread) {
        expect(x).toBeGreaterThan((pc?.x ?? 0) - 60);
        expect(x).toBeLessThan((pc?.x ?? 0) + (pc?.width ?? 0) + 60);
      }
    });

    // Role still wins: a remote participant belongs with the mics, not inside
    // the machine that happens to run the app.
    it("leaves a conferencing app pinned left even though it has a host", () => {
      const layout = layoutOf({
        ...stage,
        nodes: [...stage.nodes, { id: "n_meet", deviceId: "d_meet", hostNodeId: "n_pc" }],
      });
      expect(columnOf(layout, "n_meet")).toBe(0);
      expect(columnOf(layout, "n_pc")).toBeGreaterThan(0);
    });

    // A conferencing app is both, and is classified as an input on purpose.
    it("treats a conferencing app as an input", () => {
      const layout = layoutOf({
        nodes: [
          { id: "n_mixer", deviceId: "d_mixer" },
          { id: "n_pc", deviceId: "d_pc" },
          { id: "n_meet", deviceId: "d_meet", hostNodeId: "n_pc" },
        ],
        links: [
          { id: "l1", from: ["n_mixer", "usb_send"], to: ["n_pc", "usb_in"] },
          { id: "l2", from: ["n_pc", "usb_in"], to: ["n_meet", "mic_in"] },
          { id: "l3", from: ["n_meet", "spk_out"], to: ["n_pc", "usb_out"] },
          { id: "l4", from: ["n_pc", "usb_out"], to: ["n_mixer", "usb_in"] },
        ],
        routing: [{ nodeId: "n_mixer", inPort: "usb_in", bus: "usb" }],
      });

      expect(columnOf(layout, "n_meet")).toBe(0);
      // The send back to the remote participant becomes a return path.
      const send = layout.edges.find((edge) => edge.linkId === "l2");
      expect(send?.back).toBe(true);
    });

    it("still never uses more columns than there are nodes", () => {
      const layout = layoutOf(stage);
      expect(layout.columns).toBeLessThanOrEqual(layout.nodes.length);
    });

    it("bands the columns left to right, and covers every one of them", () => {
      const layout = layoutOf(stage);
      expect(layout.bands.map((band) => band.role)).toEqual(["input", "hub", "output", "space"]);

      const covered = new Set<number>();
      for (const band of layout.bands) {
        for (let col = band.fromColumn; col <= band.toColumn; col++) covered.add(col);
      }
      for (const node of layout.nodes) expect(covered.has(node.column)).toBe(true);
    });

    it("keeps the bands apart and inside the canvas", () => {
      const layout = layoutOf(stage);
      let previousRight = 0;
      for (const band of layout.bands) {
        expect(band.x).toBeGreaterThanOrEqual(previousRight);
        expect(band.x + band.width).toBeLessThanOrEqual(layout.width);
        previousRight = band.x + band.width;
      }
    });
  });

  // Red in the diagram means "the linter reported this", and the linter reports
  // graph edges. Room coupling collapses several of those into one line, so the
  // line has to carry all of them or the loop would draw as innocent.
  describe("tracing a drawn line back to the graph", () => {
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

    it("names the graph edges behind every line", () => {
      const layout = layoutOf(howling);
      const ctx = testContext();
      const graph = buildGraph(doc(howling), { devices: ctx.devices, models: ctx.models });
      const known = new Set(graph.edges.map((edge) => edge.id));

      for (const edge of layout.edges) {
        expect(edge.sourceIds.length).toBeGreaterThan(0);
        for (const id of edge.sourceIds) expect(known.has(id)).toBe(true);
      }
    });

    it("lets a reported cycle be found on the diagram", () => {
      const setup = doc(howling);
      const ctx = testContext();
      const layout = layoutOf(howling);
      const cycles = lint(setup, { ...ctx, siblingSetups: [] }).flatMap(
        (diagnostic) => diagnostic.cycle ?? [],
      );
      expect(cycles.length).toBeGreaterThan(0);

      const alerts = new Set(cycles.map((edge) => edge.id));
      const lit = layout.edges.filter((edge) => edge.sourceIds.some((id) => alerts.has(id)));
      // The room feeding the mic is part of the howl, and it is a collapsed edge.
      expect(lit.some((edge) => edge.kind === "space")).toBe(true);
    });
  });

  it("is stable when re-laid out from its own order", () => {
    const setup = {
      spaces: [HALL],
      nodes: [
        { id: "n_mic", deviceId: "d_mic1", spaceId: "sp_hall" },
        { id: "n_mixer", deviceId: "d_mixer" },
        { id: "n_speaker", deviceId: "d_speaker", spaceId: "sp_hall" },
      ],
      links: [{ id: "l1", from: ["n_mic", "out"], to: ["n_mixer", "ch1"] }],
    } satisfies Partial<SetupDoc>;

    const first = layoutOf(setup);
    const ctx = testContext();
    const again = layoutGraph(
      buildGraph(doc(setup), { devices: ctx.devices, models: ctx.models }),
      { order: first.order },
    );
    expect(again.order).toEqual(first.order);
    expect(again.nodes.map((node) => [node.key, node.x, node.y])).toEqual(
      first.nodes.map((node) => [node.key, node.x, node.y]),
    );
  });
});

/** Does a routed cable pass over a box it has nothing to do with? */
function crosses(points: readonly { x: number; y: number }[], box: LayoutNode): boolean {
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    if (!a || !b) continue;
    if (segmentHitsBox(a, b, box)) return true;
  }
  return false;
}

function segmentHitsBox(
  a: { x: number; y: number },
  b: { x: number; y: number },
  box: LayoutNode,
): boolean {
  const steps = 48;
  for (let step = 0; step <= steps; step++) {
    const t = step / steps;
    const x = a.x + (b.x - a.x) * t;
    const y = a.y + (b.y - a.y) * t;
    if (x > box.x + 1 && x < box.x + box.width - 1 && y > box.y + 1 && y < box.y + box.height - 1) {
      return true;
    }
  }
  return false;
}
