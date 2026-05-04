export async function runRetirementCalculation(params) {
    const {
        inputs,
        runMonteCarloNow,
        lastMonteCarloResults,
        runMonteCarlo,
        solveSustainableSpending,
        runDeterministicProjection,
        getNormalizedOutcomeWeights,
        formatCurrency,
        onSolveStart,
        onSolveIteration,
        onAdvancedPolicyProgress,
        onAdvancedYearProgress,
        onMonteCarloStart,
        onMonteCarloProgress,
        shouldCancel
    } = params;

    let {
        age,
        rrsp,
        tfsa,
        nonreg,
        currentAcb,
        baseSpending,
        spendingSchedule,
        spendingMode,
        targetSuccessRate,
        solvePrecision,
        lifeExpectancy,
        inflation,
        growth,
        provCode,
        cppScenarioAge,
        selectedCPPMonthly,
        oasPercent,
        rrifStartAge,
        enforceRrifMin,
        strategy,
        selectedStrategyMode,
        enableMonteCarlo,
        mcTrials,
        mcVolatility,
        mcInflationVolatility,
        mcSeed
    } = inputs;

    let solvedSpendOutput = null;
    let shouldPromptEnableMcForSolve = false;

    if (spendingMode === "solve") {
        if (!enableMonteCarlo) {
            shouldPromptEnableMcForSolve = true;
        } else if (runMonteCarloNow) {
            if (typeof onSolveStart === "function") onSolveStart();
            const solved = await solveSustainableSpending({
                targetSuccessRate,
                precision: solvePrecision,
                maxIterations: 18,
                baselineSpend: baseSpending,
                monteCarloParams: {
                    age,
                    rrspStart: rrsp,
                    tfsaStart: tfsa,
                    nonregStart: nonreg,
                    acbStart: currentAcb,
                    baseSpending,
                    spendingSchedule: [],
                    inflation,
                    growth,
                    provCode,
                    cppScenarioAge,
                    selectedCPPMonthly,
                    oasPercent,
                    rrifStartAge,
                    enforceRrifMin,
                    strategy,
                    projectionAge: lifeExpectancy,
                    trials: mcTrials,
                    volatility: mcVolatility,
                    inflationVolatility: mcInflationVolatility,
                    seed: mcSeed,
                    shouldCancel
                },
                runMonteCarlo,
                formatCurrency,
                onIteration: onSolveIteration,
                shouldCancel
            });
            if (solved !== null) {
                baseSpending = solved;
                solvedSpendOutput = solved;
            }
        }
    }

    const activeSchedule = spendingMode === "solve" ? [] : spendingSchedule;
    const effectiveStrategy = selectedStrategyMode;
    const showAdvancedProgress = selectedStrategyMode === "outcome-based" && runMonteCarloNow;

    const { results, constructedMixByAge } = await runDeterministicProjection({
        age,
        rrspStart: rrsp,
        tfsaStart: tfsa,
        nonregStart: nonreg,
        acbStart: currentAcb,
        baseSpending,
        activeSchedule,
        lifeExpectancy,
        inflation,
        growth,
        provCode,
        cppScenarioAge,
        selectedCPPMonthly,
        oasPercent,
        rrifStartAge,
        enforceRrifMin,
        effectiveStrategy,
        getNormalizedOutcomeWeights,
        showAdvancedProgress,
        onOutcomePolicyProgress: onAdvancedPolicyProgress,
        onAdvancedYearProgress
    });

    let monteCarloResults = null;
    let monteCarloStale = false;
    let monteCarloMeta = null;

    if (enableMonteCarlo && runMonteCarloNow) {
        if (typeof onMonteCarloStart === "function") onMonteCarloStart(mcTrials);
        monteCarloResults = await runMonteCarlo({
            age,
            rrspStart: rrsp,
            tfsaStart: tfsa,
            nonregStart: nonreg,
            acbStart: currentAcb,
            baseSpending,
            spendingSchedule: activeSchedule,
            inflation,
            growth,
            provCode,
            cppScenarioAge,
            selectedCPPMonthly,
            oasPercent,
            rrifStartAge,
            enforceRrifMin,
            strategy: effectiveStrategy,
            projectionAge: lifeExpectancy,
            trials: mcTrials,
            volatility: mcVolatility,
            inflationVolatility: mcInflationVolatility,
            seed: mcSeed,
            constructedMixByAge: effectiveStrategy === "outcome-based" ? constructedMixByAge : null,
            onProgress: onMonteCarloProgress,
            shouldCancel
        });
        monteCarloMeta = {
            trials: mcTrials,
            returnVolatility: mcVolatility,
            inflationVolatility: mcInflationVolatility,
            seed: Number.isFinite(mcSeed) ? mcSeed : null,
            runAtIso: new Date().toISOString(),
            cancelled: monteCarloResults.cancelled,
            completedTrials: monteCarloResults.trials,
            requestedTrials: monteCarloResults.requestedTrials
        };
    } else if (enableMonteCarlo && !runMonteCarloNow && lastMonteCarloResults) {
        monteCarloResults = lastMonteCarloResults;
        monteCarloStale = true;
    }

    return {
        results,
        monteCarloResults,
        monteCarloStale,
        monteCarloMeta,
        solvedSpendOutput,
        baseSpending,
        shouldPromptEnableMcForSolve,
        targetSuccessRate,
        spendingMode,
        selectedStrategyMode,
        effectiveStrategy,
        enableMonteCarlo,
        runMonteCarloNow,
        showAdvancedProgress
    };
}
