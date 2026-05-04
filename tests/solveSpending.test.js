import { describe, expect, it } from "vitest";
import { solveSustainableSpending } from "../src/core/solveSpending.js";
import { runMonteCarlo } from "../src/core/monteCarlo.js";

describe("solveSustainableSpending", () => {
  it("finds a sustainable spend near the target threshold", async () => {
    const threshold = 80000;
    const calls = [];

    const runMonteCarlo = async ({ baseSpending }) => {
      calls.push(baseSpending);
      return {
        successRate: baseSpending <= threshold ? 0.92 : 0.7,
      };
    };

    const solved = await solveSustainableSpending({
      targetSuccessRate: 0.9,
      precision: 250,
      maxIterations: 20,
      baselineSpend: 60000,
      monteCarloParams: { trials: 600 },
      runMonteCarlo,
      formatCurrency: (n) => `$${Math.round(n)}`,
    });

    expect(solved).toBeTypeOf("number");
    expect(solved).toBeLessThanOrEqual(threshold);
    expect(threshold - solved).toBeLessThanOrEqual(300);
    expect(calls.length).toBeGreaterThan(3);
  });

  it("returns null when cancellation is requested", async () => {
    const runMonteCarlo = async () => ({ successRate: 0.95 });

    const solved = await solveSustainableSpending({
      targetSuccessRate: 0.9,
      precision: 100,
      maxIterations: 10,
      baselineSpend: 60000,
      monteCarloParams: { trials: 500 },
      runMonteCarlo,
      formatCurrency: (n) => `$${Math.round(n)}`,
      shouldCancel: () => true,
    });

    expect(solved).toBeNull();
  });

  it("meets target success on a seeded real Monte Carlo run", async () => {
    const monteCarloParams = {
      age: 65,
      rrspStart: 500000,
      tfsaStart: 200000,
      nonregStart: 100000,
      acbStart: 70000,
      baseSpending: 60000,
      spendingSchedule: [],
      inflation: 0.02,
      growth: 0.05,
      provCode: "ON",
      cppScenarioAge: 65,
      selectedCPPMonthly: 1200,
      oasPercent: 1,
      rrifStartAge: 72,
      enforceRrifMin: true,
      strategy: "tfsa-rrsp-nonreg",
      projectionAge: 95,
      trials: 220,
      volatility: 0.12,
      inflationVolatility: 0.01,
      seed: 12345,
    };

    const targetSuccessRate = 0.8;
    const precision = 500;
    const solved = await solveSustainableSpending({
      targetSuccessRate,
      precision,
      maxIterations: 18,
      baselineSpend: 60000,
      monteCarloParams,
      runMonteCarlo,
      formatCurrency: (n) => `$${Math.round(n)}`,
    });

    expect(solved).not.toBeNull();
    const atSolved = await runMonteCarlo({
      ...monteCarloParams,
      baseSpending: solved,
    });
    expect(atSolved.successRate).toBeGreaterThanOrEqual(targetSuccessRate);

    const aboveSolved = await runMonteCarlo({
      ...monteCarloParams,
      baseSpending: solved + precision,
    });
    expect(aboveSolved.successRate).toBeLessThanOrEqual(atSolved.successRate);
  });
});
