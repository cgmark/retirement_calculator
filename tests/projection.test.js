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
});
