const STRATEGY_SEQUENCES = {
    "tfsa-rrsp-nonreg": ["tfsa", "rrsp", "nonreg"],
    "tfsa-nonreg-rrsp": ["tfsa", "nonreg", "rrsp"],
    "rrsp-tfsa-nonreg": ["rrsp", "tfsa", "nonreg"],
    "nonreg-tfsa-rrsp": ["nonreg", "tfsa", "rrsp"],
    "nonreg-rrsp-tfsa": ["nonreg", "rrsp", "tfsa"],
    "rrsp-nonreg-tfsa": ["rrsp", "nonreg", "tfsa"]
};

export function applySequenceDraw({ strategy, targetNet, getNetNeeded, executeDraw }) {
    const sequence = STRATEGY_SEQUENCES[strategy];
    if (!sequence || targetNet <= 0 || getNetNeeded() <= 0) return;
    sequence.forEach((accountType) => executeDraw(accountType, targetNet));
}

export function applyProportionalDraw({ getBalances, getNetNeeded, executeDraw, iterations = 10 }) {
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

export function applyWeightedMixDraw({ getBalances, getNetNeeded, executeDraw, mix, iterations = 20, allowFallback = true }) {
    for (let k = 0; k < iterations && getNetNeeded() > 0.01; k++) {
        const balances = getBalances();
        const active = {
            tfsa: balances.tfsa > 0 ? mix.tfsa : 0,
            nonreg: balances.nonreg > 0 ? mix.nonreg : 0,
            rrsp: balances.rrsp > 0 ? mix.rrsp : 0
        };
        const den = active.tfsa + active.nonreg + active.rrsp;
        if (den <= 0) break;
        const need = getNetNeeded();
        executeDraw("tfsa", need * (active.tfsa / den));
        executeDraw("nonreg", need * (active.nonreg / den));
        executeDraw("rrsp", need * (active.rrsp / den));
    }

    if (allowFallback && getNetNeeded() > 0.01) {
        ["tfsa", "nonreg", "rrsp"].forEach((accountType) => executeDraw(accountType, getNetNeeded()));
    }
}
