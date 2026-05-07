import { describe, expect, it } from "vitest";
import { runDeterministicProjection } from "../src/core/projection.js";
import { calculateTax } from "../src/core/tax.js";

describe("runDeterministicProjection", () => {
  it("contributes surplus in TFSA, RRSP, then non-reg order during working years", async () => {
    const { results } = await runDeterministicProjection({
      age: 60,
      retirementAge: 65,
      rrspStart: 0,
      tfsaStart: 0,
      nonregStart: 0,
      acbStart: 0,
      baseSpending: 10000,
      activeSchedule: [],
      lifeExpectancy: 60,
      grossEmploymentIncome: 100000,
      inflation: 0.02,
      growth: 0.05,
      provCode: "ON",
      cppScenarioAge: 65,
      selectedCPPMonthly: 0,
      oasPercent: 0,
      rrifStartAge: 72,
      enforceRrifMin: true,
      effectiveStrategy: "tfsa-rrsp-nonreg",
    });

    expect(results).toHaveLength(1);
    expect(results[0].drawRRSP).toBe(0);
    expect(results[0].drawTFSA).toBe(0);
    expect(results[0].drawNonReg).toBe(0);
    expect(results[0].contribTFSA).toBeCloseTo(7000, 6);
    expect(results[0].contribRRSP).toBeCloseTo(18000, 6);
    expect(results[0].contribNonReg).toBeCloseTo(48850.8705, 6);
    expect(results[0].employmentIncomeGross).toBeCloseTo(100000, 6);
    expect(results[0].taxableIncome).toBeCloseTo(82000, 6);
    expect(results[0].incomeTax).toBeLessThan(calculateTax(100000, "ON", 1));
    expect(results[0].total).toBeCloseTo(73850.8705, 6);
  });

  it("clamps deterministic growth so balances never go negative from returns below -100%", async () => {
    const { results } = await runDeterministicProjection({
      age: 65,
      retirementAge: 65,
      rrspStart: 100,
      tfsaStart: 0,
      nonregStart: 0,
      acbStart: 0,
      baseSpending: 0,
      activeSchedule: [],
      lifeExpectancy: 66,
      grossEmploymentIncome: 0,
      inflation: 0,
      growth: -1.5,
      provCode: "ON",
      cppScenarioAge: 65,
      selectedCPPMonthly: 0,
      oasPercent: 0,
      rrifStartAge: 72,
      enforceRrifMin: false,
      effectiveStrategy: "tfsa-rrsp-nonreg",
    });

    expect(results).toHaveLength(2);
    expect(results[1].rrsp).toBeCloseTo(5, 6);
    expect(results[1].total).toBeCloseTo(5, 6);
    expect(results[1].rrsp).toBeGreaterThanOrEqual(0);
  });

  it("clamps deterministic inflation so spending never flips negative", async () => {
    const { results } = await runDeterministicProjection({
      age: 60,
      retirementAge: 65,
      rrspStart: 1000000,
      tfsaStart: 0,
      nonregStart: 0,
      acbStart: 0,
      baseSpending: 60000,
      activeSchedule: [],
      lifeExpectancy: 63,
      grossEmploymentIncome: 0,
      inflation: -1.5,
      growth: 0,
      provCode: "ON",
      cppScenarioAge: 65,
      selectedCPPMonthly: 0,
      oasPercent: 0,
      rrifStartAge: 72,
      enforceRrifMin: false,
      effectiveStrategy: "tfsa-rrsp-nonreg",
    });

    expect(results).toHaveLength(4);
    expect(results.map((r) => r.spending)).toEqual([
      60000, 58200, 56454, 54760.38,
    ]);
    expect(results.every((r) => r.spending >= 0)).toBe(true);
  });
});
