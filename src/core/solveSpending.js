export async function solveSustainableSpending(params) {
    const {
        targetSuccessRate,
        precision,
        maxIterations,
        baselineSpend,
        monteCarloParams,
        runMonteCarlo,
        formatCurrency,
        onIteration,
        shouldCancel
    } = params;

    // Two-phase search:
    // 1) Bracket a failure point by expanding high spend.
    // 2) Binary-search highest spend meeting target success.
    let low = 0;
    let high = Math.max(10000, baselineSpend || 60000);
    // Use a smaller trial count while solving to keep UI latency acceptable.
    const testTrials = Math.max(150, Math.min(400, Math.round((monteCarloParams.trials || 500) * 0.5)));

    for (let expand = 0; expand < 8; expand++) {
        const res = await runMonteCarlo({ ...monteCarloParams, trials: testTrials, baseSpending: high });
        if (typeof onIteration === "function") onIteration(`Bracketing at ${formatCurrency(high)} (${(res.successRate * 100).toFixed(1)}%)`);
        if (typeof shouldCancel === "function" && shouldCancel()) return null;
        if (res.successRate < targetSuccessRate) break;
        high *= 1.5;
    }

    let best = low;
    for (let i = 0; i < maxIterations; i++) {
        if (typeof shouldCancel === "function" && shouldCancel()) return null;
        const mid = (low + high) / 2;
        const res = await runMonteCarlo({ ...monteCarloParams, trials: testTrials, baseSpending: mid });
        if (typeof onIteration === "function") onIteration(`Solve iter ${i + 1}/${maxIterations}: ${formatCurrency(mid)} -> ${(res.successRate * 100).toFixed(1)}%`);

        if (res.successRate >= targetSuccessRate) {
            best = mid;
            low = mid;
        } else {
            high = mid;
        }
        if ((high - low) <= precision) break;
    }

    return best;
}
