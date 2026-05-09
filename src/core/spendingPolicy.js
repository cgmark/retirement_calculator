import {
  getBaseSpendingForAge,
  getScheduleMultiplierForAge,
} from "./spending.js";

export function calculateAmortizedPayment(
  principal,
  rate,
  periods,
  targetEndingBalance = 0,
) {
  if (!Number.isFinite(principal) || principal <= 0 || periods <= 0) return 0;
  const endingBalance = Math.max(0, targetEndingBalance);
  if (!Number.isFinite(rate) || Math.abs(rate) < 1e-9)
    return Math.max(0, principal - endingBalance) / periods;
  const discountedEndingBalance =
    endingBalance / Math.pow(1 + rate, Math.max(0, periods - 1));
  const spendablePrincipal = Math.max(0, principal - discountedEndingBalance);
  return (
    spendablePrincipal *
    (rate / ((1 - Math.pow(1 + rate, -periods)) * (1 + rate)))
  );
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
  targetEstateValue = 0,
}) {
  if (spendingMode === "rolling-amortization") {
    const remainingYears = Math.max(1, projectionAge - currentAge + 1);
    const realPortfolio = totalPortfolio / inflationFactor;
    const realTargetEstate = Math.max(0, targetEstateValue);
    const realSpend = calculateAmortizedPayment(
      realPortfolio,
      amortizationRate,
      remainingYears,
      realTargetEstate,
    );
    const multiplier = getScheduleMultiplierForAge(currentAge, schedule);
    return realSpend * inflationFactor * multiplier;
  }

  const ageBaseSpending = getBaseSpendingForAge(currentAge, baseSpending, []);
  const multiplier = getScheduleMultiplierForAge(currentAge, schedule);
  return ageBaseSpending * inflationFactor * multiplier;
}
