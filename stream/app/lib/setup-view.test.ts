import { describe, expect, it } from "vitest";
import type { SetupDoc } from "~/lib/av/schema";
import { collectPlaces } from "~/lib/setup-view";

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
