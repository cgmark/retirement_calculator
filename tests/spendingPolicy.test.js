import { describe, expect, it } from "vitest";
import {
  adjustSpendingForReturn,
  calculateAmortizedPayment,
  getAdaptiveSpendingValidationError,
  getTargetSpendingForYear,
} from "../src/core/spendingPolicy.js";

describe("spending policy helpers", () => {
  it("calculates amortized payment with positive rate", () => {
    const payment = calculateAmortizedPayment(1000000, 0.03, 30);
    expect(payment).toBeCloseTo(49533.26147597335, 6);
  });

  it("reduces amortized payment when targeting a nonzero estate", () => {
    const payment = calculateAmortizedPayment(1000000, 0.03, 30, 100000);
    expect(payment).toBeCloseTo(47431.33554394809, 6);
    expect(payment).toBeLessThan(calculateAmortizedPayment(1000000, 0.03, 30));
  });

  it("falls back to straight-line draw when amortization rate is zero", () => {
    const payment = calculateAmortizedPayment(120000, 0, 12);
    expect(payment).toBeCloseTo(10000, 6);
  });

  it("computes rolling amortized spending in today's dollars then re-inflates", () => {
    const target = getTargetSpendingForYear({
      spendingMode: "rolling-amortization",
      currentAge: 60,
      projectionAge: 89,
      baseSpending: 60000,
      schedule: [],
      inflationFactor: 1.1,
      totalPortfolio: 1100000,
      amortizationRate: 0.03,
    });

    expect(target).toBeCloseTo(54486.58762357068, 6);
  });

  it("uses target estate value in today's dollars for rolling amortization", () => {
    const target = getTargetSpendingForYear({
      spendingMode: "rolling-amortization",
      currentAge: 60,
      projectionAge: 89,
      baseSpending: 60000,
      schedule: [],
      inflationFactor: 1,
      totalPortfolio: 1000000,
      amortizationRate: 0.03,
      targetEstateValue: 100000,
    });

    expect(target).toBeCloseTo(47431.33554394809, 6);
  });

  it("applies schedule multipliers in rolling amortization mode", () => {
    const target = getTargetSpendingForYear({
      spendingMode: "rolling-amortization",
      currentAge: 80,
      projectionAge: 89,
      baseSpending: 60000,
      schedule: [{ startAge: 75, endAge: 89, amount: 80 }],
      inflationFactor: 1,
      totalPortfolio: 1000000,
      amortizationRate: 0.03,
    });

    expect(target).toBeCloseTo(91052.82066420157, 6);
  });

  it("applies rolling min spend floor in today's dollars", () => {
    const target = getTargetSpendingForYear({
      spendingMode: "rolling-amortization",
      currentAge: 60,
      projectionAge: 89,
      baseSpending: 60000,
      schedule: [],
      inflationFactor: 1.2,
      totalPortfolio: 500000,
      amortizationRate: 0.03,
      rollingMinSpend: 50000,
    });

    expect(target).toBe(60000);
  });

  it("applies rolling max spend cap in today's dollars", () => {
    const target = getTargetSpendingForYear({
      spendingMode: "rolling-amortization",
      currentAge: 60,
      projectionAge: 89,
      baseSpending: 60000,
      schedule: [],
      inflationFactor: 1.1,
      totalPortfolio: 3000000,
      amortizationRate: 0.03,
      rollingMaxSpend: 70000,
    });

    expect(target).toBe(77000);
  });

  it("adjusts desired spending down toward min based on negative returns", () => {
    const target = adjustSpendingForReturn({
      targetSpend: 100000,
      minSpend: 80000,
      maxSpend: 120000,
      annualReturn: -0.025,
      expectedReturn: 0.05,
      sensitivity: "medium",
    });

    expect(target).toBe(90000);
  });

  it("keeps desired spending at target when return matches expectation", () => {
    const target = adjustSpendingForReturn({
      targetSpend: 100000,
      minSpend: 80000,
      maxSpend: 120000,
      annualReturn: 0.05,
      expectedReturn: 0.05,
      sensitivity: "medium",
    });

    expect(target).toBe(100000);
  });

  it("adjusts desired spending up toward max based on above-expected returns", () => {
    const target = adjustSpendingForReturn({
      targetSpend: 100000,
      minSpend: 80000,
      maxSpend: 120000,
      annualReturn: 0.125,
      expectedReturn: 0.05,
      sensitivity: "medium",
    });

    expect(target).toBe(110000);
  });

  it("cuts desired spending faster when assets are below the baseline path", () => {
    const target = adjustSpendingForReturn({
      targetSpend: 100000,
      minSpend: 80000,
      maxSpend: 120000,
      annualReturn: 0.05,
      expectedReturn: 0.05,
      assetDeviation: -0.05,
      assetSensitivity: "high",
      sensitivity: "medium",
    });

    expect(target).toBe(80000);
  });

  it("raises desired spending more slowly when assets are above the baseline path", () => {
    const target = adjustSpendingForReturn({
      targetSpend: 100000,
      minSpend: 80000,
      maxSpend: 120000,
      annualReturn: 0.05,
      expectedReturn: 0.05,
      assetDeviation: 0.075,
      assetSensitivity: "medium",
      sensitivity: "medium",
    });

    expect(target).toBe(107500);
  });

  it("allows asset sensitivity to work without return sensitivity", () => {
    const target = adjustSpendingForReturn({
      targetSpend: 100000,
      minSpend: 80000,
      maxSpend: 120000,
      annualReturn: 0.05,
      expectedReturn: 0.05,
      sensitivity: "off",
      assetDeviation: -0.05,
      assetSensitivity: "high",
    });

    expect(target).toBe(80000);
  });

  it("reports invalid desired min/max bounds without rewriting them", () => {
    expect(
      getAdaptiveSpendingValidationError({
        targetSpend: 100000,
        minSpend: 110000,
        maxSpend: 120000,
      }),
    ).toBe("Min Spend must be less than or equal to Desired Net Spend/Yr.");
  });
});
