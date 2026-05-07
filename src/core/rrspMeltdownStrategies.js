import { getNextCombinedBracketLimit } from "./tax.js";

export function isRrspMeltdownStrategy(strategy) {
  return (
    strategy === "rrsp-fill-low-bracket" ||
    strategy === "rrsp-fill-low-bracket-plus10" ||
    strategy === "rrsp-fill-low-bracket-plus20" ||
    strategy === "rrsp-fill-low-bracket-plus50" ||
    strategy === "rrsp-fill-low-bracket-tfsa-transfer" ||
    strategy === "rrsp-fill-low-bracket-tfsa-transfer-opportunistic-tfsa"
  );
}

export function getRrspMeltdownOptions(strategy) {
  return {
    overshootPct:
      strategy === "rrsp-fill-low-bracket-plus50"
        ? 0.5
        : strategy === "rrsp-fill-low-bracket-plus20"
          ? 0.2
          : strategy === "rrsp-fill-low-bracket-plus10"
            ? 0.1
            : 0,
    enableTfsaTransfer:
      strategy === "rrsp-fill-low-bracket-tfsa-transfer" ||
      strategy === "rrsp-fill-low-bracket-tfsa-transfer-opportunistic-tfsa",
    opportunisticTfsa:
      strategy === "rrsp-fill-low-bracket-tfsa-transfer-opportunistic-tfsa",
  };
}

export function applyRrspMeltdownDraw({
  getBalances,
  getNetNeeded,
  getCurrentTaxableIncome,
  getGrossOAS,
  getMandatoryRrifDraw = () => 0,
  executeDraw,
  provCode,
  inflationFactor,
  overshootPct = 0,
  enableTfsaTransfer = false,
  onTfsaTransfer,
  opportunisticTfsa = false,
}) {
  if (getNetNeeded() <= 0) return;

  const balances = getBalances();
  const taxableIncome = getCurrentTaxableIncome();
  const bracketLimit = getNextCombinedBracketLimit(
    taxableIncome,
    provCode,
    inflationFactor,
  );

  // Fill current combined bracket with RRSP first.
  const rrspHeadroom = Math.max(0, bracketLimit - taxableIncome);
  const rrspHeadroomWithOvershoot = rrspHeadroom * (1 + overshootPct);
  if (rrspHeadroom > 0 && balances.rrsp > 0) {
    const netNeededBeforeRrsp = getNetNeeded();
    executeDraw("rrsp", Math.min(getNetNeeded(), rrspHeadroomWithOvershoot));
    if (enableTfsaTransfer && typeof onTfsaTransfer === "function") {
      const rrspNetProvided = Math.max(0, netNeededBeforeRrsp - getNetNeeded());
      const transferRoom = 7000 * inflationFactor;
      const transferAmount = Math.min(transferRoom, rrspNetProvided);
      if (transferAmount > 0) {
        onTfsaTransfer(transferAmount);
      }
    }
  }

  if (getNetNeeded() <= 0) return;

  const oasThreshold = 90997 * inflationFactor;
  const nearClawbackThreshold = oasThreshold * 0.95;
  const taxableIncomeAfterRrsp = getCurrentTaxableIncome();
  const hasOAS = getGrossOAS() > 0;
  const aboveClawback = taxableIncomeAfterRrsp > oasThreshold;
  const nearClawback = taxableIncomeAfterRrsp >= nearClawbackThreshold;
  const highMandatoryRrifDraw = getMandatoryRrifDraw() > 0 && nearClawback;
  const nonregExhausted = getBalances().nonreg <= 0.01;
  const shouldUseTfsaFirst =
    opportunisticTfsa &&
    getBalances().tfsa > 0 &&
    (nonregExhausted || (hasOAS && nearClawback) || highMandatoryRrifDraw);

  if (shouldUseTfsaFirst) {
    executeDraw("tfsa", getNetNeeded());
  }

  // Prefer non-reg for remainder in RRSP-meltdown mode unless TFSA has become advantageous.
  executeDraw("nonreg", getNetNeeded());
  if (getNetNeeded() <= 0) return;

  // If taxable income is above OAS threshold, favor TFSA for remaining marginal need.
  if ((hasOAS && aboveClawback) || shouldUseTfsaFirst) {
    executeDraw("tfsa", getNetNeeded());
  }

  if (getNetNeeded() > 0) {
    executeDraw("rrsp", getNetNeeded());
    executeDraw("nonreg", getNetNeeded());
    executeDraw("tfsa", getNetNeeded());
  }
}
