import {
  calculateTax,
  findGrossDraw,
  RRSP_ANNUAL_MAX_BASE,
  TFSA_ANNUAL_ROOM_BASE,
} from "./tax.js";
import {
  calculateSingleGisBenefit,
  getApproximateGisIncomeBase,
} from "./gis.js";
import { getRrifMinimumRate } from "./rrif.js";
import { createSeededRng, randomShock, percentile } from "./random.js";
import {
  adjustSpendingForReturn,
  getTargetSpendingForYear,
} from "./spendingPolicy.js";
import { getScheduleMultiplierForAge } from "./spending.js";
import {
  applyProportionalDraw,
  applySequenceDraw,
  applyRrspMeltdownDraw,
  getRrspMeltdownOptions,
  isRrspMeltdownStrategy,
} from "./withdrawalStrategy.js";

function getDepletionBucket(age) {
  if (age < 65) return "Before 65";
  if (age <= 69) return "65-69";
  if (age <= 74) return "70-74";
  if (age <= 79) return "75-79";
  if (age <= 84) return "80-84";
  if (age <= 89) return "85-89";
  if (age <= 94) return "90-94";
  if (age <= 99) return "95-99";
  return "100+";
}

export async function runMonteCarlo(params) {
  const {
    age,
    retirementAge,
    rrspStart,
    tfsaStart,
    nonregStart,
    acbStart,
    baseSpending,
    spendingSchedule,
    inflation,
    growth,
    provCode,
    cppScenarioAge,
    selectedCPPMonthly,
    oasPercent,
    enableGIS = false,
    gisInitialPriorYearIncome = 0,
    rrifStartAge,
    enforceRrifMin,
    strategy,
    projectionAge,
    grossEmploymentIncome,
    trials,
    samplePathCount = 10,
    mcModel = "normal",
    volatility,
    inflationVolatility,
    seed,
    onProgress,
    shouldCancel,
    spendingMode = "input",
    amortizationRate = 0,
    targetEstateValue = 0,
    rollingMinSpend = 0,
    rollingMaxSpend = 0,
    desiredMinSpend = 0,
    desiredMaxSpend = 0,
    spendSensitivity = "medium",
    desiredSpendingBoundsError = null,
  } = params;

  // Seeded path is used for reproducible analysis/tests; otherwise use ambient randomness.
  const rng = Number.isFinite(seed) ? createSeededRng(seed) : Math.random;
  let successCount = 0;
  let totalTax = 0;
  let totalClawback = 0;
  const finalEstates = [];
  const depletionAges = [];
  const yearsCount = Math.max(1, projectionAge - age + 1);
  const ageLabels = Array.from({ length: yearsCount }, (_, i) => age + i);
  const assetsByYear = Array.from({ length: yearsCount }, () => []);
  const spendingByYear = Array.from({ length: yearsCount }, () => []);
  const retainedSamplePathCount = Math.max(
    0,
    Math.min(samplePathCount, trials),
  );
  const samplePathStride =
    retainedSamplePathCount > 0
      ? Math.max(1, Math.floor(trials / retainedSamplePathCount))
      : Infinity;
  const sampleAssetPaths = [];
  const sampleSpendPaths = [];
  const sampleInflationPaths = [];
  const successBucketLabel = `${projectionAge}+ (Success)`;
  const bucketLabels = [
    "Before 65",
    "65-69",
    "70-74",
    "75-79",
    "80-84",
    "85-89",
    "90-94",
    "95-99",
    successBucketLabel,
  ];
  const bucketCounts = Object.fromEntries(bucketLabels.map((b) => [b, 0]));
  let completedTrials = 0;
  let cancelled = false;

  // Process MC trials in chunks so the UI can update progress/cancel state between batches.
  const chunkSize = 25;
  for (let t = 0; t < trials; t++) {
    if (typeof shouldCancel === "function" && shouldCancel()) {
      cancelled = true;
      break;
    }
    let rrsp = rrspStart;
    let tfsa = tfsaStart;
    let nonreg = nonregStart;
    let currentAcb = Math.min(acbStart, nonregStart);
    let priorYearGisIncome = Math.max(0, gisInitialPriorYearIncome);
    let depleted = false;
    let finalAge = age;
    let thisTax = 0;
    let thisClawback = 0;
    let mcInflationFactor = 1;
    const yearlyAssets = new Array(yearsCount).fill(0);
    const yearlySpending = new Array(yearsCount).fill(0);
    const yearlyInflationFactors = new Array(yearsCount).fill(1);
    const hasAdaptiveDesiredSpending =
      spendingMode === "input" &&
      !desiredSpendingBoundsError &&
      desiredMinSpend <= baseSpending &&
      desiredMaxSpend >= baseSpending;

    for (let i = 0; age + i <= projectionAge; i++) {
      const currentAge = age + i;
      const sampledGrowthForSpending =
        growth + volatility * randomShock(rng, mcModel);
      // In MC runs, inflation is path-dependent (not a fixed deterministic curve).
      const inflationFactor = mcInflationFactor;
      yearlyInflationFactors[i] = inflationFactor;
      const startingTotalPortfolio = rrsp + tfsa + nonreg;
      const targetBaseSpending = getTargetSpendingForYear({
        spendingMode,
        currentAge,
        projectionAge,
        baseSpending,
        schedule: spendingSchedule,
        inflationFactor,
        totalPortfolio: startingTotalPortfolio,
        amortizationRate,
        targetEstateValue,
        rollingMinSpend,
        rollingMaxSpend,
      });
      const spendingMultiplier = getScheduleMultiplierForAge(
        currentAge,
        spendingSchedule,
      );
      const targetSpending = hasAdaptiveDesiredSpending
        ? adjustSpendingForReturn({
            targetSpend: targetBaseSpending,
            minSpend: desiredMinSpend * inflationFactor * spendingMultiplier,
            maxSpend: desiredMaxSpend * inflationFactor * spendingMultiplier,
            annualReturn: sampledGrowthForSpending,
            expectedReturn: growth,
            sensitivity: spendSensitivity,
          })
        : targetBaseSpending;
      yearlySpending[i] = targetSpending;

      let totalIncomeTaxThisYear = 0;
      let oasClawbackThisYear = 0;
      let mandatoryRrifDrawThisYear = 0;
      let grossCPP = 0,
        grossOAS = 0,
        grossGIS = 0;
      let employmentIncomeGross = 0;
      let netNeeded = 0;
      let eligiblePensionIncome = 0;

      const getTaxContext = (extraEligiblePensionIncome = 0) => ({
        age: currentAge,
        eligiblePensionIncome:
          eligiblePensionIncome + extraEligiblePensionIncome,
      });

      const isWorkingYear = currentAge < retirementAge;
      if (isWorkingYear) {
        employmentIncomeGross = grossEmploymentIncome * inflationFactor;
      }

      if (currentAge >= cppScenarioAge)
        grossCPP = selectedCPPMonthly * 12 * inflationFactor;
      if (currentAge >= 65) {
        const baseOASMonthly = currentAge >= 75 ? 817.36 : 743.05;
        grossOAS = baseOASMonthly * 12 * oasPercent * inflationFactor;
      }
      if (enableGIS) {
        grossGIS = calculateSingleGisBenefit({
          age: currentAge,
          grossOAS,
          priorYearIncome: priorYearGisIncome,
          inflFactor: inflationFactor,
        });
      }

      let currentTaxableIncome = grossCPP + grossOAS + employmentIncomeGross;
      const baseTax = calculateTax(
        currentTaxableIncome,
        provCode,
        inflationFactor,
        getTaxContext(),
      );
      totalIncomeTaxThisYear += baseTax;
      let netAvailableIncome = currentTaxableIncome - baseTax + grossGIS;

      if (enforceRrifMin && currentAge >= rrifStartAge && rrsp > 0) {
        const rrifMinRate = getRrifMinimumRate(currentAge);
        if (rrifMinRate > 0) {
          const mandatoryGross = Math.min(rrsp, rrsp * rrifMinRate);
          const mandatoryTax =
            calculateTax(
              currentTaxableIncome + mandatoryGross,
              provCode,
              inflationFactor,
              getTaxContext(currentAge >= 65 ? mandatoryGross : 0),
            ) -
            calculateTax(
              currentTaxableIncome,
              provCode,
              inflationFactor,
              getTaxContext(),
            );
          rrsp -= mandatoryGross;
          mandatoryRrifDrawThisYear += mandatoryGross;
          currentTaxableIncome += mandatoryGross;
          if (currentAge >= 65) eligiblePensionIncome += mandatoryGross;
          totalIncomeTaxThisYear += mandatoryTax;
          netAvailableIncome += mandatoryGross - mandatoryTax;
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

        const contribTFSA = Math.min(surplus, tfsaRoom);
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
            getTaxContext(),
          );
          const refund = Math.max(0, totalIncomeTaxThisYear - reducedTax);

          rrsp += rrspContribution;
          surplus = surplus - rrspContribution + refund;
          remainingRrspRoom -= rrspContribution;
          currentTaxableIncome = reducedTaxableIncome;
          totalIncomeTaxThisYear = reducedTax;

          if (refund <= 0.01) break;
        }

        const contribNonReg = Math.max(0, surplus);
        nonreg += contribNonReg;
        currentAcb += contribNonReg;
      }

      const executeDraw = (accountType, targetNet) => {
        if (targetNet <= 0 || netNeeded <= 0) return;
        const amountToDraw = Math.min(targetNet, netNeeded);

        if (accountType === "tfsa" && tfsa > 0) {
          const d = Math.min(tfsa, amountToDraw);
          tfsa -= d;
          netNeeded -= d;
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
            getTaxContext(),
          );
          nonreg -= res.gross;
          netNeeded -= res.net;
          totalIncomeTaxThisYear += res.tax;
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
            getTaxContext(),
            currentAge >= 65 ? 1.0 : 0,
          );
          rrsp -= res.gross;
          netNeeded -= res.net;
          totalIncomeTaxThisYear += res.tax;
          currentTaxableIncome += res.taxableAdd;
          if (currentAge >= 65) eligiblePensionIncome += res.taxableAdd;
        }
      };

      // Estimate zero-tax room for a low-friction RRSP draw before strategy withdrawals.
      let low = 0,
        high = 50000 * inflationFactor;
      for (let j = 0; j < 20; j++) {
        const mid = (low + high) / 2;
        if (
          calculateTax(mid, provCode, inflationFactor, {
            age: currentAge,
            eligiblePensionIncome: currentAge >= 65 ? mid : 0,
          }) <= 0.01
        )
          low = mid;
        else high = mid;
      }

      const remainingZeroTaxRoom = Math.max(0, low - currentTaxableIncome);
      const rrspTaxFreeDraw = Math.min(rrsp, remainingZeroTaxRoom, netNeeded);
      if (rrspTaxFreeDraw > 0) {
        rrsp -= rrspTaxFreeDraw;
        netNeeded -= rrspTaxFreeDraw;
        currentTaxableIncome += rrspTaxFreeDraw;
        if (currentAge >= 65) eligiblePensionIncome += rrspTaxFreeDraw;
      }

      const executeByStrategy = () => {
        if (strategy === "proportional") {
          applyProportionalDraw({
            getBalances: () => ({ rrsp, tfsa, nonreg }),
            getNetNeeded: () => netNeeded,
            executeDraw,
          });
        } else if (isRrspMeltdownStrategy(strategy)) {
          const meltdownOptions = getRrspMeltdownOptions(strategy);
          applyRrspMeltdownDraw({
            getBalances: () => ({ rrsp, tfsa, nonreg }),
            getNetNeeded: () => netNeeded,
            getCurrentTaxableIncome: () => currentTaxableIncome,
            getGrossOAS: () => grossOAS,
            getMandatoryRrifDraw: () => mandatoryRrifDrawThisYear,
            executeDraw,
            provCode,
            inflationFactor,
            ...meltdownOptions,
            onTfsaTransfer: (transferAmount) => {
              tfsa += transferAmount;
              netNeeded += transferAmount;
              executeDraw("nonreg", transferAmount);
            },
          });
        } else {
          applySequenceDraw({
            strategy,
            targetNet: netNeeded,
            getNetNeeded: () => netNeeded,
            executeDraw,
          });
          if (netNeeded > 0.01) {
            applySequenceDraw({
              strategy,
              targetNet: netNeeded,
              getNetNeeded: () => netNeeded,
              executeDraw,
            });
          }
        }
      };

      executeByStrategy();

      if (grossOAS > 0) {
        // OAS clawback and withdrawals form a feedback loop: extra draw can increase taxable income
        // and therefore clawback, so iterate until the incremental clawback stabilizes.
        const oasThreshold = 90997 * inflationFactor;
        let prevClawback = 0;
        for (let k = 0; k < 10; k++) {
          let clawback = 0;
          if (currentTaxableIncome > oasThreshold)
            clawback = (currentTaxableIncome - oasThreshold) * 0.15;
          clawback = Math.min(clawback, grossOAS);
          const deltaClawback = clawback - prevClawback;
          if (deltaClawback <= 0.01) {
            oasClawbackThisYear = clawback;
            break;
          }
          netNeeded = deltaClawback;
          executeByStrategy();
          oasClawbackThisYear = clawback;
          if (netNeeded > 0.01) break;
          prevClawback = clawback;
        }
      }

      thisTax += totalIncomeTaxThisYear;
      thisClawback += oasClawbackThisYear;
      priorYearGisIncome = getApproximateGisIncomeBase({
        taxableIncome: currentTaxableIncome,
        grossOAS,
      });
      yearlyAssets[i] = rrsp + tfsa + nonreg;

      finalAge = currentAge;
      if (netNeeded > 1) {
        depleted = true;
        break;
      }

      // Shock returns/inflation independently each year for this path.
      const yearlyGrowth = Math.max(-0.95, sampledGrowthForSpending);
      const sampledInflation =
        inflation + inflationVolatility * randomShock(rng, mcModel);
      const yearlyInflation = Math.max(-0.03, Math.min(0.2, sampledInflation));
      rrsp *= 1 + yearlyGrowth;
      tfsa *= 1 + yearlyGrowth;
      nonreg *= 1 + yearlyGrowth;
      mcInflationFactor *= 1 + yearlyInflation;
    }

    if (!depleted) {
      successCount++;
      bucketCounts[successBucketLabel]++;
    } else {
      depletionAges.push(finalAge);
      const b = getDepletionBucket(finalAge);
      if (bucketCounts[b] !== undefined) bucketCounts[b]++;
    }

    finalEstates.push(rrsp + tfsa + nonreg);
    totalTax += thisTax;
    totalClawback += thisClawback;
    if (
      sampleAssetPaths.length < retainedSamplePathCount &&
      t % samplePathStride === 0
    ) {
      sampleAssetPaths.push([...yearlyAssets]);
      sampleSpendPaths.push([...yearlySpending]);
      sampleInflationPaths.push([...yearlyInflationFactors]);
    }
    for (let i = 0; i < yearsCount; i++) assetsByYear[i].push(yearlyAssets[i]);
    for (let i = 0; i < yearsCount; i++)
      spendingByYear[i].push(yearlySpending[i]);
    completedTrials++;

    if ((t + 1) % chunkSize === 0 || t === trials - 1) {
      if (typeof onProgress === "function") {
        const partialP10 = assetsByYear.map((v) => percentile(v, 10));
        const partialP25 = assetsByYear.map((v) => percentile(v, 25));
        const partialP50 = assetsByYear.map((v) => percentile(v, 50));
        const partialP75 = assetsByYear.map((v) => percentile(v, 75));
        const partialP90 = assetsByYear.map((v) => percentile(v, 90));
        const partialSpendP10 = spendingByYear.map((v) => percentile(v, 10));
        const partialSpendP25 = spendingByYear.map((v) => percentile(v, 25));
        const partialSpendP50 = spendingByYear.map((v) => percentile(v, 50));
        const partialSpendP75 = spendingByYear.map((v) => percentile(v, 75));
        const partialSpendP90 = spendingByYear.map((v) => percentile(v, 90));
        onProgress(
          completedTrials,
          trials,
          bucketLabels,
          { ...bucketCounts },
          ageLabels,
          partialP10,
          partialP25,
          partialP50,
          partialP75,
          partialP90,
          partialSpendP10,
          partialSpendP25,
          partialSpendP50,
          partialSpendP75,
          partialSpendP90,
          sampleAssetPaths,
          sampleSpendPaths,
          sampleInflationPaths,
        );
      }
      // Yield to the event loop to keep the page responsive during long runs.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  if (completedTrials === 0) {
    return {
      trials: 0,
      requestedTrials: trials,
      successRate: 0,
      avgTax: 0,
      avgClawback: 0,
      medianFinalEstate: 0,
      p10FinalEstate: 0,
      p90FinalEstate: 0,
      medianDepletionAge: null,
      cancelled,
      bucketLabels,
      bucketCounts,
      ageLabels,
      assetP10: [],
      assetP25: [],
      assetP50: [],
      assetP75: [],
      assetP90: [],
      spendP10: [],
      spendP25: [],
      spendP50: [],
      spendP75: [],
      spendP90: [],
      sampleAssetPaths: [],
      sampleSpendPaths: [],
      sampleInflationPaths: [],
    };
  }

  const assetP10 = assetsByYear.map((v) => percentile(v, 10));
  const assetP25 = assetsByYear.map((v) => percentile(v, 25));
  const assetP50 = assetsByYear.map((v) => percentile(v, 50));
  const assetP75 = assetsByYear.map((v) => percentile(v, 75));
  const assetP90 = assetsByYear.map((v) => percentile(v, 90));
  const spendP10 = spendingByYear.map((v) => percentile(v, 10));
  const spendP25 = spendingByYear.map((v) => percentile(v, 25));
  const spendP50 = spendingByYear.map((v) => percentile(v, 50));
  const spendP75 = spendingByYear.map((v) => percentile(v, 75));
  const spendP90 = spendingByYear.map((v) => percentile(v, 90));

  return {
    trials: completedTrials,
    requestedTrials: trials,
    successRate: successCount / completedTrials,
    avgTax: totalTax / completedTrials,
    avgClawback: totalClawback / completedTrials,
    medianFinalEstate: percentile(finalEstates, 50),
    p10FinalEstate: percentile(finalEstates, 10),
    p90FinalEstate: percentile(finalEstates, 90),
    medianDepletionAge: depletionAges.length
      ? percentile(depletionAges, 50)
      : null,
    cancelled,
    bucketLabels,
    bucketCounts,
    ageLabels,
    assetP10,
    assetP25,
    assetP50,
    assetP75,
    assetP90,
    spendP10,
    spendP25,
    spendP50,
    spendP75,
    spendP90,
    sampleAssetPaths,
    sampleSpendPaths,
    sampleInflationPaths,
  };
}
