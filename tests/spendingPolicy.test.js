import { describe, expect, it } from "vitest";
import {
  calculateAmortizedPayment,
  getTargetSpendingForYear,
} from "../src/core/spendingPolicy.js";

describe("spending policy helpers", () => {
  it("calculates amortized payment with positive rate", () => {
    const payment = calculateAmortizedPayment(1000000, 0.03, 30);
    expect(payment).toBeCloseTo(49533.26147597335, 6);
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
});
