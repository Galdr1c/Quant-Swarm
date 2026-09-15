import { describe, expect, it } from "vitest";
import { formatTimestamp, roundTo } from "../src/index.js";

describe("shared utilities", () => {
  it("formats timestamps in UTC", () => {
    expect(formatTimestamp(Date.UTC(2026, 0, 2, 3, 4, 5))).toBe("2026-01-02 03:04:05");
  });

  it("rounds values deterministically", () => {
    expect(roundTo(1.23456, 3)).toBe(1.235);
    expect(roundTo(-2.3456, 2)).toBe(-2.35);
  });
});
