export async function runRetirementCalculation(params) {
  const {
    inputs,
    runMonteCarloNow,
    lastMonteCarloResults,
    runMonteCarlo,
    solveSustainableSpending,
    runDeterministicProjection,
    formatCurrency,
    onSolveStart,
    onSolveIteration,
    onMonteCarloStart,
    onMonteCarloProgress,
    shouldCancel,
  } = params;

  let {
    age,
    retirementAge,
    rrsp,
    tfsa,
    nonreg,
    currentAcb,
    baseSpending,
    spendingSchedule,
    spendingMode,
    amortizationRate,
    targetEstateValue,
    rollingMinSpend,
    rollingMaxSpend,
    targetSuccessRate,
    solvePrecision,
    lifeExpectancy,
    grossEmploymentIncome,
    inflation,
    growth,
    provCode,
    cppScenarioAge,
    selectedCPPMonthly,
    oasPercent,
    rrifStartAge,
    enforceRrifMin,
    strategy,
    enableMonteCarlo,
    mcTrials,
    mcVolatility,
    mcInflationVolatility,
    mcBadYearSpendCutPct,
    mcSeed,
  } = inputs;

  let solvedSpendOutput = null;
  let shouldPromptEnableMcForSolve = false;
  let solveFailed = false;

  // Optional pre-pass: solve for a flat spend that meets target MC success rate.
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
          retirementAge,
          rrspStart: rrsp,
          tfsaStart: tfsa,
          nonregStart: nonreg,
          acbStart: currentAcb,
          baseSpending,
          spendingSchedule: [],
          spendingMode,
          amortizationRate,
          targetEstateValue,
          rollingMinSpend,
          rollingMaxSpend,
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
          grossEmploymentIncome,
          trials: mcTrials,
          volatility: mcVolatility,
          inflationVolatility: mcInflationVolatility,
          badYearSpendCutPct: mcBadYearSpendCutPct,
          seed: mcSeed,
          shouldCancel,
        },
        runMonteCarlo,
        formatCurrency,
        onIteration: onSolveIteration,
        shouldCancel,
      });
      if (Number.isNaN(solved)) {
        solveFailed = true;
      } else if (solved !== null) {
        baseSpending = solved;
        solvedSpendOutput = solved;
      }
    }
  }

  const activeSchedule = spendingMode === "solve" ? [] : spendingSchedule;
  const effectiveStrategy = strategy;

  // Deterministic baseline path is always computed (also used for charts/tables).
  const { results } = await runDeterministicProjection({
    age,
    retirementAge,
    rrspStart: rrsp,
    tfsaStart: tfsa,
    nonregStart: nonreg,
    acbStart: currentAcb,
    baseSpending,
    activeSchedule,
    lifeExpectancy,
    grossEmploymentIncome,
    inflation,
    growth,
    spendingMode,
    amortizationRate,
    targetEstateValue,
    rollingMinSpend,
    rollingMaxSpend,
    provCode,
    cppScenarioAge,
    selectedCPPMonthly,
    oasPercent,
    rrifStartAge,
    enforceRrifMin,
    effectiveStrategy,
  });

  let monteCarloResults = null;
  let monteCarloStale = false;
  let monteCarloMeta = null;

  if (enableMonteCarlo && runMonteCarloNow) {
    // Full MC run uses the deterministic pass policy/mix as its strategy input.
    if (typeof onMonteCarloStart === "function") onMonteCarloStart(mcTrials);
    monteCarloResults = await runMonteCarlo({
      age,
      retirementAge,
      rrspStart: rrsp,
      tfsaStart: tfsa,
      nonregStart: nonreg,
      acbStart: currentAcb,
      baseSpending,
      spendingSchedule: activeSchedule,
      spendingMode,
      amortizationRate,
      targetEstateValue,
      rollingMinSpend,
      rollingMaxSpend,
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
      grossEmploymentIncome,
      trials: mcTrials,
      volatility: mcVolatility,
      inflationVolatility: mcInflationVolatility,
      badYearSpendCutPct: mcBadYearSpendCutPct,
      seed: mcSeed,
      onProgress: onMonteCarloProgress,
      shouldCancel,
    });
    monteCarloMeta = {
      trials: mcTrials,
      returnVolatility: mcVolatility,
      inflationVolatility: mcInflationVolatility,
      badYearSpendCutPct: mcBadYearSpendCutPct,
      seed: Number.isFinite(mcSeed) ? mcSeed : null,
      runAtIso: new Date().toISOString(),
      cancelled: monteCarloResults.cancelled,
      completedTrials: monteCarloResults.trials,
      requestedTrials: monteCarloResults.requestedTrials,
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
    solveFailed,
    currentYearSpending: results[0]?.spending ?? baseSpending,
    baseSpending,
    shouldPromptEnableMcForSolve,
    targetSuccessRate,
    spendingMode,
    effectiveStrategy,
    enableMonteCarlo,
    runMonteCarloNow,
  };
}
