import { getNextCombinedBracketLimit } from "./tax.js";

const STRATEGY_SEQUENCES = {
  "tfsa-rrsp-nonreg": ["tfsa", "rrsp", "nonreg"],
  "tfsa-nonreg-rrsp": ["tfsa", "nonreg", "rrsp"],
  "rrsp-tfsa-nonreg": ["rrsp", "tfsa", "nonreg"],
  "nonreg-tfsa-rrsp": ["nonreg", "tfsa", "rrsp"],
  "nonreg-rrsp-tfsa": ["nonreg", "rrsp", "tfsa"],
  "rrsp-nonreg-tfsa": ["rrsp", "nonreg", "tfsa"],
};

export function applySequenceDraw({
  strategy,
  targetNet,
  getNetNeeded,
  executeDraw,
}) {
  const sequence = STRATEGY_SEQUENCES[strategy];
  if (!sequence || targetNet <= 0 || getNetNeeded() <= 0) return;
  // Each executeDraw call is capped by current net-needed; later calls may be no-ops.
  sequence.forEach((accountType) => executeDraw(accountType, targetNet));
}

export function applyProportionalDraw({
  getBalances,
  getNetNeeded,
  executeDraw,
  iterations = 10,
}) {
  for (let k = 0; k < iterations && getNetNeeded() > 0.01; k++) {
    const balances = getBalances();
    const total = balances.rrsp + balances.tfsa + balances.nonreg;
    if (total <= 0) break;
    const need = getNetNeeded();
    executeDraw("tfsa", need * (balances.tfsa / total));
    executeDraw("nonreg", need * (balances.nonreg / total));
    executeDraw("rrsp", need * (balances.rrsp / total));
  }
}

export function applyWeightedMixDraw({
  getBalances,
  getNetNeeded,
  executeDraw,
  mix,
  iterations = 20,
  allowFallback = true,
}) {
  for (let k = 0; k < iterations && getNetNeeded() > 0.01; k++) {
    const balances = getBalances();
    const active = {
      tfsa: balances.tfsa > 0 ? mix.tfsa : 0,
      nonreg: balances.nonreg > 0 ? mix.nonreg : 0,
      rrsp: balances.rrsp > 0 ? mix.rrsp : 0,
    };
    const den = active.tfsa + active.nonreg + active.rrsp;
    if (den <= 0) break;
    const need = getNetNeeded();
    executeDraw("tfsa", need * (active.tfsa / den));
    executeDraw("nonreg", need * (active.nonreg / den));
    executeDraw("rrsp", need * (active.rrsp / den));
  }

  if (allowFallback && getNetNeeded() > 0.01) {
    // Fallback sweep prevents tiny residual shortfalls due to tax feedback and rounding.
    ["tfsa", "nonreg", "rrsp"].forEach((accountType) =>
      executeDraw(accountType, getNetNeeded()),
    );
  }
}

export function applyEarlyRetirementDraw({
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

  // Prefer non-reg for remainder in early-retirement mode unless TFSA has become advantageous.
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
