import { calculateTax, findGrossDraw } from "./tax.js";
import { getRrifMinimumRate } from "./rrif.js";
import { getBaseSpendingForAge } from "./spending.js";
import {
  applyProportionalDraw,
  applyWeightedMixDraw,
  applySequenceDraw,
} from "./withdrawalStrategy.js";
import { chooseOutcomeMix } from "./outcomeStrategy.js";

export async function runDeterministicProjection(params) {
  const {
    age,
    rrspStart,
    tfsaStart,
    nonregStart,
    acbStart,
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
    onOutcomePolicyProgress,
    onAdvancedYearProgress,
  } = params;

  let rrsp = rrspStart;
  let tfsa = tfsaStart;
  let nonreg = nonregStart;
  let currentAcb = Math.min(acbStart, nonregStart);

  const results = [];
  let isDepleted = false;
  const constructedMixByAge = {};

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
    let netNeeded = 0;

    if (currentAge >= cppScenarioAge)
      grossCPP = selectedCPPMonthly * 12 * inflationFactor;
    if (currentAge >= 65) {
      const baseOASMonthly = currentAge >= 75 ? 817.36 : 743.05;
      grossOAS = baseOASMonthly * 12 * oasPercent * inflationFactor;
    }

    let currentTaxableIncome = grossCPP + grossOAS;
    const baseTax = calculateTax(
      currentTaxableIncome,
      provCode,
      inflationFactor,
    );
    totalIncomeTaxThisYear += baseTax;
    let netGovIncome = currentTaxableIncome - baseTax;

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
        netGovIncome += mandatoryNet;
      }
    }

    netNeeded = Math.max(0, targetSpending - netGovIncome);

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
      } else if (effectiveStrategy === "outcome-based") {
        const weights = getNormalizedOutcomeWeights();
        if (typeof onOutcomePolicyProgress === "function" && i % 3 === 0) {
          onOutcomePolicyProgress(currentAge);
        }
        const normalizedMix = chooseOutcomeMix({
          currentAge,
          startAge: age,
          lifeExpectancy,
          inflation,
          growth,
          provCode,
          cppScenarioAge,
          selectedCPPMonthly,
          oasPercent,
          rrifStartAge,
          enforceRrifMin,
          baseSpending,
          activeSchedule,
          weights,
          probeNeed: netNeeded,
          currentState: {
            rrsp,
            tfsa,
            nonreg,
            acb: currentAcb,
            taxableIncome: currentTaxableIncome,
          },
        });
        constructedMixByAge[currentAge] = normalizedMix;

        applyWeightedMixDraw({
          getBalances: () => ({ rrsp, tfsa, nonreg }),
          getNetNeeded: () => netNeeded,
          executeDraw,
          mix: normalizedMix,
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
      effectiveStrategy !== "outcome-based" &&
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
    const selectedMix = constructedMixByAge[currentAge] || null;

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
      mixTFSA: selectedMix ? selectedMix.tfsa : null,
      mixNonReg: selectedMix ? selectedMix.nonreg : null,
      mixRRSP: selectedMix ? selectedMix.rrsp : null,
      depleted: isDepleted,
    });

    if (showAdvancedProgress && typeof onAdvancedYearProgress === "function") {
      await onAdvancedYearProgress(i, currentAge, lifeExpectancy, age);
    }

    if (isDepleted) break;

    rrsp *= 1 + growth;
    tfsa *= 1 + growth;
    nonreg *= 1 + growth;
  }

  return { results, constructedMixByAge, effectiveStrategy };
}
