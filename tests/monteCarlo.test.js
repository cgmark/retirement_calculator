import { describe, expect, it } from "vitest";
import { runMonteCarlo } from "../src/core/monteCarlo.js";

function baseParams(overrides = {}) {
  return {
    age: 65,
    rrspStart: 450000,
    tfsaStart: 180000,
    nonregStart: 90000,
    acbStart: 60000,
    baseSpending: 55000,
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
    projectionAge: 92,
    trials: 120,
    volatility: 0.12,
    inflationVolatility: 0.01,
    badYearSpendCutPct: 0,
    seed: 123,
    ...overrides,
  };
}

describe("runMonteCarlo", () => {
  it("is deterministic with fixed seed", async () => {
    const params = baseParams({ seed: 42, trials: 140 });
    const a = await runMonteCarlo(params);
    const b = await runMonteCarlo(params);

    expect(b).toEqual(a);
  });

  it("returns expected output shape", async () => {
    const res = await runMonteCarlo(baseParams({ seed: 99, trials: 90 }));

    expect(res.trials).toBeGreaterThan(0);
    expect(res.requestedTrials).toBe(90);
    expect(res.successRate).toBeGreaterThanOrEqual(0);
    expect(res.successRate).toBeLessThanOrEqual(1);
    expect(Array.isArray(res.bucketLabels)).toBe(true);
    expect(Array.isArray(res.ageLabels)).toBe(true);
    expect(res.ageLabels.length).toBe(92 - 65 + 1);
    expect(res.assetP10.length).toBe(res.ageLabels.length);
    expect(res.assetP50.length).toBe(res.ageLabels.length);
    expect(res.assetP90.length).toBe(res.ageLabels.length);
    expect(
      res.bucketLabels.every((label) =>
        Number.isFinite(res.bucketCounts[label]),
      ),
    ).toBe(true);
  });

  it("supports cancellation with partial results", async () => {
    let checks = 0;
    const shouldCancel = () => {
      checks += 1;
      return checks > 3;
    };

    const res = await runMonteCarlo(baseParams({ trials: 200, shouldCancel }));

    expect(res.cancelled).toBe(true);
    expect(res.trials).toBeGreaterThan(0);
    expect(res.trials).toBeLessThan(res.requestedTrials);
  });

  it("runs with rrsp-meltdown strategy", async () => {
    const res = await runMonteCarlo(
      baseParams({ strategy: "rrsp-meltdown", seed: 777, trials: 80 }),
    );
    expect(res.trials).toBe(80);
    expect(res.successRate).toBeGreaterThanOrEqual(0);
    expect(res.successRate).toBeLessThanOrEqual(1);
  });

  it("runs with rrsp-meltdown +10% and +20% strategies", async () => {
    const plus10 = await runMonteCarlo(
      baseParams({
        strategy: "rrsp-meltdown-plus10",
        seed: 778,
        trials: 60,
      }),
    );
    const plus20 = await runMonteCarlo(
      baseParams({
        strategy: "rrsp-meltdown-plus20",
        seed: 779,
        trials: 60,
      }),
    );

    expect(plus10.trials).toBe(60);
    expect(plus20.trials).toBe(60);
  });

  it("runs with rrsp-meltdown +50% strategy", async () => {
    const res = await runMonteCarlo(
      baseParams({
        strategy: "rrsp-meltdown-plus50",
        seed: 785,
        trials: 60,
      }),
    );
    expect(res.trials).toBe(60);
    expect(res.successRate).toBeGreaterThanOrEqual(0);
    expect(res.successRate).toBeLessThanOrEqual(1);
  });

  it("runs with rrsp-meltdown TFSA transfer strategy", async () => {
    const res = await runMonteCarlo(
      baseParams({
        strategy: "rrsp-meltdown-tfsa-transfer",
        seed: 780,
        trials: 60,
      }),
    );

    expect(res.trials).toBe(60);
    expect(res.successRate).toBeGreaterThanOrEqual(0);
    expect(res.successRate).toBeLessThanOrEqual(1);
  });

  it("runs with rrsp-meltdown TFSA transfer opportunistic TFSA strategy", async () => {
    const res = await runMonteCarlo(
      baseParams({
        strategy: "rrsp-meltdown-tfsa-transfer-opportunistic-tfsa",
        seed: 781,
        trials: 60,
      }),
    );

    expect(res.trials).toBe(60);
    expect(res.successRate).toBeGreaterThanOrEqual(0);
    expect(res.successRate).toBeLessThanOrEqual(1);
  });

  it("applies spending cut in negative-return years", async () => {
    const noCut = await runMonteCarlo(
      baseParams({
        trials: 80,
        seed: 888,
        badYearSpendCutPct: 0,
        volatility: 0.18,
      }),
    );
    const withCut = await runMonteCarlo(
      baseParams({
        trials: 80,
        seed: 888,
        badYearSpendCutPct: 0.2,
        volatility: 0.18,
      }),
    );

    expect(withCut).not.toEqual(noCut);
  });
});
