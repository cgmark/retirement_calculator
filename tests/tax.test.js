import { describe, expect, it } from "vitest";
import { calculateTax, findGrossDraw } from "../src/core/tax.js";

describe("calculateTax", () => {
  it("returns zero for non-positive income", () => {
    expect(calculateTax(0, "ON", 1)).toBe(0);
    expect(calculateTax(-100, "ON", 1)).toBe(0);
  });

  it("is monotonic with income", () => {
    const low = calculateTax(50000, "ON", 1);
    const high = calculateTax(100000, "ON", 1);
    expect(high).toBeGreaterThan(low);
  });
});

describe("findGrossDraw", () => {
  it("does not exceed available gross", () => {
    const res = findGrossDraw(50000, 20000, 0, 1, "ON", 1);
    expect(res.gross).toBeLessThanOrEqual(20000);
  });

  it("returns nearly requested net when feasible", () => {
    const res = findGrossDraw(10000, 100000, 0, 1, "ON", 1);
    expect(res.net).toBeGreaterThan(9900);
  });
});
