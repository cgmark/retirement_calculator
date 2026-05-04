import { calculateTax, findGrossDraw } from "./tax.js";
import { getRrifMinimumRate } from "./rrif.js";
import { getBaseSpendingForAge } from "./spending.js";

export function chooseOutcomeMix(params) {
    const {
        currentAge,
        startAge,
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
        currentState
    } = params;

    // Probe need smooths scoring so near-zero years do not produce noisy/degenerate mixes.
    const probeNeed = Math.max(250, params.probeNeed ?? 0);
    const available = ["tfsa", "nonreg", "rrsp"].filter((acc) => (acc === "tfsa" ? currentState.tfsa : acc === "nonreg" ? currentState.nonreg : currentState.rrsp) > 0);
    let bestMix = { tfsa: 1 / 3, nonreg: 1 / 3, rrsp: 1 / 3 };
    let bestScore = -Infinity;

    const objectiveWeights = [weights.wTax, weights.wOas, weights.wEstate, weights.wSuccess];
    const maxObjectiveWeight = Math.max(...objectiveWeights);
    const dominantSingleObjective = maxObjectiveWeight >= 0.95;

    // Score one candidate mix by simulating from current year through horizon.
    const horizonScoreForMix = (mix) => {
        let sRrsp = currentState.rrsp;
        let sTfsa = currentState.tfsa;
        let sNon = currentState.nonreg;
        let sAcb = currentState.acb;
        let sTaxable = currentState.taxableIncome;
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
            if (needNet > 0.01) ["tfsa", "nonreg", "rrsp"].forEach((acc) => drawSim(acc, needNet));

            const yearOasThreshold = 90997 * yearInflationFactor;
            let claw = 0;
            if (ageAtYear >= 65 && sTaxable > yearOasThreshold) {
                claw = Math.max(0, (sTaxable - yearOasThreshold) * 0.15);
            }
            totalTax += yearTax;
            totalClaw += claw;
            totalShortfall += Math.max(0, needNet);
        };

        const yearOffset = currentAge - startAge;
        for (let y = yearOffset; startAge + y <= lifeExpectancy; y++) {
            const ageY = startAge + y;
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

    // Coarse grid first; optional local refinement happens later around best mix.
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
                if (available.length > 0 && available.every((acc) => mix[acc] < 0.001)) continue;
                candidates.push({ mix });
            }
        }
        return candidates;
    };

    let candidates;
    if (dominantSingleObjective) {
        // Fast path: anchors are enough when one objective weight dominates.
        candidates = [
            { mix: { tfsa: 1, nonreg: 0, rrsp: 0 } },
            { mix: { tfsa: 0, nonreg: 1, rrsp: 0 } },
            { mix: { tfsa: 0, nonreg: 0, rrsp: 1 } },
            { mix: { tfsa: 0.5, nonreg: 0.5, rrsp: 0 } },
            { mix: { tfsa: 0.5, nonreg: 0, rrsp: 0.5 } },
            { mix: { tfsa: 0, nonreg: 0.5, rrsp: 0.5 } },
            { mix: { tfsa: 1 / 3, nonreg: 1 / 3, rrsp: 1 / 3 } }
        ].filter((c) => available.length === 0 || !available.every((acc) => c.mix[acc] < 0.001));
    } else {
        candidates = evaluateCandidates(0.25);
    }

    const scoreCandidates = (cands) => {
        const horizon = cands.map((c) => ({ ...c, h: horizonScoreForMix(c.mix) }));
        const minTax = Math.min(...horizon.map((c) => c.h.totalTax));
        const maxTax = Math.max(...horizon.map((c) => c.h.totalTax));
        const minOas = Math.min(...horizon.map((c) => c.h.totalClaw));
        const maxOas = Math.max(...horizon.map((c) => c.h.totalClaw));
        const minEstate = Math.min(...horizon.map((c) => c.h.finalEstate));
        const maxEstate = Math.max(...horizon.map((c) => c.h.finalEstate));
        const minShort = Math.min(...horizon.map((c) => c.h.totalShortfall));
        const maxShort = Math.max(...horizon.map((c) => c.h.totalShortfall));
        const norm = (v, lo, hi) => hi > lo ? (v - lo) / (hi - lo) : 0;

        horizon.forEach((c) => {
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
    return normDen > 0
        ? {
            tfsa: bestMix.tfsa / normDen,
            nonreg: bestMix.nonreg / normDen,
            rrsp: bestMix.rrsp / normDen
        }
        : { tfsa: 1 / 3, nonreg: 1 / 3, rrsp: 1 / 3 };
}
