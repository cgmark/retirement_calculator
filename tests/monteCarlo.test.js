import { describe, expect, it } from "vitest";
import { runMonteCarlo } from "../src/core/monteCarlo.js";

function baseParams(overrides = {}) {
  return {
    age: 65,
    retirementAge: 65,
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
    grossEmploymentIncome: 0,
    trials: 120,
    volatility: 0.12,
    inflationVolatility: 0.01,
    desiredMinSpend: 50000,
    desiredMaxSpend: 65000,
    spendSensitivity: "medium",
    desiredSpendingBoundsError: null,
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
    expect(res.pctTrialsBelowTargetSpend).toBeGreaterThanOrEqual(0);
    expect(res.pctTrialsBelowTargetSpend).toBeLessThanOrEqual(1);
    expect(res.pctTrialsHittingMinSpend).toBeGreaterThanOrEqual(0);
    expect(res.pctTrialsHittingMinSpend).toBeLessThanOrEqual(1);
    expect(res.medianYearsBelowTargetSpend).toBeGreaterThanOrEqual(0);
    expect(res.medianAverageAnnualSpend).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(res.bucketLabels)).toBe(true);
    expect(Array.isArray(res.ageLabels)).toBe(true);
    expect(res.ageLabels.length).toBe(92 - 65 + 1);
    expect(res.assetP10.length).toBe(res.ageLabels.length);
    expect(res.assetP50.length).toBe(res.ageLabels.length);
    expect(res.assetP90.length).toBe(res.ageLabels.length);
    expect(res.spendP10.length).toBe(res.ageLabels.length);
    expect(res.spendP50.length).toBe(res.ageLabels.length);
    expect(res.spendP90.length).toBe(res.ageLabels.length);
    expect(Array.isArray(res.sampleAssetPaths)).toBe(true);
    expect(Array.isArray(res.sampleSpendPaths)).toBe(true);
    expect(Array.isArray(res.sampleInflationPaths)).toBe(true);
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
    expect(res.sampleAssetPaths.length).toBeLessThanOrEqual(res.trials);
    expect(res.sampleSpendPaths.length).toBeLessThanOrEqual(res.trials);
  });

  it("retains a configurable number of sample paths", async () => {
    const res = await runMonteCarlo(
      baseParams({ trials: 12, samplePathCount: 3, seed: 321 }),
    );

    expect(res.sampleAssetPaths).toHaveLength(3);
    expect(res.sampleSpendPaths).toHaveLength(3);
    expect(res.sampleInflationPaths).toHaveLength(3);
    expect(res.sampleAssetPaths[0]).toHaveLength(res.ageLabels.length);
    expect(res.sampleSpendPaths[0]).toHaveLength(res.ageLabels.length);
    expect(res.sampleInflationPaths[0]).toHaveLength(res.ageLabels.length);
  });

  it("runs with rrsp-fill-low-bracket strategy", async () => {
    const res = await runMonteCarlo(
      baseParams({ strategy: "rrsp-fill-low-bracket", seed: 777, trials: 80 }),
    );
    expect(res.trials).toBe(80);
    expect(res.successRate).toBeGreaterThanOrEqual(0);
    expect(res.successRate).toBeLessThanOrEqual(1);
  });

  it("supports fat-tail model with deterministic seeded output", async () => {
    const params = baseParams({ mcModel: "fat-tail", seed: 43, trials: 140 });
    const a = await runMonteCarlo(params);
    const b = await runMonteCarlo(params);

    expect(b).toEqual(a);
  });

  it("produces different results for fat-tail vs normal under same seed", async () => {
    const normal = await runMonteCarlo(
      baseParams({ mcModel: "normal", seed: 44, trials: 120 }),
    );
    const fatTail = await runMonteCarlo(
      baseParams({ mcModel: "fat-tail", seed: 44, trials: 120 }),
    );

    expect(fatTail).not.toEqual(normal);
  });

  it("runs with rrsp-fill-low-bracket +10% and +20% strategies", async () => {
    const plus10 = await runMonteCarlo(
      baseParams({
        strategy: "rrsp-fill-low-bracket-plus10",
        seed: 778,
        trials: 60,
      }),
    );
    const plus20 = await runMonteCarlo(
      baseParams({
        strategy: "rrsp-fill-low-bracket-plus20",
        seed: 779,
        trials: 60,
      }),
    );

    expect(plus10.trials).toBe(60);
    expect(plus20.trials).toBe(60);
  });

  it("runs with rrsp-fill-low-bracket +50% strategy", async () => {
    const res = await runMonteCarlo(
      baseParams({
        strategy: "rrsp-fill-low-bracket-plus50",
        seed: 785,
        trials: 60,
      }),
    );
    expect(res.trials).toBe(60);
    expect(res.successRate).toBeGreaterThanOrEqual(0);
    expect(res.successRate).toBeLessThanOrEqual(1);
  });

  it("runs with rrsp-fill-low-bracket TFSA transfer strategy", async () => {
    const res = await runMonteCarlo(
      baseParams({
        strategy: "rrsp-fill-low-bracket-tfsa-transfer",
        seed: 780,
        trials: 60,
      }),
    );

    expect(res.trials).toBe(60);
    expect(res.successRate).toBeGreaterThanOrEqual(0);
    expect(res.successRate).toBeLessThanOrEqual(1);
  });

  it("runs with rrsp-fill-low-bracket TFSA transfer opportunistic TFSA strategy", async () => {
    const res = await runMonteCarlo(
      baseParams({
        strategy: "rrsp-fill-low-bracket-tfsa-transfer-opportunistic-tfsa",
        seed: 781,
        trials: 60,
      }),
    );

    expect(res.trials).toBe(60);
    expect(res.successRate).toBeGreaterThanOrEqual(0);
    expect(res.successRate).toBeLessThanOrEqual(1);
  });

  it("adapts desired spending to annual returns", async () => {
    const baseline = await runMonteCarlo(
      baseParams({
        trials: 80,
        seed: 888,
        desiredMinSpend: 55000,
        desiredMaxSpend: 55000,
        volatility: 0.18,
      }),
    );
    const adaptive = await runMonteCarlo(
      baseParams({
        trials: 80,
        seed: 888,
        desiredMinSpend: 45000,
        desiredMaxSpend: 70000,
        spendSensitivity: "high",
        volatility: 0.18,
      }),
    );

    expect(adaptive).not.toEqual(baseline);
    expect(adaptive.spendP50).not.toEqual(baseline.spendP50);
  });

  it("falls back to plain desired spending when adaptive bounds are invalid", async () => {
    const valid = await runMonteCarlo(
      baseParams({
        seed: 902,
        trials: 50,
        volatility: 0.18,
        desiredMinSpend: 55000,
        desiredMaxSpend: 55000,
      }),
    );
    const invalid = await runMonteCarlo(
      baseParams({
        seed: 902,
        trials: 50,
        volatility: 0.18,
        desiredMinSpend: 65000,
        desiredMaxSpend: 70000,
        desiredSpendingBoundsError:
          "Min Spend must be less than or equal to Desired Net Spend/Yr.",
      }),
    );

    expect(invalid).toEqual(valid);
  });

  it("uses baseline asset sensitivity to push spending toward the floor", async () => {
    const years = 92 - 65 + 1;
    const baseline = await runMonteCarlo(
      baseParams({
        trials: 20,
        volatility: 0,
        growth: 0.05,
        desiredMinSpend: 45000,
        desiredMaxSpend: 65000,
        assetSensitivity: "off",
        baselineStartAssetsByYear: new Array(years).fill(720000),
      }),
    );
    const assetAware = await runMonteCarlo(
      baseParams({
        trials: 20,
        volatility: 0,
        growth: 0.05,
        desiredMinSpend: 45000,
        desiredMaxSpend: 65000,
        assetSensitivity: "medium",
        baselineStartAssetsByYear: new Array(years).fill(800000),
      }),
    );

    expect(assetAware.spendP50[0]).toBeLessThan(baseline.spendP50[0]);
    expect(assetAware.pctTrialsBelowTargetSpend).toBeGreaterThan(0);
  });

  it("leaves rolling amortization unchanged by desired adaptive settings", async () => {
    const baseline = await runMonteCarlo(
      baseParams({
        age: 60,
        retirementAge: 60,
        rrspStart: 0,
        tfsaStart: 1000000,
        nonregStart: 0,
        acbStart: 0,
        projectionAge: 63,
        baseSpending: 60000,
        spendingMode: "rolling-amortization",
        amortizationRate: 0.03,
        growth: 0.05,
        volatility: 0.18,
        inflationVolatility: 0,
        seed: 901,
        trials: 40,
      }),
    );
    const adaptive = await runMonteCarlo(
      baseParams({
        age: 60,
        retirementAge: 60,
        rrspStart: 0,
        tfsaStart: 1000000,
        nonregStart: 0,
        acbStart: 0,
        projectionAge: 63,
        baseSpending: 60000,
        spendingMode: "rolling-amortization",
        amortizationRate: 0.03,
        growth: 0.05,
        volatility: 0.18,
        inflationVolatility: 0,
        seed: 901,
        trials: 40,
        desiredMinSpend: 30000,
        desiredMaxSpend: 120000,
        spendSensitivity: "high",
      }),
    );

    expect(adaptive).toEqual(baseline);
  });

  it("runs with working years and surplus contributions", async () => {
    const res = await runMonteCarlo(
      baseParams({
        age: 60,
        retirementAge: 65,
        projectionAge: 70,
        grossEmploymentIncome: 100000,
        baseSpending: 10000,
        seed: 889,
        trials: 40,
      }),
    );

    expect(res.trials).toBe(40);
    expect(res.successRate).toBeGreaterThanOrEqual(0);
    expect(res.successRate).toBeLessThanOrEqual(1);
  });

  it("reinvests RRSP tax refunds into same-year savings", async () => {
    const res = await runMonteCarlo(
      baseParams({
        age: 60,
        retirementAge: 65,
        rrspStart: 0,
        tfsaStart: 0,
        nonregStart: 0,
        acbStart: 0,
        projectionAge: 60,
        grossEmploymentIncome: 100000,
        baseSpending: 10000,
        trials: 1,
        growth: 0,
        inflation: 0,
        volatility: 0,
        inflationVolatility: 0,
        seed: 890,
      }),
    );

    expect(res.trials).toBe(1);
    expect(res.avgTax).toBeCloseTo(16149.1295, 6);
    expect(res.avgTax).toBeLessThan(21706.0424);
    expect(res.medianFinalEstate).toBeCloseTo(73850.8705, 6);
  });

  it("clamps ACB down to non-registered balance", async () => {
    const oversizedAcb = await runMonteCarlo(
      baseParams({
        rrspStart: 0,
        tfsaStart: 0,
        nonregStart: 100000,
        acbStart: 150000,
        baseSpending: 50000,
        selectedCPPMonthly: 0,
        oasPercent: 0,
        projectionAge: 65,
        trials: 1,
        growth: 0,
        inflation: 0,
        volatility: 0,
        inflationVolatility: 0,
        seed: 891,
      }),
    );
    const clampedAcb = await runMonteCarlo(
      baseParams({
        rrspStart: 0,
        tfsaStart: 0,
        nonregStart: 100000,
        acbStart: 100000,
        baseSpending: 50000,
        selectedCPPMonthly: 0,
        oasPercent: 0,
        projectionAge: 65,
        trials: 1,
        growth: 0,
        inflation: 0,
        volatility: 0,
        inflationVolatility: 0,
        seed: 891,
      }),
    );

    expect(oversizedAcb).toEqual(clampedAcb);
  });

  it("runs with GIS enabled and remains deterministic under a fixed seed", async () => {
    const params = baseParams({
      enableGIS: true,
      gisInitialPriorYearIncome: 0,
      seed: 919,
      trials: 40,
    });
    const a = await runMonteCarlo(params);
    const b = await runMonteCarlo(params);

    expect(a).toEqual(b);
    expect(a.trials).toBe(40);
  });
});
