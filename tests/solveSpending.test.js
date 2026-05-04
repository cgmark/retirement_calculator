import { describe, expect, it } from "vitest";
import { solveSustainableSpending } from "../src/core/solveSpending.js";

describe("solveSustainableSpending", () => {
  it("finds a sustainable spend near the target threshold", async () => {
    const threshold = 80000;
    const calls = [];

    const runMonteCarlo = async ({ baseSpending }) => {
      calls.push(baseSpending);
      return {
        successRate: baseSpending <= threshold ? 0.92 : 0.70
      };
    };

    const solved = await solveSustainableSpending({
      targetSuccessRate: 0.9,
      precision: 250,
      maxIterations: 20,
      baselineSpend: 60000,
      monteCarloParams: { trials: 600 },
      runMonteCarlo,
      formatCurrency: (n) => `$${Math.round(n)}`
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
      shouldCancel: () => true
    });

    expect(solved).toBeNull();
  });
});
