import { calculateTax, findGrossDraw } from "./tax.js";
import { getRrifMinimumRate } from "./rrif.js";
import { getBaseSpendingForAge } from "./spending.js";
import { applyProportionalDraw, applyWeightedMixDraw, applySequenceDraw } from "./withdrawalStrategy.js";

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
        onAdvancedYearProgress
    } = params;

    let rrsp = rrspStart;
    let tfsa = tfsaStart;
    let nonreg = nonregStart;
    let currentAcb = Math.min(acbStart, nonregStart);

    const results = [];
    let isDepleted = false;
    const constructedMixByAge = {};

    for (let i = 0; age + i <= lifeExpectancy; i++) {
        const currentAge = age + i;
        const inflationFactor = Math.pow(1 + inflation, i);
        const ageBaseSpending = getBaseSpendingForAge(currentAge, baseSpending, activeSchedule);
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

        if (currentAge >= cppScenarioAge) grossCPP = (selectedCPPMonthly * 12) * inflationFactor;
        if (currentAge >= 65) {
            const baseOASMonthly = currentAge >= 75 ? 817.36 : 743.05;
            grossOAS = (baseOASMonthly * 12) * oasPercent * inflationFactor;
        }

        let currentTaxableIncome = grossCPP + grossOAS;
        const baseTax = calculateTax(currentTaxableIncome, provCode, inflationFactor);
        totalIncomeTaxThisYear += baseTax;
        let netGovIncome = currentTaxableIncome - baseTax;

        if (enforceRrifMin && currentAge >= rrifStartAge && rrsp > 0) {
            const rrifMinRate = getRrifMinimumRate(currentAge);
            if (rrifMinRate > 0) {
                const mandatoryGross = Math.min(rrsp, rrsp * rrifMinRate);
                const mandatoryTax = calculateTax(currentTaxableIncome + mandatoryGross, provCode, inflationFactor) - calculateTax(currentTaxableIncome, provCode, inflationFactor);
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

        const executeDraw = (accountType, targetNet) => {
            if (targetNet <= 0 || netNeeded <= 0) return;
            const amountToDraw = Math.min(targetNet, netNeeded);

            if (accountType === "tfsa" && tfsa > 0) {
                const tfsaNetDraw = Math.min(tfsa, amountToDraw);
                tfsa -= tfsaNetDraw;
                netNeeded -= tfsaNetDraw;
                drawTFSA += tfsaNetDraw;
            } else if (accountType === "nonreg" && nonreg > 0) {
                const acbRatio = nonreg > 0.01 ? Math.min(currentAcb / nonreg, 1.0) : 1.0;
                const inclusionRate = (1 - acbRatio) * 0.50;
                const res = findGrossDraw(amountToDraw, nonreg, currentTaxableIncome, inclusionRate, provCode, inflationFactor);
                nonreg -= res.gross;
                netNeeded -= res.net;
                totalIncomeTaxThisYear += res.tax;
                drawNonReg += res.gross;
                currentTaxableIncome += res.taxableAdd;

                currentAcb -= (res.gross * acbRatio);
                if (currentAcb < 0) currentAcb = 0;
            } else if (accountType === "rrsp" && rrsp > 0) {
                const res = findGrossDraw(amountToDraw, rrsp, currentTaxableIncome, 1.0, provCode, inflationFactor);
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
            if (calculateTax(mid, provCode, inflationFactor) <= 0.01) low = mid; else high = mid;
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
                    executeDraw
                });
            } else if (effectiveStrategy === "outcome-based") {
                const weights = getNormalizedOutcomeWeights();
                const probeNeed = Math.max(250, netNeeded);
                const available = ["tfsa", "nonreg", "rrsp"].filter(acc => (acc === "tfsa" ? tfsa : acc === "nonreg" ? nonreg : rrsp) > 0);
                let bestMix = { tfsa: 1 / 3, nonreg: 1 / 3, rrsp: 1 / 3 };
                let bestScore = -Infinity;

                const objectiveWeights = [weights.wTax, weights.wOas, weights.wEstate, weights.wSuccess];
                const maxObjectiveWeight = Math.max(...objectiveWeights);
                const dominantSingleObjective = maxObjectiveWeight >= 0.95;

                if (typeof onOutcomePolicyProgress === "function" && (i % 3 === 0)) {
                    onOutcomePolicyProgress(currentAge);
                }

                const horizonScoreForMix = (mix) => {
                    let sRrsp = rrsp;
                    let sTfsa = tfsa;
                    let sNon = nonreg;
                    let sAcb = currentAcb;
                    let sTaxable = currentTaxableIncome;
                    let totalTax = 0;
                    let totalClaw = 0;
                    let totalShortfall = 0;

                    const runYear = (ageAtYear, yearInflationFactor, needNet, forcedMix) => {
                        let yearTax = 0;
                        const drawSim = (acc, targetNetSim) => {
                            if (targetNetSim <= 0 || needNet <= 0) return;
                            const amt = Math.min(targetNetSim, needNet);
                            if (acc === "tfsa" && sTfsa > 0) {
                                const d = Math.min(sTfsa, amt);
                                sTfsa -= d;
                                needNet -= d;
                            } else if (acc === "nonreg" && sNon > 0) {
                                const acbRatio = sNon > 0.01 ? Math.min(sAcb / sNon, 1.0) : 1.0;
                                const inclusionRate = (1 - acbRatio) * 0.50;
                                const res = findGrossDraw(amt, sNon, sTaxable, inclusionRate, provCode, yearInflationFactor);
                                sNon -= res.gross;
                                needNet -= res.net;
                                yearTax += res.tax;
                                sTaxable += res.taxableAdd;
                                sAcb -= (res.gross * acbRatio);
                                if (sAcb < 0) sAcb = 0;
                            } else if (acc === "rrsp" && sRrsp > 0) {
                                const res = findGrossDraw(amt, sRrsp, sTaxable, 1.0, provCode, yearInflationFactor);
                                sRrsp -= res.gross;
                                needNet -= res.net;
                                yearTax += res.tax;
                                sTaxable += res.taxableAdd;
                            }
                        };

                        for (let k = 0; k < 20 && needNet > 0.01; k++) {
                            const active = {
                                tfsa: sTfsa > 0 ? forcedMix.tfsa : 0,
                                nonreg: sNon > 0 ? forcedMix.nonreg : 0,
                                rrsp: sRrsp > 0 ? forcedMix.rrsp : 0
                            };
                            const den = active.tfsa + active.nonreg + active.rrsp;
                            if (den <= 0) break;
                            drawSim("tfsa", needNet * (active.tfsa / den));
                            drawSim("nonreg", needNet * (active.nonreg / den));
                            drawSim("rrsp", needNet * (active.rrsp / den));
                        }
                        if (needNet > 0.01) ["tfsa", "nonreg", "rrsp"].forEach(acc => drawSim(acc, needNet));

                        const yearOasThreshold = 90997 * yearInflationFactor;
                        let claw = 0;
                        if (ageAtYear >= 65 && sTaxable > yearOasThreshold) {
                            claw = Math.max(0, (sTaxable - yearOasThreshold) * 0.15);
                        }
                        totalTax += yearTax;
                        totalClaw += claw;
                        totalShortfall += Math.max(0, needNet);
                    };

                    const yearOffset = currentAge - age;
                    for (let y = yearOffset; age + y <= lifeExpectancy; y++) {
                        const ageY = age + y;
                        const inflY = Math.pow(1 + inflation, y);
                        const targetY = getBaseSpendingForAge(ageY, baseSpending, activeSchedule) * inflY;

                        let grossCPPY = 0;
                        let grossOASY = 0;
                        if (ageY >= cppScenarioAge) grossCPPY = (selectedCPPMonthly * 12) * inflY;
                        if (ageY >= 65) {
                            const baseOASMonthly = ageY >= 75 ? 817.36 : 743.05;
                            grossOASY = (baseOASMonthly * 12) * oasPercent * inflY;
                        }

                        if (y === yearOffset) {
                            runYear(ageY, inflY, probeNeed, mix);
                        } else {
                            sTaxable = grossCPPY + grossOASY;
                            const baseTaxY = calculateTax(sTaxable, provCode, inflY);
                            totalTax += baseTaxY;
                            let netGovY = sTaxable - baseTaxY;

                            if (enforceRrifMin && ageY >= rrifStartAge && sRrsp > 0) {
                                const rrifMinRate = getRrifMinimumRate(ageY);
                                if (rrifMinRate > 0) {
                                    const mandatoryGross = Math.min(sRrsp, sRrsp * rrifMinRate);
                                    const mandatoryTax = calculateTax(sTaxable + mandatoryGross, provCode, inflY) - calculateTax(sTaxable, provCode, inflY);
                                    sRrsp -= mandatoryGross;
                                    sTaxable += mandatoryGross;
                                    totalTax += mandatoryTax;
                                    netGovY += (mandatoryGross - mandatoryTax);
                                }
                            }
                            const needY = Math.max(0, targetY - netGovY);
                            runYear(ageY, inflY, needY, mix);
                        }

                        if (ageY < lifeExpectancy) {
                            sRrsp *= (1 + growth);
                            sTfsa *= (1 + growth);
                            sNon *= (1 + growth);
                        }
                    }

                    const finalEstate = sRrsp + sTfsa + sNon;
                    return { totalTax, totalClaw, finalEstate, totalShortfall };
                };

                const evaluateCandidates = (step, centerMix = null, radius = 1) => {
                    const candidates = [];
                    const tfsaMin = centerMix ? Math.max(0, centerMix.tfsa - radius) : 0;
                    const tfsaMax = centerMix ? Math.min(1, centerMix.tfsa + radius) : 1;
                    for (let pTfsa = tfsaMin; pTfsa <= tfsaMax + 1e-9; pTfsa += step) {
                        const nonMin = centerMix ? Math.max(0, centerMix.nonreg - radius) : 0;
                        const nonMax = centerMix ? Math.min(1 - pTfsa, centerMix.nonreg + radius) : (1 - pTfsa);
                        for (let pNon = nonMin; pNon <= nonMax + 1e-9; pNon += step) {
                            const pRrsp = 1 - pTfsa - pNon;
                            if (pRrsp < -1e-9) continue;
                            const mix = { tfsa: Math.max(0, pTfsa), nonreg: Math.max(0, pNon), rrsp: Math.max(0, pRrsp) };
                            if (available.length > 0 && available.every(acc => mix[acc] < 0.001)) continue;
                            candidates.push({ mix });
                        }
                    }
                    return candidates;
                };

                let candidates;
                if (dominantSingleObjective) {
                    candidates = [
                        { mix: { tfsa: 1, nonreg: 0, rrsp: 0 } },
                        { mix: { tfsa: 0, nonreg: 1, rrsp: 0 } },
                        { mix: { tfsa: 0, nonreg: 0, rrsp: 1 } },
                        { mix: { tfsa: 0.5, nonreg: 0.5, rrsp: 0 } },
                        { mix: { tfsa: 0.5, nonreg: 0, rrsp: 0.5 } },
                        { mix: { tfsa: 0, nonreg: 0.5, rrsp: 0.5 } },
                        { mix: { tfsa: 1 / 3, nonreg: 1 / 3, rrsp: 1 / 3 } }
                    ].filter(c => available.length === 0 || !available.every(acc => c.mix[acc] < 0.001));
                } else {
                    candidates = evaluateCandidates(0.25);
                }

                const scoreCandidates = (cands) => {
                    const horizon = cands.map(c => ({ ...c, h: horizonScoreForMix(c.mix) }));
                    const minTax = Math.min(...horizon.map(c => c.h.totalTax));
                    const maxTax = Math.max(...horizon.map(c => c.h.totalTax));
                    const minOas = Math.min(...horizon.map(c => c.h.totalClaw));
                    const maxOas = Math.max(...horizon.map(c => c.h.totalClaw));
                    const minEstate = Math.min(...horizon.map(c => c.h.finalEstate));
                    const maxEstate = Math.max(...horizon.map(c => c.h.finalEstate));
                    const minShort = Math.min(...horizon.map(c => c.h.totalShortfall));
                    const maxShort = Math.max(...horizon.map(c => c.h.totalShortfall));
                    const norm = (v, lo, hi) => hi > lo ? (v - lo) / (hi - lo) : 0;

                    horizon.forEach(c => {
                        const taxScore = 1 - norm(c.h.totalTax, minTax, maxTax);
                        const oasScore = 1 - norm(c.h.totalClaw, minOas, maxOas);
                        const estateScore = norm(c.h.finalEstate, minEstate, maxEstate);
                        const successScore = 1 - norm(c.h.totalShortfall, minShort, maxShort);
                        const score =
                            (weights.wTax * taxScore) +
                            (weights.wOas * oasScore) +
                            (weights.wEstate * estateScore) +
                            (weights.wSuccess * successScore);
                        if (score > bestScore) {
                            bestScore = score;
                            bestMix = c.mix;
                        }
                    });
                };

                if (candidates.length) scoreCandidates(candidates);
                if (!dominantSingleObjective) {
                    const refined = evaluateCandidates(0.10, bestMix, 0.2);
                    if (refined.length) scoreCandidates(refined);
                }

                const normDen = bestMix.tfsa + bestMix.nonreg + bestMix.rrsp;
                const normalizedMix = normDen > 0
                    ? {
                        tfsa: bestMix.tfsa / normDen,
                        nonreg: bestMix.nonreg / normDen,
                        rrsp: bestMix.rrsp / normDen
                    }
                    : { tfsa: 1 / 3, nonreg: 1 / 3, rrsp: 1 / 3 };
                constructedMixByAge[currentAge] = normalizedMix;

                applyWeightedMixDraw({
                    getBalances: () => ({ rrsp, tfsa, nonreg }),
                    getNetNeeded: () => netNeeded,
                    executeDraw,
                    mix: normalizedMix
                });
            } else {
                applySequenceDraw({ strategy: effectiveStrategy, targetNet, getNetNeeded: () => netNeeded, executeDraw });
            }
        };

        executeByStrategy(netNeeded);

        if (effectiveStrategy !== "proportional" && effectiveStrategy !== "outcome-based" && netNeeded > 0.01) {
            applySequenceDraw({ strategy: effectiveStrategy, targetNet: netNeeded, getNetNeeded: () => netNeeded, executeDraw });
        }

        if (grossOAS > 0) {
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
            depleted: isDepleted
        });

        if (showAdvancedProgress && typeof onAdvancedYearProgress === "function") {
            await onAdvancedYearProgress(i, currentAge, lifeExpectancy, age);
        }

        if (isDepleted) break;

        rrsp *= (1 + growth);
        tfsa *= (1 + growth);
        nonreg *= (1 + growth);
    }

    return { results, constructedMixByAge, effectiveStrategy };
}
