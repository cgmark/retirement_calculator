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

  it("matches exact-dollar rrsp-fill-low-bracket baseline behavior", async () => {
    const { results } = await runDeterministicProjection({
      age: 60,
      retirementAge: 65,
      rrspStart: 200000,
      tfsaStart: 20000,
      nonregStart: 120000,
      acbStart: 120000,
      baseSpending: 20000,
      activeSchedule: [],
      lifeExpectancy: 60,
      grossEmploymentIncome: 0,
      inflation: 0,
      growth: 0,
      provCode: "ON",
      cppScenarioAge: 65,
      selectedCPPMonthly: 0,
      oasPercent: 0,
      rrifStartAge: 72,
      enforceRrifMin: false,
      effectiveStrategy: "rrsp-fill-low-bracket",
    });

    expect(results).toHaveLength(1);
    expect(results[0].drawRRSP).toBeCloseTo(21285.916916766335, 6);
    expect(results[0].drawTFSA).toBeCloseTo(0, 6);
    expect(results[0].drawNonReg).toBeCloseTo(0, 6);
    expect(results[0].incomeTax).toBeCloseTo(1285.9169122614792, 6);
    expect(results[0].taxableIncome).toBeCloseTo(21285.916916766335, 6);
    expect(results[0].rrsp).toBeCloseTo(178714.08308323368, 6);
    expect(results[0].tfsa).toBeCloseTo(20000, 6);
    expect(results[0].nonreg).toBeCloseTo(120000, 6);
    expect(results[0].total).toBeCloseTo(318714.0830832337, 6);
  });

  it("matches exact-dollar tfsa-transfer behavior for rrsp-fill-low-bracket", async () => {
    const { results } = await runDeterministicProjection({
      age: 60,
      retirementAge: 65,
      rrspStart: 200000,
      tfsaStart: 20000,
      nonregStart: 120000,
      acbStart: 120000,
      baseSpending: 20000,
      activeSchedule: [],
      lifeExpectancy: 60,
      grossEmploymentIncome: 0,
      inflation: 0,
      growth: 0,
      provCode: "ON",
      cppScenarioAge: 65,
      selectedCPPMonthly: 0,
      oasPercent: 0,
      rrifStartAge: 72,
      enforceRrifMin: false,
      effectiveStrategy: "rrsp-fill-low-bracket-tfsa-transfer",
    });

    expect(results).toHaveLength(1);
    expect(results[0].drawRRSP).toBeCloseTo(21285.916916766335, 6);
    expect(results[0].drawNonReg).toBeCloseTo(6999.9999954951445, 6);
    expect(results[0].drawTFSA).toBeCloseTo(0, 6);
    expect(results[0].incomeTax).toBeCloseTo(1285.9169122614792, 6);
    expect(results[0].rrsp).toBeCloseTo(178714.08308323368, 6);
    expect(results[0].tfsa).toBeCloseTo(27000, 6);
    expect(results[0].nonreg).toBeCloseTo(113000.00000450485, 6);
    expect(results[0].acb).toBeCloseTo(113000.00000450485, 6);
    expect(results[0].total).toBeCloseTo(318714.08308773855, 6);
  });

  it("matches exact-dollar opportunistic tfsa-transfer behavior under rrsp and rrif pressure", async () => {
    const { results } = await runDeterministicProjection({
      age: 75,
      retirementAge: 65,
      rrspStart: 500000,
      tfsaStart: 50000,
      nonregStart: 80000,
      acbStart: 80000,
      baseSpending: 60000,
      activeSchedule: [],
      lifeExpectancy: 75,
      grossEmploymentIncome: 0,
      inflation: 0,
      growth: 0,
      provCode: "ON",
      cppScenarioAge: 65,
      selectedCPPMonthly: 0,
      oasPercent: 1,
      rrifStartAge: 72,
      enforceRrifMin: true,
      effectiveStrategy:
        "rrsp-fill-low-bracket-tfsa-transfer-opportunistic-tfsa",
    });

    expect(results).toHaveLength(1);
    expect(results[0].mandatoryRrifDraw).toBeCloseTo(29100, 6);
    expect(results[0].drawRRSP).toBeCloseTo(44951.85911786902, 6);
    expect(results[0].drawNonReg).toBeCloseTo(20373.21863909635, 6);
    expect(results[0].drawTFSA).toBeCloseTo(0, 6);
    expect(results[0].incomeTax).toBeCloseTo(8133.397756965367, 6);
    expect(results[0].oasClawback).toBeCloseTo(0, 6);
    expect(results[0].rrsp).toBeCloseTo(455048.140882131, 6);
    expect(results[0].tfsa).toBeCloseTo(57000, 6);
    expect(results[0].nonreg).toBeCloseTo(59626.78136090365, 6);
    expect(results[0].total).toBeCloseTo(571674.9222430347, 6);
  });

  it("recomputes rolling amortized spending from remaining assets and years", async () => {
    const { results } = await runDeterministicProjection({
      age: 60,
      retirementAge: 65,
      rrspStart: 0,
      tfsaStart: 1000000,
      nonregStart: 0,
      acbStart: 0,
      baseSpending: 60000,
      activeSchedule: [],
      lifeExpectancy: 61,
      grossEmploymentIncome: 0,
      inflation: 0,
      growth: 0,
      provCode: "ON",
      cppScenarioAge: 65,
      selectedCPPMonthly: 0,
      oasPercent: 0,
      rrifStartAge: 72,
      enforceRrifMin: false,
      effectiveStrategy: "tfsa-rrsp-nonreg",
      spendingMode: "rolling-amortization",
      amortizationRate: 0.03,
    });

    expect(results).toHaveLength(2);
    expect(results[0].spending).toBeCloseTo(507389.1625615762, 6);
    expect(results[0].drawTFSA).toBeCloseTo(507389.1625615762, 6);
    expect(results[1].spending).toBeCloseTo(492610.83743842406, 6);
    expect(results[1].drawTFSA).toBeCloseTo(492610.8374384238, 6);
    expect(results[1].spending).toBeLessThan(results[0].spending);
  });

  it("leaves target estate value at the end in rolling amortization mode", async () => {
    const { results } = await runDeterministicProjection({
      age: 60,
      retirementAge: 65,
      rrspStart: 0,
      tfsaStart: 1000000,
      nonregStart: 0,
      acbStart: 0,
      baseSpending: 60000,
      activeSchedule: [],
      lifeExpectancy: 61,
      grossEmploymentIncome: 0,
      inflation: 0,
      growth: 0,
      provCode: "ON",
      cppScenarioAge: 65,
      selectedCPPMonthly: 0,
      oasPercent: 0,
      rrifStartAge: 72,
      enforceRrifMin: false,
      effectiveStrategy: "tfsa-rrsp-nonreg",
      spendingMode: "rolling-amortization",
      amortizationRate: 0.03,
      targetEstateValue: 100000,
    });

    expect(results).toHaveLength(2);
    expect(results[0].spending).toBeCloseTo(458128.0788177338, 6);
    expect(results[1].spending).toBeCloseTo(441871.9211822664, 6);
    expect(results[1].total).toBeCloseTo(100000, 6);
    expect(results[1].spending).toBeLessThan(results[0].spending);
  });
});
