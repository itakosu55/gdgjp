import { describe, expect, it } from "vitest";
import { emptyToNull, formatEventDate, parseLocalDateTime, toLocalDateTimeValue } from "./form";

describe("emptyToNull", () => {
  it("treats whitespace as absent", () => {
    expect(emptyToNull("   ")).toBeNull();
    expect(emptyToNull(null)).toBeNull();
    expect(emptyToNull(" MG10XU ")).toBe("MG10XU");
  });
});

describe("datetime-local round trip", () => {
  it("reads the field as JST, not as the Worker's zone", () => {
    // 2026-08-05 19:00 JST is 10:00 UTC.
    expect(parseLocalDateTime("2026-08-05T19:00")).toBe(Date.UTC(2026, 7, 5, 10, 0) / 1000);
  });

  it("round trips back to the same field value", () => {
    const value = "2026-08-05T19:00";
    expect(toLocalDateTimeValue(parseLocalDateTime(value))).toBe(value);
  });

  it("returns null for an empty or unparseable field", () => {
    expect(parseLocalDateTime("")).toBeNull();
    expect(parseLocalDateTime("not-a-date")).toBeNull();
    expect(toLocalDateTimeValue(null)).toBe("");
  });
});

describe("formatEventDate", () => {
  it("renders in JST", () => {
    const seconds = Date.UTC(2026, 7, 5, 10, 0) / 1000;
    expect(formatEventDate(seconds)).toContain("19:00");
  });

  it("says the date is undecided when there is none", () => {
    expect(formatEventDate(null)).toBe("日時未定");
  });
});
