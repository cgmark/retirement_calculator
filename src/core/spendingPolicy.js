import { getBaseSpendingForAge } from "./spending.js";

export function calculateAmortizedPayment(principal, rate, periods) {
  if (!Number.isFinite(principal) || principal <= 0 || periods <= 0) return 0;
  if (!Number.isFinite(rate) || Math.abs(rate) < 1e-9)
    return principal / periods;
  return principal * (rate / ((1 - Math.pow(1 + rate, -periods)) * (1 + rate)));
}

export function getTargetSpendingForYear({
  spendingMode = "input",
  currentAge,
  projectionAge,
  baseSpending,
  schedule,
  inflationFactor,
  totalPortfolio,
  amortizationRate = 0,
}) {
  if (spendingMode === "rolling-amortization") {
    const remainingYears = Math.max(1, projectionAge - currentAge + 1);
    const realPortfolio = totalPortfolio / inflationFactor;
    const realSpend = calculateAmortizedPayment(
      realPortfolio,
      amortizationRate,
      remainingYears,
    );
    return realSpend * inflationFactor;
  }

  const ageBaseSpending = getBaseSpendingForAge(
    currentAge,
    baseSpending,
    schedule,
  );
  return ageBaseSpending * inflationFactor;
}
