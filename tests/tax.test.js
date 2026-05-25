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

  it("applies the federal age credit at 65+", () => {
    const age64Tax = calculateTax(50000, "ON", 1, { age: 64 });
    const age65Tax = calculateTax(50000, "ON", 1, { age: 65 });
    expect(age65Tax).toBeLessThan(age64Tax);
  });

  it("includes the Ontario provincial age credit at 65+", () => {
    const ageReduction =
      calculateTax(50000, "ON", 1, { age: 64 }) -
      calculateTax(50000, "ON", 1, { age: 65 });

    expect(ageReduction).toBeCloseTo(1459.1796, 4);
  });

  it("phases out the federal age credit at higher income", () => {
    const moderateIncomeCredit =
      calculateTax(50000, "ON", 1, { age: 64 }) -
      calculateTax(50000, "ON", 1, { age: 65 });
    const highIncomeCredit =
      calculateTax(120000, "ON", 1, { age: 64 }) -
      calculateTax(120000, "ON", 1, { age: 65 });

    expect(highIncomeCredit).toBeLessThan(moderateIncomeCredit);
  });

  it("applies the federal pension income credit at 65+", () => {
    const withoutPensionCredit = calculateTax(40000, "ON", 1, { age: 65 });
    const withPensionCredit = calculateTax(40000, "ON", 1, {
      age: 65,
      eligiblePensionIncome: 2000,
    });
    expect(withPensionCredit).toBeLessThan(withoutPensionCredit);
  });

  it("caps the federal pension income credit base", () => {
    const atCap = calculateTax(40000, "ON", 1, {
      age: 65,
      eligiblePensionIncome: 2000,
    });
    const aboveCap = calculateTax(40000, "ON", 1, {
      age: 65,
      eligiblePensionIncome: 5000,
    });
    expect(aboveCap).toBe(atCap);
  });

  it("includes the Ontario provincial pension income credit", () => {
    const pensionReduction =
      calculateTax(40000, "ON", 1, { age: 65 }) -
      calculateTax(40000, "ON", 1, {
        age: 65,
        eligiblePensionIncome: 5000,
      });

    expect(pensionReduction).toBeCloseTo(386.557, 3);
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

  it("uses pension credit context for eligible rrsp-style draws", () => {
    const withoutCredit = findGrossDraw(30000, 100000, 0, 1, "ON", 1, {
      age: 65,
    });
    const withCredit = findGrossDraw(
      30000,
      100000,
      0,
      1,
      "ON",
      1,
      { age: 65 },
      1,
    );

    expect(withCredit.gross).toBeLessThan(withoutCredit.gross);
    expect(withCredit.net).toBeGreaterThan(29900);
  });
});
