export const SCENARIO_INPUT_DEFAULTS = {
  age: 60,
  retirementAge: null,
  rrsp: 0,
  tfsa: 0,
  nonreg: 0,
  baseSpending: 60000,
  targetSuccessPct: 90,
  solvePrecision: 100,
  lifeExpectancy: 100,
  grossEmploymentIncome: 0,
  inflationPct: 2.5,
  growthPct: 5.5,
  amortizationRatePct: 3.0,
  targetEstateValue: 0,
  rollingMinSpend: 0,
  rollingMaxSpend: 0,
  cppScenarioAge: 65,
  cppMonthly: 0,
  oasPercent: 100,
  rrifStartAge: 72,
  mcTrials: 1000,
  mcSamplePaths: 10,
  mcModel: "normal",
  mcVolatilityPct: 0,
  mcInflationVolatilityPct: 0,
  mcBadYearSpendCutPct: 0,
};

export function readScenarioInputs(doc, getValidatedSpendingSchedule) {
  // Keep all DOM parsing/clamping in one place so core modules stay UI-agnostic.
  const readInt = (id, fallback) => {
    const value = parseInt(doc.getElementById(id).value);
    return Number.isFinite(value) ? value : fallback;
  };
  const readFloat = (id, fallback) => {
    const value = parseFloat(doc.getElementById(id).value);
    return Number.isFinite(value) ? value : fallback;
  };

  const age = readInt("age", SCENARIO_INPUT_DEFAULTS.age);
  const retirementAge = readInt("retirementAge", age);
  const rrsp = Math.max(0, readFloat("rrsp", SCENARIO_INPUT_DEFAULTS.rrsp));
  const tfsa = Math.max(0, readFloat("tfsa", SCENARIO_INPUT_DEFAULTS.tfsa));
  const nonreg = Math.max(
    0,
    readFloat("nonreg", SCENARIO_INPUT_DEFAULTS.nonreg),
  );
  let currentAcb = Math.max(0, readFloat("nonregAcb", nonreg));

  if (currentAcb > nonreg) currentAcb = nonreg;

  const baseSpending = Math.max(
    0,
    readFloat("spending", SCENARIO_INPUT_DEFAULTS.baseSpending),
  );
  const spendingSchedule = getValidatedSpendingSchedule();
  const spendingMode = doc.getElementById("spendingMode").value;
  const amortizationRate =
    readFloat("amortizationRate", SCENARIO_INPUT_DEFAULTS.amortizationRatePct) /
    100;
  const targetEstateValue = Math.max(
    0,
    readFloat("targetEstateValue", SCENARIO_INPUT_DEFAULTS.targetEstateValue),
  );
  const rollingMinSpend = Math.max(
    0,
    readFloat("rollingMinSpend", SCENARIO_INPUT_DEFAULTS.rollingMinSpend),
  );
  const rollingMaxSpendRaw = Math.max(
    0,
    readFloat("rollingMaxSpend", SCENARIO_INPUT_DEFAULTS.rollingMaxSpend),
  );
  const rollingMaxSpend =
    rollingMaxSpendRaw > 0
      ? Math.max(rollingMinSpend, rollingMaxSpendRaw)
      : rollingMaxSpendRaw;
  const targetSuccessRate = Math.max(
    0.5,
    Math.min(
      0.99,
      readFloat("targetSuccess", SCENARIO_INPUT_DEFAULTS.targetSuccessPct) /
        100,
    ),
  );
  const solvePrecision = Math.max(
    10,
    readFloat("solvePrecision", SCENARIO_INPUT_DEFAULTS.solvePrecision),
  );
  const lifeExpectancy = Math.max(
    age,
    Math.min(
      120,
      readInt("lifeExpectancy", SCENARIO_INPUT_DEFAULTS.lifeExpectancy),
    ),
  );
  const grossEmploymentIncome = Math.max(
    0,
    readFloat(
      "grossEmploymentIncome",
      SCENARIO_INPUT_DEFAULTS.grossEmploymentIncome,
    ),
  );
  const inflation =
    readFloat("inflation", SCENARIO_INPUT_DEFAULTS.inflationPct) / 100;
  const growth = readFloat("growth", SCENARIO_INPUT_DEFAULTS.growthPct) / 100;
  const provCode = doc.getElementById("province").value;

  const cppScenarioAge = readInt(
    "cppScenario",
    SCENARIO_INPUT_DEFAULTS.cppScenarioAge,
  );
  const selectedCPPMonthly =
    cppScenarioAge === 60
      ? readFloat("cpp60", SCENARIO_INPUT_DEFAULTS.cppMonthly)
      : cppScenarioAge === 70
        ? readFloat("cpp70", SCENARIO_INPUT_DEFAULTS.cppMonthly)
        : readFloat("cpp65", SCENARIO_INPUT_DEFAULTS.cppMonthly);

  const oasPercent =
    readFloat("oasPercent", SCENARIO_INPUT_DEFAULTS.oasPercent) / 100;
  const rrifStartAge = readInt(
    "rrifStartAge",
    SCENARIO_INPUT_DEFAULTS.rrifStartAge,
  );
  const enforceRrifMin = doc.getElementById("enforceRrifMin").value === "yes";
  const strategy = doc.getElementById("strategy").value;
  const enableMonteCarlo = doc.getElementById("enableMonteCarlo").checked;
  const mcModelRaw = doc.getElementById("mcModel")?.value;
  const mcModel = mcModelRaw === "fat-tail" ? "fat-tail" : "normal";
  const mcTrials = Math.max(
    100,
    Math.min(10000, readInt("mcTrials", SCENARIO_INPUT_DEFAULTS.mcTrials)),
  );
  const mcSamplePaths = Math.max(
    0,
    Math.min(
      50,
      readInt("mcSamplePaths", SCENARIO_INPUT_DEFAULTS.mcSamplePaths),
    ),
  );
  const mcVolatility = Math.max(
    0,
    readFloat("mcVolatility", SCENARIO_INPUT_DEFAULTS.mcVolatilityPct) / 100,
  );
  const mcInflationVolatility = Math.max(
    0,
    readFloat(
      "mcInflationVolatility",
      SCENARIO_INPUT_DEFAULTS.mcInflationVolatilityPct,
    ) / 100,
  );
  const mcBadYearSpendCutPct = Math.max(
    0,
    Math.min(
      1,
      readFloat(
        "mcBadYearSpendCut",
        SCENARIO_INPUT_DEFAULTS.mcBadYearSpendCutPct,
      ) / 100,
    ),
  );
  const mcSeedRaw = doc.getElementById("mcSeed").value;
  const mcSeed = mcSeedRaw === "" ? NaN : parseInt(mcSeedRaw);

  return {
    age,
    retirementAge: Math.max(
      age,
      Math.min(lifeExpectancy, retirementAge || age),
    ),
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
    mcModel,
    mcTrials,
    mcSamplePaths,
    mcVolatility,
    mcInflationVolatility,
    mcBadYearSpendCutPct,
    mcSeed,
  };
}
