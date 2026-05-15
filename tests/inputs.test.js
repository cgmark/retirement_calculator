import { describe, expect, it } from "vitest";
import { readScenarioInputs } from "../src/core/inputs.js";

function buildDoc(overrides = {}) {
  const values = {
    age: "",
    retirementAge: "",
    rrsp: "",
    tfsa: "",
    nonreg: "",
    nonregAcb: "",
    spending: "",
    spendingMode: "input",
    amortizationRate: "",
    targetEstateValue: "",
    rollingMinSpend: "",
    rollingMaxSpend: "",
    targetSuccess: "",
    solvePrecision: "",
    lifeExpectancy: "",
    grossEmploymentIncome: "",
    inflation: "",
    growth: "",
    province: "ON",
    cppScenario: "65",
    cpp60: "",
    cpp65: "",
    cpp70: "",
    oasPercent: "",
    rrifStartAge: "",
    enforceRrifMin: "yes",
    strategy: "tfsa-rrsp-nonreg",
    enableMonteCarlo: false,
    mcModel: "normal",
    mcTrials: "",
    mcVolatility: "",
    mcInflationVolatility: "",
    mcBadYearSpendCut: "",
    mcSeed: "",
    ...overrides,
  };

  return {
    getElementById(id) {
      return {
        value: values[id],
        checked: values[id] === true,
      };
    },
  };
}

describe("readScenarioInputs", () => {
  it("falls back to defaults for blank numeric inputs", () => {
    const inputs = readScenarioInputs(buildDoc(), () => []);

    expect(inputs.age).toBe(60);
    expect(inputs.retirementAge).toBe(60);
    expect(inputs.rrsp).toBe(0);
    expect(inputs.tfsa).toBe(0);
    expect(inputs.nonreg).toBe(0);
    expect(inputs.currentAcb).toBe(0);
    expect(inputs.baseSpending).toBe(60000);
    expect(inputs.amortizationRate).toBe(0.03);
    expect(inputs.targetEstateValue).toBe(0);
    expect(inputs.rollingMinSpend).toBe(0);
    expect(inputs.rollingMaxSpend).toBe(0);
    expect(inputs.lifeExpectancy).toBe(100);
    expect(inputs.inflation).toBe(0.025);
    expect(inputs.growth).toBe(0.055);
    expect(inputs.mcTrials).toBe(1000);
    expect(inputs.mcModel).toBe("normal");
  });

  it("reads the selected Monte Carlo model", () => {
    const inputs = readScenarioInputs(
      buildDoc({ mcModel: "fat-tail" }),
      () => [],
    );

    expect(inputs.mcModel).toBe("fat-tail");
  });

  it("clamps ACB down to non-registered balance", () => {
    const inputs = readScenarioInputs(
      buildDoc({ nonreg: "1000", nonregAcb: "5000" }),
      () => [],
    );

    expect(inputs.currentAcb).toBe(1000);
  });

  it("reads a custom amortization rate", () => {
    const inputs = readScenarioInputs(
      buildDoc({ amortizationRate: "4.2" }),
      () => [],
    );

    expect(inputs.amortizationRate).toBe(0.042);
  });

  it("reads a custom target estate value", () => {
    const inputs = readScenarioInputs(
      buildDoc({ targetEstateValue: "250000" }),
      () => [],
    );

    expect(inputs.targetEstateValue).toBe(250000);
  });

  it("reads and clamps rolling min/max spend bounds", () => {
    const inputs = readScenarioInputs(
      buildDoc({ rollingMinSpend: "55000", rollingMaxSpend: "40000" }),
      () => [],
    );

    expect(inputs.rollingMinSpend).toBe(55000);
    expect(inputs.rollingMaxSpend).toBe(55000);
  });
});
