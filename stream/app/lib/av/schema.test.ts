import { describe, expect, it } from "vitest";
import { EMPTY_SETUP_DOC, parseSetupDoc, safeParseSetupDoc } from "./schema";

describe("setup document schema", () => {
  it("fills in empty collections", () => {
    expect(parseSetupDoc({ schemaVersion: 1 })).toEqual(EMPTY_SETUP_DOC);
  });

  it("keeps venueKey, which is how cross-track spaces stay identifiable", () => {
    const parsed = parseSetupDoc({
      schemaVersion: 1,
      spaces: [{ id: "sp_hall", kind: "acoustic", label: "ホール", venueKey: "hall-a" }],
    });

    expect(parsed.spaces[0]?.venueKey).toBe("hall-a");
  });

  it("rejects duplicate node ids, which would collapse graph vertices", () => {
    const result = safeParseSetupDoc({
      schemaVersion: 1,
      nodes: [
        { id: "n1", deviceId: "d1" },
        { id: "n1", deviceId: "d2" },
      ],
    });

    expect(result.success).toBe(false);
  });

  it("rejects an unsupported schema version", () => {
    expect(safeParseSetupDoc({ schemaVersion: 2 }).success).toBe(false);
  });

  it("requires a port key on both ends of a link", () => {
    const result = safeParseSetupDoc({
      schemaVersion: 1,
      links: [{ id: "l1", from: ["n1"], to: ["n2", "in"] }],
    });

    expect(result.success).toBe(false);
  });
});
