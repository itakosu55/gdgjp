import { describe, expect, it } from "vitest";
import {
  OBS_SOURCES,
  halfSharedScreen,
  hybridMonitorMix,
  remoteGuestOnBuiltins,
  satelliteRooms,
  speakerphoneMeeting,
  testContext,
  twoJoinsInOneHall,
} from "./fixtures";
import { buildGraph } from "./graph";
import type { LayoutEdge, LayoutNode } from "./layout";
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

/**
 * A device selection, found by the app jack that made it.
 *
 * Assignments carry no `linkId` — they are not links any more (§12.4.1) — so
 * the jack is what identifies one.
 */
function selectionOf(layout: ReturnType<typeof layoutOf>, portKey: string) {
  return layout.edges.find(
    (edge) => edge.kind === "host" && (edge.fromPort === portKey || edge.toPort === portKey),
  );
}

function nodeOf(layout: ReturnType<typeof layoutOf>, key: string): LayoutNode | undefined {
  return layout.nodes.find((node) => node.key === key);
}

type Rect = { x: number; y: number; width: number; height: number };

function encloses(outer: Rect, inner: Rect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  );
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
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

  /**
   * Crossing and overlapping are not the same problem. Two cables that cross
   * read as two cables — that is what the halo under each line is for — but two
   * drawn along the same run are one line on screen, and where they end
   * together they are one arrowhead, so the picture quietly under-reports the
   * wiring. A hall with two speakers and a laptop in it drew three couplings
   * into one point.
   */
  describe("lines that would be drawn on top of each other", () => {
    const rigs = {
      twoJoinsInOneHall,
      satelliteRooms,
      remoteGuestOnBuiltins,
      speakerphoneMeeting,
      hybridMonitorMix,
      halfSharedScreen,
    };

    for (const [name, rig] of Object.entries(rigs)) {
      it(`draws no two lines along one another in ${name}`, () => {
        const layout = layoutOf(rig());
        expect(sharedRuns(layout)).toEqual([]);
      });

      it(`puts one arrowhead per line in ${name}`, () => {
        const layout = layoutOf(rig());
        for (const [point, edges] of endpoints(layout)) {
          // Unless they really are the same jack — two feeds on one row is what
          // `shared-source-strip` is a finding about, so the picture has to go
          // on saying it.
          const jacks = new Set(edges.map((edge) => jackOf(edge, "to")));
          expect([point, [...jacks]]).toEqual([point, [...jacks].slice(0, 1)]);
        }
      });

      // Not drawn as one line, but drawn nearer than lines are anywhere else,
      // which under-reports them just as surely once the reader zooms out.
      it(`gives a line inside a machine the room a line outside it has in ${name}`, () => {
        expect(crowdedRuns(layoutOf(rig()))).toEqual([]);
      });

      it(`keeps the returns into the first column a pitch apart in ${name}`, () => {
        const runs = marginRuns(layoutOf(rig()));
        for (let i = 1; i < runs.length; i++) {
          expect((runs[i] ?? 0) - (runs[i - 1] ?? 0)).toBeGreaterThanOrEqual(PITCH - 0.01);
        }
      });
    }

    // Every other left face has a whole column gap to stand off in. The first
    // has the page margin, and a hall returning into three mics put three
    // risers into fourteen pixels, one of them ten from the edge of the picture.
    describe("the page margin the first column's returns stand in", () => {
      const hall = (mics: string[]): Partial<SetupDoc> => ({
        spaces: [HALL],
        nodes: [
          ...mics.map((deviceId, index) => ({
            id: `n_mic${index}`,
            deviceId,
            spaceId: "sp_hall",
          })),
          { id: "n_mixer", deviceId: "d_mixer" },
          { id: "n_speaker", deviceId: "d_speaker", spaceId: "sp_hall" },
        ],
        links: [
          ...mics.map((_, index): SetupDoc["links"][number] => ({
            id: `l${index}`,
            from: [`n_mic${index}`, "out"],
            to: ["n_mixer", index === 0 ? "ch1" : "ch2"],
          })),
          { id: "lp", from: ["n_mixer", "main_out"], to: ["n_speaker", "in"] },
        ],
      });

      it("widens with the number of returns standing in it", () => {
        const one = layoutOf(hall(["d_mic1"]));
        const three = layoutOf(hall(["d_mic1", "d_mic2", "d_condenser"]));
        expect(marginRuns(three).length).toBe(3);
        expect(firstColumnX(three)).toBeGreaterThan(firstColumnX(one));
      });

      // The innermost riser stands where a single riser has always stood, and
      // the outermost is as far from the edge of the picture either way.
      it("leaves the same room at both ends however many there are", () => {
        const one = layoutOf(hall(["d_mic1"]));
        const three = layoutOf(hall(["d_mic1", "d_mic2", "d_condenser"]));
        expect(marginRuns(three)[0]).toBe(marginRuns(one)[0]);
        expect(firstColumnX(three) - (marginRuns(three).at(-1) ?? 0)).toBe(
          firstColumnX(one) - (marginRuns(one).at(-1) ?? 0),
        );
      });
    });

    // The room a machine's cables need is the machine's problem, not theirs.
    it("widens the machine rather than the app it holds", () => {
      const quiet = layoutOf({
        nodes: [
          { id: "n_pc", deviceId: "d_pc" },
          { id: "n_obs", deviceId: "d_obs", hostNodeId: "n_pc", ports: OBS_SOURCES },
        ],
      });
      const busy = layoutOf(hybridMonitorMix());

      expect(nodeOf(busy, "n_obs")?.width).toBe(nodeOf(quiet, "n_obs")?.width);
      expect(nodeOf(busy, "n_pc")?.width).toBeGreaterThan(nodeOf(quiet, "n_pc")?.width ?? 0);
    });

    // What a wider machine must not spend is the gap the next column's cables
    // stand off in: every riser in the picture assumes it has all of one.
    it("leaves the same gap between two columns however wide a machine got", () => {
      const layout = layoutOf(hybridMonitorMix());
      const tops = layout.nodes.filter((node) => node.parentKey === null);
      const gaps: number[] = [];
      for (let col = 0; col + 1 < layout.columns; col++) {
        const inColumn = tops.filter((node) => node.column === col);
        const next = tops.filter((node) => node.column === col + 1);
        if (inColumn.length === 0 || next.length === 0) continue;
        const right = Math.max(...inColumn.map((node) => node.x + node.width));
        gaps.push(Math.min(...next.map((node) => node.x)) - right);
      }
      expect(gaps.length).toBeGreaterThan(1);
      expect(new Set(gaps).size).toBe(1);
    });

    // A room has no jacks to hang them on, so every cable used to meet it in
    // the middle of its face.
    it("gives every coupling into a room a row of its own", () => {
      const layout = layoutOf(twoJoinsInOneHall());
      const hall = nodeOf(layout, "space:sp_hall");
      const into = layout.edges.filter((edge) => edge.to === "space:sp_hall");
      const rows = new Set(into.map((edge) => edge.points.at(-1)?.y));
      expect(into.length).toBeGreaterThan(1);
      expect(rows.size).toBe(into.length);
      // And the room is as tall as the rows it hands out.
      for (const y of rows) {
        expect(y).toBeGreaterThanOrEqual(hall?.y ?? 0);
        expect(y).toBeLessThanOrEqual((hall?.y ?? 0) + (hall?.height ?? 0));
      }
    });

    // The risers stand off the columns, so the picture has to be measured from
    // the lines and not only from the boxes.
    it("keeps every line inside the picture", () => {
      for (const rig of Object.values(rigs)) {
        const layout = layoutOf(rig());
        for (const edge of layout.edges) {
          for (const point of edge.points) {
            expect(point.x).toBeGreaterThanOrEqual(0);
            expect(point.x).toBeLessThanOrEqual(layout.width);
            expect(point.y).toBeLessThanOrEqual(layout.height);
          }
        }
      }
    });
  });

  /**
   * A loop that closes inside one room is a fact about that room, and used to be
   * drawn under the whole picture like every other return: down past every room
   * in between, along the bottom of the page, and back up again — so the reader
   * follows a line out of the frame and home to say that nothing left it.
   */
  describe("where a return path runs", () => {
    /** The frame a line's end is in, taken from the box it is drawn inside. */
    function frameOfEnd(layout: ReturnType<typeof layoutOf>, key: string): string | null {
      let node = nodeOf(layout, key);
      while (node?.parentKey) node = nodeOf(layout, node.parentKey);
      return node?.frameKey ?? null;
    }

    function returns(layout: ReturnType<typeof layoutOf>, home: boolean): LayoutEdge[] {
      return layout.edges.filter((edge) => {
        if (!edge.back) return false;
        const from = frameOfEnd(layout, edge.from);
        return (from !== null && from === frameOfEnd(layout, edge.to)) === home;
      });
    }

    /** How far down a line reaches, which for a return is the lane it runs in. */
    function lane(edge: LayoutEdge): number {
      return Math.max(...edge.points.map((point) => point.y));
    }

    function floorOf(layout: ReturnType<typeof layoutOf>): number {
      return Math.max(...layout.nodes.map((node) => node.y + node.height));
    }

    it("runs a return that comes home inside the room it left", () => {
      const layout = layoutOf(satelliteRooms());
      expect(layout.frames).toHaveLength(2);
      for (const frame of layout.frames) {
        const home = returns(layout, true).filter(
          (edge) => frameOfEnd(layout, edge.from) === frame.key,
        );
        expect(home.length).toBeGreaterThan(0);
        for (const edge of home) {
          // Strictly inside, on every side: a riser left on the border reads as
          // a cable leaving the room, which is what this one does not do.
          for (const point of edge.points) {
            expect(point.x).toBeGreaterThan(frame.x);
            expect(point.x).toBeLessThan(frame.x + frame.width);
            expect(point.y).toBeGreaterThan(frame.y);
            expect(point.y).toBeLessThan(frame.y + frame.height);
          }
        }
      }
    });

    // The case this is all for: a hall feeding the microphone standing in it.
    it("stops taking a hall's return into its own mic under the picture", () => {
      const layout = layoutOf(twoJoinsInOneHall());
      const home = layout.edges.find(
        (edge) => edge.from === "space:sp_hall" && edge.to === "n_mic",
      );
      expect(home?.back).toBe(true);
      expect(home && lane(home)).toBeLessThan(floorOf(layout));
    });

    // A meeting is not a place (`placeKeyOf`), so a return out of one is between
    // two rooms however few of them are on the page.
    it("keeps a return that leaves its room under the whole picture", () => {
      const layout = layoutOf(satelliteRooms());
      const across = returns(layout, false);
      expect(across.length).toBeGreaterThan(0);
      for (const edge of across) expect(lane(edge)).toBeGreaterThan(floorOf(layout));
    });

    // The band is counted before the rows are assigned and handed out after, so
    // a room sized for two returns that turns out to hold three would draw the
    // third through the room below it.
    it("gives every return in one room a lane of its own", () => {
      for (const rig of [satelliteRooms, twoJoinsInOneHall, hybridMonitorMix]) {
        const layout = layoutOf(rig());
        const home = returns(layout, true);
        expect(new Set(home.map(lane)).size).toBe(home.length);
      }
    });
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
        {
          id: "n_obs",
          deviceId: "d_obs",
          hostNodeId: "n_pc",
          ports: OBS_SOURCES,
          assignments: [{ port: "audio_src:1", hostPort: "usb_in" }],
        },
      ],
      links: [
        { id: "l1", from: ["n_mic", "out"], to: ["n_mixer", "ch1"] },
        { id: "l2", from: ["n_mic2", "out"], to: ["n_mixer", "ch2"] },
        { id: "l3", from: ["n_mixer", "main_out"], to: ["n_speaker", "in"] },
        { id: "l4", from: ["n_mixer", "usb_send"], to: ["n_pc", "usb_in"] },
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

    // A room is where the chain folds back, not a stage of it. Ranked by its
    // inflow, the acoustic half of a hall landed past the speakers while the
    // visual half — nothing emits into a room with only a camera in it — stayed
    // at column 0, so one room drew at both ends of the picture.
    describe("a place's two spaces", () => {
      const hall = {
        spaces: [
          { id: "sp_air", kind: "acoustic", label: "ホール", venueKey: "hall" },
          { id: "sp_sight", kind: "visual", label: "ホール (視界)", venueKey: "hall" },
        ],
        nodes: [
          { id: "n_mic", deviceId: "d_mic1", spaceId: "sp_air" },
          { id: "n_camera", deviceId: "d_camera", spaceId: "sp_sight" },
          { id: "n_mixer", deviceId: "d_mixer" },
          { id: "n_speaker", deviceId: "d_speaker", spaceId: "sp_air" },
          { id: "n_pc", deviceId: "d_pc" },
        ],
        links: [
          { id: "l1", from: ["n_mic", "out"], to: ["n_mixer", "ch1"] },
          { id: "l2", from: ["n_mixer", "main_out"], to: ["n_speaker", "in"] },
          { id: "l3", from: ["n_mixer", "usb_send"], to: ["n_pc", "usb_in"] },
        ],
        routing: [
          { nodeId: "n_mixer", inPort: "ch1", bus: "main" },
          { nodeId: "n_mixer", inPort: "ch1", bus: "usb" },
        ],
      } satisfies Partial<SetupDoc>;

      it("puts both halves of one place in the same column", () => {
        const layout = layoutOf(hall);
        expect(columnOf(layout, "space:sp_sight")).toBe(columnOf(layout, "space:sp_air"));
      });

      // Which half happened to be added first is not something the reader knows.
      it("puts them there whichever half the document names first", () => {
        const layout = layoutOf({ ...hall, spaces: [...hall.spaces].reverse() });
        expect(columnOf(layout, "space:sp_sight")).toBe(columnOf(layout, "space:sp_air"));
      });

      it("keeps every room right of every output", () => {
        const layout = layoutOf(hall);
        const rooms = layout.nodes.filter((node) => node.spaceKind !== null);
        const outputs = layout.nodes.filter((node) => node.role === "output");
        expect(rooms).toHaveLength(2);
        expect(outputs.length).toBeGreaterThan(0);
        for (const room of rooms) {
          for (const output of outputs) expect(room.column).toBeGreaterThan(output.column);
        }
      });

      // Sharing a column is not enough: neither half has a forward edge, so
      // their rows came from the document too, and the pair swapped top for
      // bottom depending on which was typed first.
      it("draws the air above the sight whichever half came first", () => {
        for (const spaces of [hall.spaces, [...hall.spaces].reverse()]) {
          const layout = layoutOf({ ...hall, spaces });
          const air = nodeOf(layout, "space:sp_air");
          const sight = nodeOf(layout, "space:sp_sight");
          expect(air && sight && air.y < sight.y).toBe(true);
        }
      });

      // The caption used to come from whichever half was declared first, so
      // renaming a hall moved it only half the time.
      it("captions the frame from the acoustic half whichever half came first", () => {
        for (const spaces of [hall.spaces, [...hall.spaces].reverse()]) {
          const layout = layoutOf({ ...hall, spaces });
          expect(layout.frames.map((frame) => frame.label)).toEqual(["ホール"]);
        }
      });
    });

    // An app is inside the machine, not another stage of the chain. Ranking it
    // by where the signal reaches put OBS out among the speakers.
    it("sits an app in the same column as the computer it runs on", () => {
      const layout = layoutOf(stage);
      expect(columnOf(layout, "n_obs")).toBe(columnOf(layout, "n_pc"));
    });

    it("draws the link to the host inside the column, not as a return path", () => {
      const layout = layoutOf(stage);
      const hostLink = selectionOf(layout, "audio_src:1");
      expect(hostLink?.back).toBe(false);
      const spread = (hostLink?.points ?? []).map((point) => point.x);
      const pc = layout.nodes.find((node) => node.key === "n_pc");
      // It never leaves the neighbourhood of the column it lives in.
      for (const x of spread) {
        expect(x).toBeGreaterThan((pc?.x ?? 0) - 60);
        expect(x).toBeLessThan((pc?.x ?? 0) + (pc?.width ?? 0) + 60);
      }
    });

    // A conferencing app used to be pinned left whatever machine it ran on,
    // which put a laptop's Meet window a long way from the laptop. It is inside
    // the machine, so it goes inside the machine; the role only tints the band.
    it("nests a conferencing app in its host rather than pinning it left", () => {
      const layout = layoutOf({
        ...stage,
        nodes: [...stage.nodes, { id: "n_meet", deviceId: "d_meet", hostNodeId: "n_pc" }],
      });
      expect(columnOf(layout, "n_meet")).toBe(columnOf(layout, "n_pc"));
      expect(nodeOf(layout, "n_meet")?.parentKey).toBe("n_pc");
    });

    // A conferencing app is both, and is classified as an input on purpose.
    it("treats a conferencing app as an input", () => {
      const layout = layoutOf({
        nodes: [
          { id: "n_mixer", deviceId: "d_mixer" },
          { id: "n_pc", deviceId: "d_pc" },
          {
            id: "n_meet",
            deviceId: "d_meet",
            hostNodeId: "n_pc",
            assignments: [
              { port: "mic_in", hostPort: "usb_in" },
              { port: "spk_out", hostPort: "usb_out" },
            ],
          },
        ],
        links: [
          { id: "l1", from: ["n_mixer", "usb_send"], to: ["n_pc", "usb_in"] },
          { id: "l4", from: ["n_pc", "usb_out"], to: ["n_mixer", "usb_in"] },
        ],
        routing: [{ nodeId: "n_mixer", inPort: "usb_in", bus: "usb" }],
      });

      expect(nodeOf(layout, "n_meet")?.role).toBe("input");
      // Both ends of the device selection are one machine, so neither of them
      // is a return path.
      expect(selectionOf(layout, "mic_in")?.back).toBe(false);
      expect(selectionOf(layout, "spk_out")?.back).toBe(false);
    });

    // A join used only to send to a satellite room is a sink, not a source.
    // Pinning it left would cut the edge feeding it and drop the entire main
    // signal into the return lane, which makes the diagram lie.
    it("treats a send-only join as an output", () => {
      const layout = layoutOf({
        nodes: [
          { id: "n_mic", deviceId: "d_mic1" },
          { id: "n_mixer", deviceId: "d_mixer" },
          { id: "n_pc", deviceId: "d_pc" },
          {
            id: "n_join",
            modelId: "m_meet",
            hostNodeId: "n_pc",
            assignments: [{ port: "mic_in", hostPort: "usb_in" }],
          },
        ],
        links: [
          { id: "l1", from: ["n_mic", "out"], to: ["n_mixer", "ch1"] },
          { id: "l2", from: ["n_mixer", "usb_send"], to: ["n_pc", "usb_in"] },
        ],
        routing: [{ nodeId: "n_mixer", inPort: "ch1", bus: "usb" }],
      });

      expect(layout.nodes.find((node) => node.key === "n_join")?.role).toBe("output");
      expect(columnOf(layout, "n_join")).toBeGreaterThan(0);
      expect(selectionOf(layout, "mic_in")?.back).toBe(false);
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

  // What contains what is the one thing the columns cannot say: where a thing
  // is has nothing to do with which stage of the chain it is.
  describe("containment", () => {
    const machine = {
      nodes: [
        { id: "n_mixer", deviceId: "d_mixer" },
        { id: "n_pc", deviceId: "d_pc" },
        {
          id: "n_obs",
          deviceId: "d_obs",
          hostNodeId: "n_pc",
          ports: OBS_SOURCES,
          assignments: [{ port: "audio_src:1", hostPort: "usb_in" }],
        },
        {
          id: "n_meet",
          deviceId: "d_meet",
          hostNodeId: "n_pc",
          assignments: [{ port: "mic_in", hostPort: "usb_in" }],
        },
      ],
      links: [{ id: "l1", from: ["n_mixer", "usb_send"], to: ["n_pc", "usb_in"] }],
      routing: [],
    } satisfies Partial<SetupDoc>;

    it("draws every app inside the machine it runs on", () => {
      const layout = layoutOf(machine);
      const pc = nodeOf(layout, "n_pc");
      for (const key of ["n_obs", "n_meet"]) {
        const app = nodeOf(layout, key);
        expect(app?.depth).toBe(1);
        expect(pc && app && encloses(pc, app)).toBe(true);
      }
    });

    it("keeps two apps on one machine from overlapping each other", () => {
      const layout = layoutOf(machine);
      const obs = nodeOf(layout, "n_obs");
      const meet = nodeOf(layout, "n_meet");
      expect(obs && meet && overlaps(obs, meet)).toBe(false);
    });

    // The gutter between an app's border and its machine's is the only strip of
    // the machine nothing else is drawn in.
    it("runs a device selection inside the machine, not around it", () => {
      const layout = layoutOf(machine);
      const pc = nodeOf(layout, "n_pc");
      const selection = selectionOf(layout, "audio_src:1");
      expect(selection?.back).toBe(false);
      for (const point of selection?.points ?? []) {
        expect(point.x).toBeGreaterThanOrEqual(pc?.x ?? 0);
        expect(point.x).toBeLessThanOrEqual((pc?.x ?? 0) + (pc?.width ?? 0));
      }
    });

    const hall = {
      spaces: [HALL],
      nodes: [
        { id: "n_mic", deviceId: "d_mic1", spaceId: "sp_hall" },
        { id: "n_mixer", deviceId: "d_mixer", spaceId: "sp_hall" },
        { id: "n_speaker", deviceId: "d_speaker", spaceId: "sp_hall" },
        { id: "n_rec", deviceId: "d_recorder" },
      ],
      links: [
        { id: "l1", from: ["n_mic", "out"], to: ["n_mixer", "ch1"] },
        { id: "l2", from: ["n_mixer", "main_out"], to: ["n_speaker", "in"] },
        { id: "l3", from: ["n_mixer", "main_out"], to: ["n_rec", "in_l"] },
      ],
      routing: [{ nodeId: "n_mixer", inPort: "ch1", bus: "main" }],
    } satisfies Partial<SetupDoc>;

    // A mixer couples to no space, so the graph ignores its `spaceId` — but it
    // is still standing in the hall, and that is what the frame is for.
    it("frames a room round everything placed in it, coupled or not", () => {
      const layout = layoutOf(hall);
      const frame = layout.frames.find((entry) => entry.label === "メインホール");
      expect(frame).toBeDefined();
      for (const key of ["n_mic", "n_mixer", "n_speaker", "space:sp_hall"]) {
        const node = nodeOf(layout, key);
        expect(node && frame && encloses(frame, node)).toBe(true);
      }
    });

    it("leaves a device with no place out of the frame", () => {
      const layout = layoutOf(hall);
      const frame = layout.frames.find((entry) => entry.label === "メインホール");
      const recorder = nodeOf(layout, "n_rec");
      expect(recorder?.frameKey).toBeNull();
      expect(frame && recorder && overlaps(frame, recorder)).toBe(false);
    });

    // The reason places are laid out as lanes: a plain bounding box would
    // swallow whatever another room happened to be laid out between.
    it("keeps every other room's boxes out of a room's frame", () => {
      const layout = layoutOf(satelliteRooms());
      expect(layout.frames.length).toBe(2);
      for (const frame of layout.frames) {
        for (const node of layout.nodes) {
          if (node.parentKey !== null || node.frameKey === frame.key) continue;
          expect(overlaps(frame, node)).toBe(false);
        }
      }
    });

    it("draws no frame round a place holding nothing but its own air", () => {
      const layout = layoutOf({
        spaces: [HALL],
        nodes: [{ id: "n_mixer", deviceId: "d_mixer" }],
      });
      expect(layout.frames).toEqual([]);
    });

    // `venueKey` was reserved for "these two spaces are the same room".
    it("draws one frame for an acoustic and a visual space sharing a venue", () => {
      const layout = layoutOf({
        spaces: [
          { id: "sp_hall", kind: "acoustic", label: "メインホール", venueKey: "hall" },
          { id: "sp_hall_v", kind: "visual", label: "メインホール (視界)", venueKey: "hall" },
        ],
        nodes: [
          { id: "n_mic", deviceId: "d_mic1", spaceId: "sp_hall" },
          { id: "n_camera", deviceId: "d_camera", spaceId: "sp_hall_v" },
        ],
      });

      expect(layout.frames).toHaveLength(1);
      const frame = layout.frames[0];
      expect(frame?.spaceKinds).toEqual(["acoustic", "visual"]);
      for (const key of ["n_mic", "n_camera"]) {
        const node = nodeOf(layout, key);
        expect(node && frame && encloses(frame, node)).toBe(true);
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

  it("lays out twoJoinsInOneHall within the invariant: column count <= number of boxes", () => {
    const layout = layoutOf(twoJoinsInOneHall());
    expect(layout.columns).toBeLessThanOrEqual(layout.nodes.length);
  });

  it("places any two nodes sharing the same modelId in the same column in satelliteRooms", () => {
    const setup = satelliteRooms();
    const layout = layoutOf(setup);
    const ctx = testContext();
    const docGraph = buildGraph(setup, { devices: ctx.devices, models: ctx.models });

    const columnsByModel = new Map<string, Set<number>>();
    for (const node of layout.nodes) {
      if (node.spaceKind) continue;

      const resolved = docGraph.nodes.get(node.key);
      if (!resolved) continue;

      const modelId = resolved.model.id;
      if (!columnsByModel.has(modelId)) columnsByModel.set(modelId, new Set());
      columnsByModel.get(modelId)?.add(node.column);
    }

    for (const columns of columnsByModel.values()) {
      expect(columns.size).toBe(1);
    }
  });

  it("leaves no forward edge out of a space box", () => {
    const layout = layoutOf(twoJoinsInOneHall());
    for (const edge of layout.edges) {
      const fromBox = layout.nodes.find((n) => n.key === edge.from);
      if (fromBox?.spaceKind) {
        expect(edge.back).toBe(true);
      }
    }
  });
});

/**
 * Every pair of lines drawn along one another, as `a x b, 40px`.
 *
 * Two lines meeting at a jack share the last stub into it, and must: they
 * really do end at the same place. Anywhere else, a shared run is two cables
 * pretending to be one.
 */
function sharedRuns(layout: ReturnType<typeof layoutOf>): string[] {
  const found: string[] = [];
  const runs = layout.edges.flatMap((edge) =>
    edge.points.slice(1).flatMap((to, index) => {
      const from = edge.points[index];
      return from && (from.x !== to.x || from.y !== to.y) ? [{ edge, from, to }] : [];
    }),
  );

  for (let i = 0; i < runs.length; i++) {
    for (let j = i + 1; j < runs.length; j++) {
      const left = runs[i];
      const right = runs[j];
      if (!left || !right || left.edge.id === right.edge.id) continue;
      if (sharesJack(left.edge, right.edge)) continue;
      const along = sharedLength(left, right);
      if (along > 2) found.push(`${left.edge.id} x ${right.edge.id}, ${Math.round(along)}px`);
    }
  }
  return [...new Set(found)];
}

/** What two lines sharing a strip are moved apart by: the layout's `LINE_PITCH`. */
const PITCH = 8;

/**
 * Pairs of lines running alongside each other inside one machine, nearer than
 * two lines are allowed to be anywhere else.
 *
 * Inside a machine because that is where the strips are narrow — a gutter down
 * each side and the gap between two apps is the whole of it — and the answer to
 * a narrow strip is a wider machine, not closer lines. Two runs on the same
 * jack are left out for the same reason `sharedRuns` leaves them out.
 */
function crowdedRuns(layout: ReturnType<typeof layoutOf>): string[] {
  const machines = layout.nodes.filter((node) =>
    layout.nodes.some((other) => other.parentKey === node.key),
  );
  const runs = layout.edges.flatMap((edge) =>
    edge.points.slice(1).flatMap((to, index) => {
      const from = edge.points[index];
      return from && (from.x !== to.x || from.y !== to.y) ? [{ edge, from, to }] : [];
    }),
  );

  const found: string[] = [];
  for (const machine of machines) {
    const inside = runs.filter((run) => within(run, machine));
    for (let i = 0; i < inside.length; i++) {
      for (let j = i + 1; j < inside.length; j++) {
        const left = inside[i];
        const right = inside[j];
        if (!left || !right || left.edge.id === right.edge.id) continue;
        if (sharesJack(left.edge, right.edge)) continue;
        const apart = separation(left, right);
        if (apart === null || apart >= PITCH - 0.01) continue;
        found.push(`${left.edge.id} x ${right.edge.id} in ${machine.key}, ${apart.toFixed(1)}px`);
      }
    }
  }
  return [...new Set(found)];
}

function firstColumnX(layout: ReturnType<typeof layoutOf>): number {
  return Math.min(...layout.nodes.filter((node) => node.parentKey === null).map((node) => node.x));
}

/** Where the lines standing off the first column run, page edge first. */
function marginRuns(layout: ReturnType<typeof layoutOf>): number[] {
  const first = firstColumnX(layout);
  const xs = new Set<number>();
  for (const edge of layout.edges) {
    for (let i = 1; i < edge.points.length; i++) {
      const from = edge.points[i - 1];
      const to = edge.points[i];
      if (!from || !to || from.x !== to.x || from.y === to.y) continue;
      if (from.x < first) xs.add(from.x);
    }
  }
  return [...xs].sort((a, b) => a - b);
}

function within(run: Run, box: LayoutNode): boolean {
  const points = [run.from, run.to];
  return points.every(
    (point) =>
      point.x >= box.x &&
      point.x <= box.x + box.width &&
      point.y >= box.y &&
      point.y <= box.y + box.height,
  );
}

/** How far apart two parallel runs are where they overlap, or `null` if they do not. */
function separation(left: Run, right: Run): number | null {
  const along = (a: number, b: number, c: number, d: number): number =>
    Math.min(Math.max(a, b), Math.max(c, d)) - Math.max(Math.min(a, b), Math.min(c, d));

  const flat = (run: Run) => Math.abs(run.from.y - run.to.y) < 0.5;
  const upright = (run: Run) => Math.abs(run.from.x - run.to.x) < 0.5;
  if (flat(left) && flat(right) && along(left.from.x, left.to.x, right.from.x, right.to.x) > 1) {
    return Math.abs(left.from.y - right.from.y);
  }
  if (
    upright(left) &&
    upright(right) &&
    along(left.from.y, left.to.y, right.from.y, right.to.y) > 1
  ) {
    return Math.abs(left.from.x - right.from.x);
  }
  return null;
}

type Run = { from: { x: number; y: number }; to: { x: number; y: number } };

function sharedLength(left: Run, right: Run): number {
  const along = (a: number, b: number, c: number, d: number): number =>
    Math.max(
      0,
      Math.min(Math.max(a, b), Math.max(c, d)) - Math.max(Math.min(a, b), Math.min(c, d)),
    );

  const flat = (run: Run) => Math.abs(run.from.y - run.to.y) < 0.5;
  const upright = (run: Run) => Math.abs(run.from.x - run.to.x) < 0.5;
  if (flat(left) && flat(right) && Math.abs(left.from.y - right.from.y) < 1.5) {
    return along(left.from.x, left.to.x, right.from.x, right.to.x);
  }
  if (upright(left) && upright(right) && Math.abs(left.from.x - right.from.x) < 1.5) {
    return along(left.from.y, left.to.y, right.from.y, right.to.y);
  }
  return 0;
}

function sharesJack(left: LayoutEdge, right: LayoutEdge): boolean {
  const ends = (edge: LayoutEdge) => [jackOf(edge, "from"), jackOf(edge, "to")];
  return ends(left).some((end) => ends(right).includes(end));
}

/**
 * The jack this end of a line is on, or nothing two lines can share.
 *
 * A room has no jack, so two cables meeting one are never meeting at a jack —
 * they are exactly the case that used to draw as a single arrowhead.
 */
function jackOf(edge: LayoutEdge, end: "from" | "to"): string {
  const port = end === "from" ? edge.fromPort : edge.toPort;
  return port === null ? `${edge.id}:${end}` : `${edge[end]}:${port}`;
}

/** Where the arrowheads land, keyed by the point, for everything that lands twice. */
function endpoints(layout: ReturnType<typeof layoutOf>): [string, LayoutEdge[]][] {
  const heads = new Map<string, LayoutEdge[]>();
  for (const edge of layout.edges) {
    const head = edge.points.at(-1);
    if (!head) continue;
    const key = `${Math.round(head.x)},${Math.round(head.y)}`;
    const list = heads.get(key);
    if (list) list.push(edge);
    else heads.set(key, [edge]);
  }
  return [...heads].filter(([, edges]) => edges.length > 1);
}

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
