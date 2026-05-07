import { describe, expect, it } from "vitest";
import { runRetirementCalculation } from "../src/core/calculateRetirement.js";

describe("runRetirementCalculation", () => {
  it("flags infeasible solve targets without overwriting spending", async () => {
    const outcome = await runRetirementCalculation({
      inputs: {
        age: 65,
        retirementAge: 65,
        rrsp: 100000,
        tfsa: 0,
        nonreg: 0,
        currentAcb: 0,
        baseSpending: 60000,
        spendingSchedule: [],
        spendingMode: "solve",
        targetSuccessRate: 0.9,
        solvePrecision: 100,
        lifeExpectancy: 90,
        grossEmploymentIncome: 0,
        inflation: 0.02,
        growth: 0.05,
        provCode: "ON",
        cppScenarioAge: 65,
        selectedCPPMonthly: 0,
        oasPercent: 0,
        rrifStartAge: 72,
        enforceRrifMin: true,
        strategy: "tfsa-rrsp-nonreg",
        enableMonteCarlo: true,
        mcTrials: 200,
        mcVolatility: 0.1,
        mcInflationVolatility: 0.01,
        mcBadYearSpendCutPct: 0,
        mcSeed: 1,
      },
      runMonteCarloNow: true,
      lastMonteCarloResults: null,
      runMonteCarlo: async ({ trials }) => ({
        successRate: 0.1,
        cancelled: false,
        trials,
        requestedTrials: trials,
      }),
      solveSustainableSpending: async () => Number.NaN,
      runDeterministicProjection: async () => ({
        results: [
          {
            age: 65,
            yearIndex: 0,
            total: 1,
            depleted: false,
            spending: 60000,
            cpp: 0,
            oas: 0,
            drawRRSP: 0,
            drawTFSA: 0,
            drawNonReg: 0,
            incomeTax: 0,
            oasClawback: 0,
            rrsp: 0,
            tfsa: 0,
            nonreg: 0,
            acb: 0,
          },
        ],
      }),
      formatCurrency: (n) => `$${Math.round(n)}`,
      shouldCancel: () => false,
    });

    expect(outcome.solveFailed).toBe(true);
    expect(outcome.solvedSpendOutput).toBeNull();
    expect(outcome.baseSpending).toBe(60000);
  });
});
