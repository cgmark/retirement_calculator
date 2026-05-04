import { describe, expect, it } from "vitest";
import {
  getBaseSpendingForAge,
  sanitizeScheduleRows,
  normalizeScheduleRows,
  getScheduleValidationError,
  buildFlatSchedule,
  isFlatSchedule,
} from "../src/core/spending.js";

describe("getBaseSpendingForAge", () => {
  it("returns default spending when schedule is missing", () => {
    expect(getBaseSpendingForAge(70, 60000)).toBe(60000);
    expect(getBaseSpendingForAge(70, 60000, [])).toBe(60000);
  });

  it("returns matching schedule amount for in-range age", () => {
    const schedule = [
      { startAge: 60, endAge: 69, amount: 70000 },
      { startAge: 70, endAge: 80, amount: 50000 },
    ];
    expect(getBaseSpendingForAge(75, 60000, schedule)).toBe(50000);
  });

  it("returns default spending when no row matches", () => {
    const schedule = [{ startAge: 60, endAge: 64, amount: 70000 }];
    expect(getBaseSpendingForAge(70, 60000, schedule)).toBe(60000);
  });

  it("includes start and end age boundaries", () => {
    const schedule = [{ startAge: 65, endAge: 70, amount: 55000 }];
    expect(getBaseSpendingForAge(65, 60000, schedule)).toBe(55000);
    expect(getBaseSpendingForAge(70, 60000, schedule)).toBe(55000);
  });
});

describe("schedule helpers", () => {
  it("sanitizes missing row values with defaults", () => {
    const rows = sanitizeScheduleRows([
      { startAge: 62, endAge: undefined, amount: NaN },
    ]);
    expect(rows).toEqual([{ startAge: 62, endAge: 100, amount: 60000 }]);
  });

  it("normalizes and clamps rows", () => {
    const raw = [{ startAge: 50, endAge: 110, amount: 70000 }];
    const { cleaned, wasClamped } = normalizeScheduleRows(raw, 60, 100);
    expect(wasClamped).toBe(true);
    expect(cleaned).toEqual([{ startAge: 60, endAge: 100, amount: 70000 }]);
  });

  it("reports overlap and invalid range", () => {
    expect(
      getScheduleValidationError([{ startAge: 70, endAge: 65, amount: 50000 }]),
    ).toBe("invalid-range");

    expect(
      getScheduleValidationError([
        { startAge: 60, endAge: 70, amount: 50000 },
        { startAge: 70, endAge: 80, amount: 50000 },
      ]),
    ).toBe("overlap");
  });

  it("builds and recognizes flat schedule", () => {
    const flat = buildFlatSchedule(60, 95, 60123.2);
    expect(flat).toEqual([{ startAge: 60, endAge: 95, amount: 60123 }]);
    expect(isFlatSchedule(flat, 60, 95, 60123.2)).toBe(true);
    expect(
      isFlatSchedule(
        [{ startAge: 61, endAge: 95, amount: 60123 }],
        60,
        95,
        60123,
      ),
    ).toBe(false);
  });
});
