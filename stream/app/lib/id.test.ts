import { describe, expect, it } from "vitest";
import { ID_PREFIXES, newDocId, newId } from "./id";

describe("newId", () => {
  it("prefixes by kind", () => {
    expect(newId("device").startsWith(`${ID_PREFIXES.device}_`)).toBe(true);
    expect(newId("event").startsWith(`${ID_PREFIXES.event}_`)).toBe(true);
  });

  it("sorts by creation time", async () => {
    const first = newId("event");
    await new Promise((resolve) => setTimeout(resolve, 2));
    const second = newId("event");
    expect(first < second).toBe(true);
  });

  it("is unique across a burst", () => {
    const ids = new Set(Array.from({ length: 500 }, () => newId("setup")));
    expect(ids.size).toBe(500);
  });
});

describe("newDocId", () => {
  it("starts at 1 for an empty document", () => {
    expect(newDocId("n", [])).toBe("n1");
  });

  it("skips ids already taken", () => {
    expect(newDocId("n", ["n1", "n2", "n4"])).toBe("n3");
  });

  it("keeps each prefix on its own sequence", () => {
    const taken = ["n1", "n2"];
    expect(newDocId("l", taken)).toBe("l1");
    expect(newDocId("sp", taken)).toBe("sp1");
  });
});
