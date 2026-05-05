export function readScenarioInputs(doc, getValidatedSpendingSchedule) {
  // Keep all DOM parsing/clamping in one place so core modules stay UI-agnostic.
  const age = parseInt(doc.getElementById("age").value);
  const rrsp = parseFloat(doc.getElementById("rrsp").value);
  const tfsa = parseFloat(doc.getElementById("tfsa").value);
  const nonreg = parseFloat(doc.getElementById("nonreg").value);
  let currentAcb = parseFloat(doc.getElementById("nonregAcb").value);

  if (currentAcb > nonreg) currentAcb = nonreg;

  const baseSpending = parseFloat(doc.getElementById("spending").value);
  const spendingSchedule = getValidatedSpendingSchedule();
  const spendingMode = doc.getElementById("spendingMode").value;
  const targetSuccessRate = Math.max(
    0.5,
    Math.min(
      0.99,
      (parseFloat(doc.getElementById("targetSuccess").value) || 90) / 100,
    ),
  );
  const solvePrecision = Math.max(
    10,
    parseFloat(doc.getElementById("solvePrecision").value) || 100,
  );
  const lifeExpectancy = Math.max(
    age,
    Math.min(120, parseInt(doc.getElementById("lifeExpectancy").value) || 100),
  );
  const inflation = parseFloat(doc.getElementById("inflation").value) / 100;
  const growth = parseFloat(doc.getElementById("growth").value) / 100;
  const provCode = doc.getElementById("province").value;

  const cppScenarioAge = parseInt(doc.getElementById("cppScenario").value);
  const selectedCPPMonthly =
    cppScenarioAge === 60
      ? parseFloat(doc.getElementById("cpp60").value)
      : cppScenarioAge === 70
        ? parseFloat(doc.getElementById("cpp70").value)
        : parseFloat(doc.getElementById("cpp65").value);

  const oasPercent = parseFloat(doc.getElementById("oasPercent").value) / 100;
  const rrifStartAge = parseInt(doc.getElementById("rrifStartAge").value);
  const enforceRrifMin = doc.getElementById("enforceRrifMin").value === "yes";
  const strategy = doc.getElementById("strategy").value;
  const strategyMode = doc.getElementById("strategyMode").value;
  // Advanced mode always routes to outcome-based strategy construction.
  const selectedStrategyMode =
    strategyMode === "advanced" ? "outcome-based" : strategy;
  const enableMonteCarlo = doc.getElementById("enableMonteCarlo").checked;
  const mcTrials = Math.max(
    100,
    Math.min(10000, parseInt(doc.getElementById("mcTrials").value) || 1000),
  );
  const mcVolatility = Math.max(
    0,
    parseFloat(doc.getElementById("mcVolatility").value) / 100 || 0,
  );
  const mcInflationVolatility = Math.max(
    0,
    parseFloat(doc.getElementById("mcInflationVolatility").value) / 100 || 0,
  );
  const mcBadYearSpendCutPct = Math.max(
    0,
    Math.min(
      1,
      parseFloat(doc.getElementById("mcBadYearSpendCut").value) / 100 || 0,
    ),
  );
  const mcSeedRaw = doc.getElementById("mcSeed").value;
  const mcSeed = mcSeedRaw === "" ? NaN : parseInt(mcSeedRaw);

  return {
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
    mcBadYearSpendCutPct,
    mcSeed,
  };
}
