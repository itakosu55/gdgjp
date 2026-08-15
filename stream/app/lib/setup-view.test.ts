import { describe, expect, it } from "vitest";
import { MODELS, testContext } from "~/lib/av/fixtures";
import { lint } from "~/lib/av/lint";
import type { SetupDoc } from "~/lib/av/schema";
import { collectPlaces, locationOptions, locationValue, worstSeverities } from "~/lib/setup-view";

function doc(partial: Partial<SetupDoc> = {}): SetupDoc {
  return { schemaVersion: 1, spaces: [], nodes: [], links: [], routing: [], ...partial };
}

const AIR = { id: "sp_air", kind: "acoustic", label: "ホール", venueKey: "hall" } as const;
const SIGHT = { id: "sp_sight", kind: "visual", label: "ホール (視界)", venueKey: "hall" } as const;

describe("collectPlaces", () => {
  it("groups the two spaces of one venue into a single room", () => {
    const places = collectPlaces(doc({ spaces: [AIR, SIGHT] }));
    expect(places).toHaveLength(1);
    expect(places[0]?.kinds).toEqual(["acoustic", "visual"]);
  });

  // Whichever half somebody typed first is not something the reader knows, so
  // it must not decide what the room is called or which space the header edits.
  it("names a room after its acoustic half whichever half came first", () => {
    for (const spaces of [
      [AIR, SIGHT],
      [SIGHT, AIR],
    ]) {
      const places = collectPlaces(doc({ spaces }));
      expect(places[0]?.label).toBe("ホール");
      expect(places[0]?.spaceIds).toEqual(["sp_air", "sp_sight"]);
    }
  });

  it("keeps the rooms themselves in document order", () => {
    const satellite = { id: "sp_sat", kind: "acoustic", label: "サテライト" } as const;
    const places = collectPlaces(doc({ spaces: [SIGHT, satellite, AIR] }));
    expect(places.map((place) => place.label)).toEqual(["ホール", "サテライト"]);
  });

  // A meeting is not a place: it is a path between places.
  it("leaves a meeting out", () => {
    const meeting = { id: "sp_meet", kind: "transport", label: "Meet" } as const;
    expect(collectPlaces(doc({ spaces: [meeting] }))).toEqual([]);
  });
});

const MEETING = { id: "sp_meet", kind: "transport", label: "Meet" } as const;
const byId = new Map(MODELS.map((model) => [model.id, model]));
const MIC = byId.get("m_mic_dynamic");
const JOIN = byId.get("m_meet");

/**
 * 所在 is one question with one answer per node: which room, or for a join,
 * which meeting. What the graph then couples to is the jack's business, so the
 * list must not put a room's two spaces up as rivals.
 */
describe("the 所在 list", () => {
  it("offers a hall of both media once, as the room", () => {
    expect(locationOptions(doc({ spaces: [AIR, SIGHT] }), MIC)).toEqual([
      { value: "sp_air", label: "ホール" },
    ]);
  });

  it("keeps meetings out of the list for gear", () => {
    const options = locationOptions(doc({ spaces: [AIR, MEETING] }), MIC);
    expect(options.map((option) => option.label)).toEqual(["ホール"]);
  });

  // A join is in a meeting, and a meeting is not a room — so this branch offers
  // the spaces themselves, and is the reason the list is not simply the places.
  it("offers a join its meetings and no room at all", () => {
    expect(locationOptions(doc({ spaces: [AIR, SIGHT, MEETING] }), JOIN)).toEqual([
      { value: "sp_meet", label: "Meet" },
    ]);
  });

  // Kit whose model is unknown still stands somewhere.
  it("offers rooms when there is no model to go on", () => {
    expect(locationOptions(doc({ spaces: [AIR] }), undefined)).toHaveLength(1);
  });

  /**
   * The other half of the same claim: a document that already points at a
   * hall's sight half must select the hall, not fall through to the first
   * option — a select with no matching option shows one that was never chosen,
   * and the next save through that form would write it down.
   */
  describe("what the list starts on", () => {
    const both = doc({ spaces: [AIR, SIGHT] });

    it("reads either half of a hall as the hall", () => {
      for (const spaceId of ["sp_air", "sp_sight"]) {
        expect(locationValue(both, { id: "n1", spaceId })).toBe("sp_air");
      }
    });

    it("leaves a join on its own meeting", () => {
      const withMeeting = doc({ spaces: [AIR, MEETING] });
      expect(locationValue(withMeeting, { id: "n1", spaceId: "sp_meet" })).toBe("sp_meet");
    });

    it("says nothing for a node that is nowhere, or points at a space that is gone", () => {
      expect(locationValue(both, { id: "n1" })).toBe("");
      expect(locationValue(both, { id: "n1", spaceId: "sp_deleted" })).toBe("");
    });
  });
});

