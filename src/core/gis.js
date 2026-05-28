export const GIS_SINGLE_INCOME_CUTOFF_BASE = 22512;
export const GIS_SINGLE_MAX_MONTHLY_BASE = 1109.85;

export function calculateSingleGisBenefit({
  age,
  grossOAS,
  priorYearIncome,
  inflFactor,
}) {
  if (age < 65 || grossOAS <= 0) return 0;

  const adjustedCutoff = GIS_SINGLE_INCOME_CUTOFF_BASE * inflFactor;
  const adjustedMaxAnnual = GIS_SINGLE_MAX_MONTHLY_BASE * 12 * inflFactor;
  const income = Math.max(0, priorYearIncome || 0);

  if (income >= adjustedCutoff) return 0;
  return adjustedMaxAnnual * (1 - income / adjustedCutoff);
}

export function getApproximateGisIncomeBase({ taxableIncome, grossOAS }) {
  return Math.max(0, (taxableIncome || 0) - (grossOAS || 0));
}
