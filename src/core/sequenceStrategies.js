export const STRATEGY_SEQUENCES = {
  "tfsa-rrsp-nonreg": ["tfsa", "rrsp", "nonreg"],
  "tfsa-nonreg-rrsp": ["tfsa", "nonreg", "rrsp"],
  "rrsp-tfsa-nonreg": ["rrsp", "tfsa", "nonreg"],
  "nonreg-tfsa-rrsp": ["nonreg", "tfsa", "rrsp"],
  "nonreg-rrsp-tfsa": ["nonreg", "rrsp", "tfsa"],
  "rrsp-nonreg-tfsa": ["rrsp", "nonreg", "tfsa"],
};

export function isSequenceStrategy(strategy) {
  return Object.prototype.hasOwnProperty.call(STRATEGY_SEQUENCES, strategy);
}

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