/**
 * What the diagram is allowed to paint, and how loudly.
 *
 * `byEdge` and `byLink` are the picture's whole input, so these tests are the
 * unit-level statement of one rule: the linter decides the colour. The diagram
 * used to flatten every reported cycle into one danger colour, which meant a
 * room that declared it reinforces got a 警告 in the dock and a red loop in the
 * drawing — the picture still asserting the howling the linter had stopped
 * asserting (§13).
 */
describe("worstSeverities", () => {
  const HALL = { id: "sp_hall", kind: "acoustic", label: "メインホール" } as const;
  const nodes = [
    { id: "n_mic", deviceId: "d_mic1", spaceId: "sp_hall" },
    { id: "n_mixer", deviceId: "d_mixer" },
    { id: "n_speaker", deviceId: "d_speaker", spaceId: "sp_hall" },
  ];
  const links = [
    { id: "l1", from: ["n_mic", "out"], to: ["n_mixer", "ch1"] },
    { id: "l2", from: ["n_mixer", "main_out"], to: ["n_speaker", "in"] },
  ] satisfies SetupDoc["links"];

  function howling(reinforced: boolean) {
    return worstSeverities(
      lint(
        doc({
          spaces: [{ ...HALL, reinforced }],
          nodes,
          links,
          routing: [{ nodeId: "n_mixer", inPort: "ch1", bus: "main" }],
        }),
        testContext(),
      ),
    );
  }

  // Same wiring both ways round, so this pins that the declaration — and only
  // the declaration — is what moves the colour.
  it("hands the diagram the severity the dock shows, not a flat alert", () => {
    const declared = [...howling(true).byEdge.values()];
    const undeclared = [...howling(false).byEdge.values()];

    expect(declared.length).toBeGreaterThan(0);
    expect(declared).toContain("warn");
    expect(declared).not.toContain("critical");
    expect(undeclared).toContain("critical");
  });

  /**
   * A cable is named by `linkIds`, never by a cycle, so before `byLink` existed
   * every per-cable rule drew nothing at all — a mic run straight into a
   * powered speaker was an ordinary grey line while a declared, deliberate
   * reinforcement loop was bright red.
   */
  it("carries a finding that names a cable rather than a path", () => {
    const found = worstSeverities(
      lint(
        doc({
          // Neither end stands in a room, so nothing here closes a loop and the
          // only findings left on the cable are the ones about the cable.
          nodes: [
            { id: "n_mic", deviceId: "d_mic1" },
            { id: "n_speaker", deviceId: "d_speaker" },
          ],
          links: [{ id: "l_direct", from: ["n_mic", "out"], to: ["n_speaker", "in"] }],
        }),
        testContext(),
      ),
    );

    // Two findings on one cable — mic level into a line input, and XLR into TRS.
    // The louder one is what the line is drawn as.
    expect(found.byEdge.size).toBe(0);
    expect(found.byLink.get("l_direct")).toBe("error");
  });

  it("leaves a cable nobody reported out of both maps", () => {
    const found = worstSeverities(
      lint(doc({ spaces: [HALL], nodes, links, routing: [] }), testContext()),
    );

    expect(found.byLink.has("l1")).toBe(false);
    expect(found.byEdge.size).toBe(0);
  });
});
