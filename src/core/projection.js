import {
  calculateTax,
  findGrossDraw,
  RRSP_ANNUAL_MAX_BASE,
  TFSA_ANNUAL_ROOM_BASE,
} from "./tax.js";
import { getRrifMinimumRate } from "./rrif.js";
import { getBaseSpendingForAge } from "./spending.js";
import {
  applyProportionalDraw,
  applySequenceDraw,
  applyEarlyRetirementDraw,
} from "./withdrawalStrategy.js";

export async function runDeterministicProjection(params) {
  const {
    age,
    retirementAge,
    rrspStart,
    tfsaStart,
    nonregStart,
    acbStart,
    baseSpending,
    activeSchedule,
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
    effectiveStrategy,
  } = params;

  let rrsp = rrspStart;
  let tfsa = tfsaStart;
  let nonreg = nonregStart;
  let currentAcb = Math.min(acbStart, nonregStart);

  const results = [];
  let isDepleted = false;

  // Baseline projection is deterministic: fixed growth/inflation by year index.
  for (let i = 0; age + i <= lifeExpectancy; i++) {
    const currentAge = age + i;
    const inflationFactor = Math.pow(1 + inflation, i);
    const ageBaseSpending = getBaseSpendingForAge(
      currentAge,
      baseSpending,
      activeSchedule,
    );
    const targetSpending = ageBaseSpending * inflationFactor;

    let totalIncomeTaxThisYear = 0;
    let oasClawbackThisYear = 0;
    let mandatoryRrifDrawThisYear = 0;
    let debugClawbackIterations = 0;
    let debugFinalTaxableIncome = 0;

    let grossCPP = 0;
    let grossOAS = 0;
    let drawRRSP = 0;
    let drawTFSA = 0;
    let drawNonReg = 0;
    let contribRRSP = 0;
    let contribTFSA = 0;
    let contribNonReg = 0;
    let employmentIncomeGross = 0;
    let employmentIncomeNet = 0;
    let netNeeded = 0;

    if (currentAge >= cppScenarioAge)
      grossCPP = selectedCPPMonthly * 12 * inflationFactor;
    if (currentAge >= 65) {
      const baseOASMonthly = currentAge >= 75 ? 817.36 : 743.05;
      grossOAS = baseOASMonthly * 12 * oasPercent * inflationFactor;
    }

    const isWorkingYear = currentAge < retirementAge;
    if (isWorkingYear) {
      employmentIncomeGross = grossEmploymentIncome * inflationFactor;
    }

    let currentTaxableIncome = grossCPP + grossOAS + employmentIncomeGross;
    const baseTax = calculateTax(
      currentTaxableIncome,
      provCode,
      inflationFactor,
    );
    totalIncomeTaxThisYear += baseTax;
    let netAvailableIncome = currentTaxableIncome - baseTax;
    employmentIncomeNet = Math.max(
      0,
      netAvailableIncome - (grossCPP + grossOAS),
    );

    if (enforceRrifMin && currentAge >= rrifStartAge && rrsp > 0) {
      const rrifMinRate = getRrifMinimumRate(currentAge);
      if (rrifMinRate > 0) {
        const mandatoryGross = Math.min(rrsp, rrsp * rrifMinRate);
        const mandatoryTax =
          calculateTax(
            currentTaxableIncome + mandatoryGross,
            provCode,
            inflationFactor,
          ) - calculateTax(currentTaxableIncome, provCode, inflationFactor);
        const mandatoryNet = mandatoryGross - mandatoryTax;

        rrsp -= mandatoryGross;
        drawRRSP += mandatoryGross;
        mandatoryRrifDrawThisYear += mandatoryGross;
        currentTaxableIncome += mandatoryGross;
        totalIncomeTaxThisYear += mandatoryTax;
        netAvailableIncome += mandatoryNet;
      }
    }

    netNeeded = Math.max(0, targetSpending - netAvailableIncome);

    if (isWorkingYear && netNeeded <= 0) {
      let surplus = Math.max(0, netAvailableIncome - targetSpending);
      const tfsaRoom = TFSA_ANNUAL_ROOM_BASE * inflationFactor;
      const rrspRoom = Math.min(
        employmentIncomeGross * 0.18,
        RRSP_ANNUAL_MAX_BASE * inflationFactor,
      );

      contribTFSA = Math.min(surplus, tfsaRoom);
      tfsa += contribTFSA;
      surplus -= contribTFSA;

      let remainingRrspRoom = rrspRoom;
      while (surplus > 0.01 && remainingRrspRoom > 0.01) {
        const rrspContribution = Math.min(surplus, remainingRrspRoom);
        const reducedTaxableIncome = Math.max(
          0,
          currentTaxableIncome - rrspContribution,
        );
        const reducedTax = calculateTax(
          reducedTaxableIncome,
          provCode,
          inflationFactor,
        );
        const refund = Math.max(0, totalIncomeTaxThisYear - reducedTax);

        contribRRSP += rrspContribution;
        rrsp += rrspContribution;
        surplus = surplus - rrspContribution + refund;
        remainingRrspRoom -= rrspContribution;
        currentTaxableIncome = reducedTaxableIncome;
        totalIncomeTaxThisYear = reducedTax;

        if (refund <= 0.01) break;
      }

      employmentIncomeNet = Math.max(
        0,
        currentTaxableIncome - totalIncomeTaxThisYear - (grossCPP + grossOAS),
      );

      contribNonReg = Math.max(0, surplus);
      nonreg += contribNonReg;
      currentAcb += contribNonReg;
    }

    // Draw helper mutates account balances and tax state in-place for this year.
    const executeDraw = (accountType, targetNet) => {
      if (targetNet <= 0 || netNeeded <= 0) return;
      const amountToDraw = Math.min(targetNet, netNeeded);

      if (accountType === "tfsa" && tfsa > 0) {
        const tfsaNetDraw = Math.min(tfsa, amountToDraw);
        tfsa -= tfsaNetDraw;
        netNeeded -= tfsaNetDraw;
        drawTFSA += tfsaNetDraw;
      } else if (accountType === "nonreg" && nonreg > 0) {
        const acbRatio =
          nonreg > 0.01 ? Math.min(currentAcb / nonreg, 1.0) : 1.0;
        const inclusionRate = (1 - acbRatio) * 0.5;
        const res = findGrossDraw(
          amountToDraw,
          nonreg,
          currentTaxableIncome,
          inclusionRate,
          provCode,
          inflationFactor,
        );
        nonreg -= res.gross;
        netNeeded -= res.net;
        totalIncomeTaxThisYear += res.tax;
        drawNonReg += res.gross;
        currentTaxableIncome += res.taxableAdd;

        currentAcb -= res.gross * acbRatio;
        if (currentAcb < 0) currentAcb = 0;
      } else if (accountType === "rrsp" && rrsp > 0) {
        const res = findGrossDraw(
          amountToDraw,
          rrsp,
          currentTaxableIncome,
          1.0,
          provCode,
          inflationFactor,
        );
        rrsp -= res.gross;
        netNeeded -= res.net;
        totalIncomeTaxThisYear += res.tax;
        drawRRSP += res.gross;
        currentTaxableIncome += res.taxableAdd;
      }
    };

    let low = 0;
    let high = 50000 * inflationFactor;
    for (let j = 0; j < 20; j++) {
      const mid = (low + high) / 2;
      if (calculateTax(mid, provCode, inflationFactor) <= 0.01) low = mid;
      else high = mid;
    }

    const remainingZeroTaxRoom = Math.max(0, low - currentTaxableIncome);
    const rrspTaxFreeDraw = Math.min(rrsp, remainingZeroTaxRoom, netNeeded);

    if (rrspTaxFreeDraw > 0) {
      rrsp -= rrspTaxFreeDraw;
      netNeeded -= rrspTaxFreeDraw;
      drawRRSP += rrspTaxFreeDraw;
      currentTaxableIncome += rrspTaxFreeDraw;
    }

    const executeByStrategy = (targetNet) => {
      if (targetNet <= 0 || netNeeded <= 0) return;

      if (effectiveStrategy === "proportional") {
        applyProportionalDraw({
          getBalances: () => ({ rrsp, tfsa, nonreg }),
          getNetNeeded: () => netNeeded,
          executeDraw,
        });
      } else if (
        effectiveStrategy === "rrsp-meltdown" ||
        effectiveStrategy === "rrsp-meltdown-plus10" ||
        effectiveStrategy === "rrsp-meltdown-plus20" ||
        effectiveStrategy === "rrsp-meltdown-plus50" ||
        effectiveStrategy === "rrsp-meltdown-tfsa-transfer" ||
        effectiveStrategy === "rrsp-meltdown-tfsa-transfer-opportunistic-tfsa"
      ) {
        const overshootPct =
          effectiveStrategy === "rrsp-meltdown-plus50"
            ? 0.5
            : effectiveStrategy === "rrsp-meltdown-plus20"
              ? 0.2
              : effectiveStrategy === "rrsp-meltdown-plus10"
                ? 0.1
                : 0;
        applyEarlyRetirementDraw({
          getBalances: () => ({ rrsp, tfsa, nonreg }),
          getNetNeeded: () => netNeeded,
          getCurrentTaxableIncome: () => currentTaxableIncome,
          getGrossOAS: () => grossOAS,
          getMandatoryRrifDraw: () => mandatoryRrifDrawThisYear,
          executeDraw,
          provCode,
          inflationFactor,
          overshootPct,
          enableTfsaTransfer:
            effectiveStrategy === "rrsp-meltdown-tfsa-transfer" ||
            effectiveStrategy ===
              "rrsp-meltdown-tfsa-transfer-opportunistic-tfsa",
          opportunisticTfsa:
            effectiveStrategy ===
            "rrsp-meltdown-tfsa-transfer-opportunistic-tfsa",
          onTfsaTransfer: (transferAmount) => {
            tfsa += transferAmount;
            netNeeded += transferAmount;
            executeDraw("nonreg", transferAmount);
          },
        });
      } else {
        applySequenceDraw({
          strategy: effectiveStrategy,
          targetNet,
          getNetNeeded: () => netNeeded,
          executeDraw,
        });
      }
    };

    executeByStrategy(netNeeded);

    if (
      effectiveStrategy !== "proportional" &&
      effectiveStrategy !== "rrsp-meltdown" &&
      effectiveStrategy !== "rrsp-meltdown-plus10" &&
      effectiveStrategy !== "rrsp-meltdown-plus20" &&
      effectiveStrategy !== "rrsp-meltdown-plus50" &&
      effectiveStrategy !== "rrsp-meltdown-tfsa-transfer" &&
      effectiveStrategy !== "rrsp-meltdown-tfsa-transfer-opportunistic-tfsa" &&
      netNeeded > 0.01
    ) {
      applySequenceDraw({
        strategy: effectiveStrategy,
        targetNet: netNeeded,
        getNetNeeded: () => netNeeded,
        executeDraw,
      });
    }

    if (grossOAS > 0) {
      // Clawback can require extra withdrawals, which in turn can raise clawback.
      // Iterate until incremental clawback is negligible.
      const oasThreshold = 90997 * inflationFactor;
      let prevClawback = 0;

      for (let k = 0; k < 10; k++) {
        debugClawbackIterations = k + 1;
        let clawback = 0;
        if (currentTaxableIncome > oasThreshold) {
          clawback = (currentTaxableIncome - oasThreshold) * 0.15;
        }
        clawback = Math.min(clawback, grossOAS);

        const deltaClawback = clawback - prevClawback;
        if (deltaClawback <= 0.01) {
          oasClawbackThisYear = clawback;
          break;
        }

        netNeeded = deltaClawback;
        executeByStrategy(netNeeded);
        oasClawbackThisYear = clawback;

        if (netNeeded > 0.01) break;
        prevClawback = clawback;
      }
    }

    debugFinalTaxableIncome = currentTaxableIncome;
    const totalAssets = rrsp + tfsa + nonreg;
    if (netNeeded > 1) isDepleted = true;

    results.push({
      yearIndex: i,
      age: currentAge,
      spending: targetSpending,
      cpp: grossCPP,
      oas: grossOAS,
      drawRRSP,
      drawTFSA,
      drawNonReg,
      contribRRSP,
      contribTFSA,
      contribNonReg,
      employmentIncomeGross,
      employmentIncomeNet,
      rrsp,
      tfsa,
      nonreg,
      acb: currentAcb,
      total: totalAssets,
      incomeTax: totalIncomeTaxThisYear,
      oasClawback: oasClawbackThisYear,
      mandatoryRrifDraw: mandatoryRrifDrawThisYear,
      netShortfall: netNeeded,
      taxableIncome: debugFinalTaxableIncome,
      clawbackIterations: debugClawbackIterations,
      mixTFSA: null,
      mixNonReg: null,
      mixRRSP: null,
      depleted: isDepleted,
    });

    if (isDepleted) break;

    const yearlyGrowth = Math.max(-0.95, growth);
    rrsp *= 1 + yearlyGrowth;
    tfsa *= 1 + yearlyGrowth;
    nonreg *= 1 + yearlyGrowth;
  }

  return { results, effectiveStrategy };
}
