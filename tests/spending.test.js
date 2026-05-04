import { describe, expect, it } from "vitest";
import { getBaseSpendingForAge } from "../src/core/spending.js";

describe("getBaseSpendingForAge", () => {
  it("returns default spending when schedule is missing", () => {
    expect(getBaseSpendingForAge(70, 60000)).toBe(60000);
    expect(getBaseSpendingForAge(70, 60000, [])).toBe(60000);
  });

  it("returns matching schedule amount for in-range age", () => {
    const schedule = [
      { startAge: 60, endAge: 69, amount: 70000 },
      { startAge: 70, endAge: 80, amount: 50000 }
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
