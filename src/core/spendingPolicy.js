import {
  getBaseSpendingForAge,
  getScheduleMultiplierForAge,
} from "./spending.js";

export const ADAPTIVE_SPENDING_THRESHOLDS = {
  low: { minReturn: -0.25, maxReturn: 0.2 },
  medium: { minReturn: -0.15, maxReturn: 0.15 },
  high: { minReturn: -0.1, maxReturn: 0.1 },
};

export function normalizeAdaptiveSpendingSensitivity(sensitivity = "medium") {
  return Object.hasOwn(ADAPTIVE_SPENDING_THRESHOLDS, sensitivity)
    ? sensitivity
    : "medium";
}

export function getAdaptiveSpendingValidationError({
  targetSpend,
  minSpend,
  maxSpend,
}) {
  if (!Number.isFinite(minSpend) || minSpend < 0)
    return "Min Spend must be greater than or equal to $0.";
  if (!Number.isFinite(maxSpend) || maxSpend < 0)
    return "Max Spend must be greater than or equal to $0.";
  if (minSpend > targetSpend)
    return "Min Spend must be less than or equal to Desired Net Spend/Yr.";
  if (maxSpend < targetSpend)
    return "Max Spend must be greater than or equal to Desired Net Spend/Yr.";
  return null;
}

export function adjustSpendingForReturn({
  targetSpend,
  minSpend,
  maxSpend,
  annualReturn,
  expectedReturn = 0,
  sensitivity = "medium",
}) {
  if (!Number.isFinite(targetSpend)) return 0;
  const floor = Number.isFinite(minSpend) ? minSpend : targetSpend;
  const ceiling = Number.isFinite(maxSpend) ? maxSpend : targetSpend;
  if (!Number.isFinite(annualReturn) || !Number.isFinite(expectedReturn))
    return targetSpend;

  const thresholds =
    ADAPTIVE_SPENDING_THRESHOLDS[
      normalizeAdaptiveSpendingSensitivity(sensitivity)
    ];

  const returnGap = annualReturn - expectedReturn;
  if (returnGap === 0) return targetSpend;

  if (returnGap < 0) {
    const distance = targetSpend - floor;
    if (distance <= 0) return floor;
    const cutProgress = Math.min(1, returnGap / thresholds.minReturn);
    return targetSpend - distance * cutProgress;
  }

  const distance = ceiling - targetSpend;
  if (distance <= 0) return ceiling;
  const increaseProgress = Math.min(1, returnGap / thresholds.maxReturn);
  return targetSpend + distance * increaseProgress;
}

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
  rollingMinSpend = 0,
  rollingMaxSpend = 0,
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
    const targetSpend = realSpend * inflationFactor * multiplier;
    const minSpend = Math.max(0, rollingMinSpend) * inflationFactor;
    const maxSpendValue = Math.max(0, rollingMaxSpend);
    const maxSpend =
      maxSpendValue > 0
        ? Math.max(minSpend, maxSpendValue * inflationFactor)
        : Infinity;
    return Math.max(minSpend, Math.min(targetSpend, maxSpend));
  }

  const ageBaseSpending = getBaseSpendingForAge(currentAge, baseSpending, []);
  const multiplier = getScheduleMultiplierForAge(currentAge, schedule);
  return ageBaseSpending * inflationFactor * multiplier;
}
