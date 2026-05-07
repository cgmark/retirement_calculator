export { applySequenceDraw, isSequenceStrategy } from "./sequenceStrategies.js";
export {
  applyRrspMeltdownDraw,
  getRrspMeltdownOptions,
  isRrspMeltdownStrategy,
} from "./rrspMeltdownStrategies.js";

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
