import Chart from "chart.js/auto";
import { calculateTax, findGrossDraw } from "./core/tax.js";
import { getRrifMinimumRate } from "./core/rrif.js";
import { createSeededRng, randomNormal, percentile } from "./core/random.js";

document.addEventListener("DOMContentLoaded", () => {
    let balanceChartInst = null;
    let incomeChartInst = null;
    let mcOutcomeChartInst = null;
    let mcPercentileChartInst = null;
    let lastMonteCarloResults = null;
    let lastMonteCarloMeta = null;
    let mcCancelRequested = false;
    let mcIsRunning = false;
    let desiredSpendBeforeSolve = null;
    let lastSolvedSpend = null;
    let isRecalculating = false;
    let queuedRecalc = null;
    let recalcTimer = null;
    let suppressInputChangeRecalc = false;

    const inputIds =[
        'displayMode', 'debugMode', 'age', 'spending', 'spendingMode', 'targetSuccess', 'solvePrecision', 'lifeExpectancy', 'inflation', 'growth', 'province',
        'rrsp', 'tfsa', 'nonreg', 'nonregAcb', 'cpp60', 'cpp65', 'cpp70', 
        'cppScenario', 'oasPercent', 'rrifStartAge', 'enforceRrifMin', 'strategy', 'strategyMode',
        'enableMonteCarlo', 'mcTrials', 'mcVolatility', 'mcInflationVolatility', 'mcSeed',
        'wTax', 'wOas', 'wEstate', 'wSuccess', 'outcomePreset', 'requireMinSuccess', 'minSuccess'
    ];

    const formatCurrency = (num) => {
        if (num === 0 || Math.abs(num) < 0.5) return '-';
        return new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD', maximumFractionDigits: 0 }).format(num);
    };

    function saveInputs() {
        try {
            inputIds.forEach(id => { 
                const el = document.getElementById(id);
                if(el) {
                    const v = el.type === 'checkbox' ? String(el.checked) : el.value;
                    localStorage.setItem(`retirePlanner_${id}`, v);
                }
            });
        } catch (e) {
            console.warn("Local storage unavailable", e);
        }
    }

    function loadInputs() {
        try {
            inputIds.forEach(id => {
                const val = localStorage.getItem(`retirePlanner_${id}`);
                const el = document.getElementById(id);
                if (val !== null && el) {
                    if (el.type === 'checkbox') el.checked = val === 'true';
                    else el.value = val;
                }
            });
        } catch (e) {
            console.warn("Local storage unavailable", e);
        }
    }

    function createSpendingScheduleRow(startAge, endAge, amount) {
        const row = document.createElement('div');
        row.className = 'spending-row';
        row.innerHTML = `
            <div class="form-group" style="margin-bottom:0;">
                <label>Start Age</label>
                <input type="number" class="sched-start" min="0" max="120" value="${startAge}">
            </div>
            <div class="form-group" style="margin-bottom:0;">
                <label>End Age</label>
                <input type="number" class="sched-end" min="0" max="120" value="${endAge}">
            </div>
            <div class="form-group" style="margin-bottom:0; display:flex; gap:6px; align-items:flex-end;">
                <div style="flex:1;">
                    <label>Net Spend/Yr</label>
                    <input type="number" class="sched-amount" min="0" value="${amount}">
                </div>
                <button type="button" class="remove-spending-row" title="Remove phase" aria-label="Remove phase" style="width:30px; min-width:30px; height:36px; margin-top:0; padding:0; font-size:1rem; line-height:1; display:flex; align-items:center; justify-content:center; background:#64748b;">×</button>
            </div>
        `;
        return row;
    }

    function saveSpendingSchedule() {
        try {
            const rows = Array.from(document.querySelectorAll('#spendingScheduleRows .spending-row')).map(row => ({
                startAge: parseInt(row.querySelector('.sched-start').value),
                endAge: parseInt(row.querySelector('.sched-end').value),
                amount: parseFloat(row.querySelector('.sched-amount').value)
            }));
            localStorage.setItem('retirePlanner_spendingSchedule', JSON.stringify(rows));
        } catch (e) {
            console.warn("Local storage unavailable", e);
        }
    }

    function loadSpendingSchedule() {
        const container = document.getElementById('spendingScheduleRows');
        container.innerHTML = '';

        let rows = null;
        try {
            const raw = localStorage.getItem('retirePlanner_spendingSchedule');
            if (raw) rows = JSON.parse(raw);
        } catch (e) {
            console.warn("Spending schedule load failed", e);
        }

        if (!Array.isArray(rows) || rows.length === 0) {
            const currentAge = parseInt(document.getElementById('age').value) || 60;
            const lifeExpectancy = parseInt(document.getElementById('lifeExpectancy').value) || 100;
            const spend = parseFloat(document.getElementById('spending').value) || 60000;
            container.appendChild(createSpendingScheduleRow(currentAge, lifeExpectancy, spend));
            return;
        }

        rows.forEach(r => {
            const startAge = Number.isFinite(r.startAge) ? r.startAge : 60;
            const endAge = Number.isFinite(r.endAge) ? r.endAge : 100;
            const amount = Number.isFinite(r.amount) ? r.amount : 60000;
            container.appendChild(createSpendingScheduleRow(startAge, endAge, amount));
        });
    }

    function getValidatedSpendingSchedule() {
        const statusEl = document.getElementById('spendingScheduleStatus');
        const currentAge = parseInt(document.getElementById('age').value) || 60;
        const lifeExpectancy = Math.max(currentAge, Math.min(120, parseInt(document.getElementById('lifeExpectancy').value) || 100));
        const rawRows = Array.from(document.querySelectorAll('#spendingScheduleRows .spending-row')).map(row => ({
            startAge: parseInt(row.querySelector('.sched-start').value),
            endAge: parseInt(row.querySelector('.sched-end').value),
            amount: parseFloat(row.querySelector('.sched-amount').value)
        }));

        let wasClamped = false;
        const cleaned = rawRows
            .filter(r => Number.isFinite(r.startAge) && Number.isFinite(r.endAge) && Number.isFinite(r.amount))
            .map(r => {
                const next = { ...r };
                const clampedStart = Math.max(currentAge, Math.min(lifeExpectancy, next.startAge));
                const clampedEnd = Math.max(currentAge, Math.min(lifeExpectancy, next.endAge));
                if (clampedStart !== next.startAge || clampedEnd !== next.endAge) wasClamped = true;
                next.startAge = clampedStart;
                next.endAge = clampedEnd;
                return next;
            });
        if (cleaned.length === 0) {
            statusEl.style.color = '#b91c1c';
            statusEl.innerText = 'No valid schedule rows found. Using default Desired Net Spend/Yr.';
            return [];
        }

        cleaned.sort((a, b) => a.startAge - b.startAge);

        for (let i = 0; i < cleaned.length; i++) {
            if (cleaned[i].startAge > cleaned[i].endAge) {
                statusEl.style.color = '#b91c1c';
                statusEl.innerText = 'Each row needs Start Age <= End Age. Using default Desired Net Spend/Yr.';
                return [];
            }
            if (i > 0 && cleaned[i].startAge <= cleaned[i - 1].endAge) {
                statusEl.style.color = '#b91c1c';
                statusEl.innerText = 'Spending schedule rows overlap. Using default Desired Net Spend/Yr.';
                return [];
            }
        }

        if (wasClamped) {
            const rowEls = Array.from(document.querySelectorAll('#spendingScheduleRows .spending-row'));
            cleaned.forEach((r, idx) => {
                const rowEl = rowEls[idx];
                if (!rowEl) return;
                rowEl.querySelector('.sched-start').value = r.startAge;
                rowEl.querySelector('.sched-end').value = r.endAge;
            });
            saveSpendingSchedule();
            statusEl.style.color = '#b45309';
            statusEl.innerText = `Schedule ages were clamped to current age (${currentAge}) and life expectancy (${lifeExpectancy}).`;
            return cleaned;
        }

        statusEl.style.color = '#166534';
        statusEl.innerText = `Using ${cleaned.length} spending phase${cleaned.length === 1 ? '' : 's'} through age ${lifeExpectancy}.`;
        return cleaned;
    }

    function getBaseSpendingForAge(currentAge, defaultSpending, schedule) {
        if (!Array.isArray(schedule) || schedule.length === 0) return defaultSpending;
        const row = schedule.find(r => currentAge >= r.startAge && currentAge <= r.endAge);
        return row ? row.amount : defaultSpending;
    }

    function getDepletionBucket(age) {
        if (age < 65) return 'Before 65';
        if (age <= 69) return '65-69';
        if (age <= 74) return '70-74';
        if (age <= 79) return '75-79';
        if (age <= 84) return '80-84';
        if (age <= 89) return '85-89';
        if (age <= 94) return '90-94';
        if (age <= 99) return '95-99';
        return '100+';
    }

    async function runMonteCarlo(params) {
        const {
            age, rrspStart, tfsaStart, nonregStart, acbStart,
            baseSpending, spendingSchedule, inflation, growth,
            provCode, cppScenarioAge, selectedCPPMonthly, oasPercent,
            rrifStartAge, enforceRrifMin, strategy, projectionAge, trials, volatility, inflationVolatility, seed, onProgress, shouldCancel, constructedMixByAge
        } = params;

        const rng = Number.isFinite(seed) ? createSeededRng(seed) : Math.random;
        let successCount = 0;
        let totalTax = 0;
        let totalClawback = 0;
        const finalEstates = [];
        const depletionAges = [];
        const yearsCount = Math.max(1, projectionAge - age + 1);
        const ageLabels = Array.from({ length: yearsCount }, (_, i) => age + i);
        const assetsByYear = Array.from({ length: yearsCount }, () => []);
        const successBucketLabel = `${projectionAge}+ (Success)`;
        const bucketLabels = ['Before 65', '65-69', '70-74', '75-79', '80-84', '85-89', '90-94', '95-99', successBucketLabel];
        const bucketCounts = Object.fromEntries(bucketLabels.map(b => [b, 0]));
        let completedTrials = 0;
        let cancelled = false;

        // Process MC trials in chunks so the UI can update progress/cancel state between batches.
        const chunkSize = 25;
        for (let t = 0; t < trials; t++) {
            if (typeof shouldCancel === 'function' && shouldCancel()) {
                cancelled = true;
                break;
            }
            let rrsp = rrspStart;
            let tfsa = tfsaStart;
            let nonreg = nonregStart;
            let currentAcb = acbStart;
            let depleted = false;
            let finalAge = age;
            let thisTax = 0;
            let thisClawback = 0;
            let mcInflationFactor = 1;
            const yearlyAssets = new Array(yearsCount).fill(0);

            for (let i = 0; age + i <= projectionAge; i++) {
                const currentAge = age + i;
                const inflationFactor = mcInflationFactor;
                const ageBaseSpending = getBaseSpendingForAge(currentAge, baseSpending, spendingSchedule);
                const targetSpending = ageBaseSpending * inflationFactor;

                let totalIncomeTaxThisYear = 0;
                let oasClawbackThisYear = 0;
                let grossCPP = 0, grossOAS = 0;
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
                        rrsp -= mandatoryGross;
                        currentTaxableIncome += mandatoryGross;
                        totalIncomeTaxThisYear += mandatoryTax;
                        netGovIncome += (mandatoryGross - mandatoryTax);
                    }
                }

                netNeeded = Math.max(0, targetSpending - netGovIncome);

                const executeDraw = (accountType, targetNet) => {
                    if (targetNet <= 0 || netNeeded <= 0) return;
                    const amountToDraw = Math.min(targetNet, netNeeded);

                    if (accountType === 'tfsa' && tfsa > 0) {
                        const d = Math.min(tfsa, amountToDraw);
                        tfsa -= d;
                        netNeeded -= d;
                    } else if (accountType === 'nonreg' && nonreg > 0) {
                        const acbRatio = nonreg > 0.01 ? Math.min(currentAcb / nonreg, 1.0) : 1.0;
                        const inclusionRate = (1 - acbRatio) * 0.50;
                        const res = findGrossDraw(amountToDraw, nonreg, currentTaxableIncome, inclusionRate, provCode, inflationFactor);
                        nonreg -= res.gross;
                        netNeeded -= res.net;
                        totalIncomeTaxThisYear += res.tax;
                        currentTaxableIncome += res.taxableAdd;
                        currentAcb -= (res.gross * acbRatio);
                        if (currentAcb < 0) currentAcb = 0;
                    } else if (accountType === 'rrsp' && rrsp > 0) {
                        const res = findGrossDraw(amountToDraw, rrsp, currentTaxableIncome, 1.0, provCode, inflationFactor);
                        rrsp -= res.gross;
                        netNeeded -= res.net;
                        totalIncomeTaxThisYear += res.tax;
                        currentTaxableIncome += res.taxableAdd;
                    }
                };

                let low = 0, high = 50000 * inflationFactor;
                for (let j = 0; j < 20; j++) {
                    const mid = (low + high) / 2;
                    if (calculateTax(mid, provCode, inflationFactor) <= 0.01) low = mid; else high = mid;
                }

                const remainingZeroTaxRoom = Math.max(0, low - currentTaxableIncome);
                const rrspTaxFreeDraw = Math.min(rrsp, remainingZeroTaxRoom, netNeeded);
                if (rrspTaxFreeDraw > 0) {
                    rrsp -= rrspTaxFreeDraw;
                    netNeeded -= rrspTaxFreeDraw;
                    currentTaxableIncome += rrspTaxFreeDraw;
                }

                const executeByStrategy = () => {
                    if (strategy === 'proportional') {
                        for (let k = 0; k < 10 && netNeeded > 0.01; k++) {
                            const tot = rrsp + tfsa + nonreg;
                            if (tot <= 0) break;
                            executeDraw('tfsa', netNeeded * (tfsa / tot));
                            executeDraw('nonreg', netNeeded * (nonreg / tot));
                            executeDraw('rrsp', netNeeded * (rrsp / tot));
                        }
                    } else if (strategy === 'outcome-based') {
                        const mix = constructedMixByAge && constructedMixByAge[currentAge] ? constructedMixByAge[currentAge] : { tfsa: 1/3, nonreg: 1/3, rrsp: 1/3 };
                        for (let k = 0; k < 20 && netNeeded > 0.01; k++) {
                            const active = {
                                tfsa: tfsa > 0 ? mix.tfsa : 0,
                                nonreg: nonreg > 0 ? mix.nonreg : 0,
                                rrsp: rrsp > 0 ? mix.rrsp : 0
                            };
                            const den = active.tfsa + active.nonreg + active.rrsp;
                            if (den <= 0) break;
                            executeDraw('tfsa', netNeeded * (active.tfsa / den));
                            executeDraw('nonreg', netNeeded * (active.nonreg / den));
                            executeDraw('rrsp', netNeeded * (active.rrsp / den));
                        }
                        if (netNeeded > 0.01) {
                            ['tfsa', 'nonreg', 'rrsp'].forEach(acc => executeDraw(acc, netNeeded));
                        }
                    } else {
                        const sequences = {
                            'tfsa-rrsp-nonreg': ['tfsa', 'rrsp', 'nonreg'],
                            'tfsa-nonreg-rrsp': ['tfsa', 'nonreg', 'rrsp'],
                            'rrsp-tfsa-nonreg': ['rrsp', 'tfsa', 'nonreg'],
                            'nonreg-tfsa-rrsp': ['nonreg', 'tfsa', 'rrsp'],
                            'nonreg-rrsp-tfsa': ['nonreg', 'rrsp', 'tfsa'],
                            'rrsp-nonreg-tfsa': ['rrsp', 'nonreg', 'tfsa']
                        };
                        sequences[strategy].forEach(acc => executeDraw(acc, netNeeded));
                        if (netNeeded > 0.01) sequences[strategy].forEach(acc => executeDraw(acc, netNeeded));
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
                        if (currentTaxableIncome > oasThreshold) clawback = (currentTaxableIncome - oasThreshold) * 0.15;
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
                yearlyAssets[i] = rrsp + tfsa + nonreg;

                finalAge = currentAge;
                if (netNeeded > 1) {
                    depleted = true;
                    break;
                }

                const sampledGrowth = growth + (volatility * randomNormal(rng));
                const yearlyGrowth = Math.max(-0.95, sampledGrowth);
                const sampledInflation = inflation + (inflationVolatility * randomNormal(rng));
                const yearlyInflation = Math.max(-0.03, Math.min(0.20, sampledInflation));
                rrsp *= (1 + yearlyGrowth);
                tfsa *= (1 + yearlyGrowth);
                nonreg *= (1 + yearlyGrowth);
                mcInflationFactor *= (1 + yearlyInflation);
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
            for (let i = 0; i < yearsCount; i++) assetsByYear[i].push(yearlyAssets[i]);
            completedTrials++;

            if ((t + 1) % chunkSize === 0 || t === trials - 1) {
                if (typeof onProgress === 'function') {
                    const partialP10 = assetsByYear.map(v => percentile(v, 10));
                    const partialP25 = assetsByYear.map(v => percentile(v, 25));
                    const partialP50 = assetsByYear.map(v => percentile(v, 50));
                    const partialP75 = assetsByYear.map(v => percentile(v, 75));
                    const partialP90 = assetsByYear.map(v => percentile(v, 90));
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
                        partialP90
                    );
                }
                // Yield to the event loop to keep the page responsive during long runs.
                await new Promise(resolve => setTimeout(resolve, 0));
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
                assetP90: []
            };
        }

        const assetP10 = assetsByYear.map(v => percentile(v, 10));
        const assetP25 = assetsByYear.map(v => percentile(v, 25));
        const assetP50 = assetsByYear.map(v => percentile(v, 50));
        const assetP75 = assetsByYear.map(v => percentile(v, 75));
        const assetP90 = assetsByYear.map(v => percentile(v, 90));

        return {
            trials: completedTrials,
            requestedTrials: trials,
            successRate: successCount / completedTrials,
            avgTax: totalTax / completedTrials,
            avgClawback: totalClawback / completedTrials,
            medianFinalEstate: percentile(finalEstates, 50),
            p10FinalEstate: percentile(finalEstates, 10),
            p90FinalEstate: percentile(finalEstates, 90),
            medianDepletionAge: depletionAges.length ? percentile(depletionAges, 50) : null,
            cancelled,
            bucketLabels,
            bucketCounts,
            ageLabels,
            assetP10,
            assetP25,
            assetP50,
            assetP75,
            assetP90
        };
    }

    async function solveSustainableSpending(params) {
        const {
            targetSuccessRate,
            precision,
            maxIterations,
            baselineSpend,
            monteCarloParams,
            onIteration,
            shouldCancel
        } = params;

        let low = 0;
        let high = Math.max(10000, baselineSpend || 60000);
        const testTrials = Math.max(150, Math.min(400, Math.round((monteCarloParams.trials || 500) * 0.5)));

        for (let expand = 0; expand < 8; expand++) {
            const res = await runMonteCarlo({ ...monteCarloParams, trials: testTrials, baseSpending: high });
            if (typeof onIteration === 'function') onIteration(`Bracketing at ${formatCurrency(high)} (${(res.successRate * 100).toFixed(1)}%)`);
            if (typeof shouldCancel === 'function' && shouldCancel()) return null;
            if (res.successRate < targetSuccessRate) break;
            high *= 1.5;
        }

        let best = low;
        for (let i = 0; i < maxIterations; i++) {
            if (typeof shouldCancel === 'function' && shouldCancel()) return null;
            const mid = (low + high) / 2;
            const res = await runMonteCarlo({ ...monteCarloParams, trials: testTrials, baseSpending: mid });
            if (typeof onIteration === 'function') onIteration(`Solve iter ${i + 1}/${maxIterations}: ${formatCurrency(mid)} -> ${(res.successRate * 100).toFixed(1)}%`);

            if (res.successRate >= targetSuccessRate) {
                best = mid;
                low = mid;
            } else {
                high = mid;
            }
            if ((high - low) <= precision) break;
        }

        return best;
    }

    function renderMonteCarloOutcomeChart(monteCarloResults) {
        const mcCard = document.getElementById('mcOutcomeCard');
        const mcSubtitle = document.getElementById('mcChartSubtitle');
        if (!mcCard || !mcSubtitle) return;

        if (!monteCarloResults || !monteCarloResults.trials || monteCarloResults.trials <= 0) {
            if (mcOutcomeChartInst) {
                mcOutcomeChartInst.destroy();
                mcOutcomeChartInst = null;
            }
            mcCard.style.display = 'none';
            mcSubtitle.innerText = '';
            return;
        }

        mcCard.style.display = 'block';
        const bucketLabels = monteCarloResults.bucketLabels || [];
        const counts = bucketLabels.map(l => monteCarloResults.bucketCounts?.[l] || 0);
        const percents = counts.map(c => (c / monteCarloResults.trials) * 100);
        mcSubtitle.innerText = `Based on ${monteCarloResults.trials.toLocaleString()} / ${monteCarloResults.requestedTrials.toLocaleString()} trials${monteCarloResults.cancelled ? ' (partial run)' : ''}`;

        if (!mcOutcomeChartInst) {
            mcOutcomeChartInst = new Chart(document.getElementById('mcOutcomeChart').getContext('2d'), {
                type: 'bar',
                data: {
                    labels: bucketLabels,
                    datasets: [{
                        label: 'Trial Share (%)',
                        data: percents,
                        backgroundColor: bucketLabels.map(l => l.includes('(Success)') ? '#16a34a' : '#f59e0b')
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    animation: false,
                    plugins: {
                        tooltip: {
                            callbacks: {
                                label: (ctx) => `${ctx.parsed.y.toFixed(1)}% (${counts[ctx.dataIndex].toLocaleString()} trials)`
                            }
                        }
                    },
                    scales: {
                        x: { ticks: { maxRotation: 0, minRotation: 0 } },
                        y: { beginAtZero: true, ticks: { callback: (v) => `${v}%` } }
                    }
                }
            });
            return;
        }

        mcOutcomeChartInst.data.labels = bucketLabels;
        mcOutcomeChartInst.data.datasets[0].data = percents;
        mcOutcomeChartInst.data.datasets[0].backgroundColor = bucketLabels.map(l => l.includes('(Success)') ? '#16a34a' : '#f59e0b');
        mcOutcomeChartInst.options.plugins.tooltip.callbacks.label = (ctx) => `${ctx.parsed.y.toFixed(1)}% (${counts[ctx.dataIndex].toLocaleString()} trials)`;
        mcOutcomeChartInst.update('none');
    }

    function renderMonteCarloPercentileChart(monteCarloResults) {
        const card = document.getElementById('mcPercentileCard');
        const subtitle = document.getElementById('mcPercentileSubtitle');
        if (!card || !subtitle) return;

        if (!monteCarloResults || !monteCarloResults.trials || !monteCarloResults.ageLabels?.length) {
            if (mcPercentileChartInst) {
                mcPercentileChartInst.destroy();
                mcPercentileChartInst = null;
            }
            card.style.display = 'none';
            subtitle.innerText = '';
            return;
        }

        card.style.display = 'block';
        const displayInflated = document.getElementById('displayMode').checked;
        const baseInflation = parseFloat(document.getElementById('inflation').value) / 100;
        subtitle.innerText = `Based on ${monteCarloResults.trials.toLocaleString()} / ${monteCarloResults.requestedTrials.toLocaleString()} trials${monteCarloResults.cancelled ? ' (partial run)' : ''}. P10 means 10% of paths were below this level. Values shown in ${displayInflated ? 'inflated/nominal' : "today's"} dollars.`;

        const labels = monteCarloResults.ageLabels;
        const adjustSeries = (series) => (series || []).map((v, idx) => {
            if (displayInflated) return v;
            return v / Math.pow(1 + baseInflation, idx);
        });
        const p10 = adjustSeries(monteCarloResults.assetP10);
        const p25 = adjustSeries(monteCarloResults.assetP25);
        const p50 = adjustSeries(monteCarloResults.assetP50);
        const p75 = adjustSeries(monteCarloResults.assetP75);
        const p90 = adjustSeries(monteCarloResults.assetP90);

        const datasets = [
            {
                label: 'P10',
                data: p10,
                borderColor: '#f59e0b',
                borderWidth: 1.2,
                pointRadius: 0,
                fill: false
            }
        ];

        datasets.push(
            {
                label: 'P25',
                data: p25,
                borderColor: '#0ea5a4',
                borderWidth: 1.2,
                pointRadius: 0,
                fill: false
            },
            {
                label: 'P75',
                data: p75,
                borderColor: '#0ea5a4',
                borderWidth: 1.2,
                pointRadius: 0,
                fill: '-1',
                backgroundColor: 'rgba(14,165,164,0.18)'
            }
        );

        datasets.push(
            {
                label: 'P50',
                data: p50,
                borderColor: '#0f766e',
                borderWidth: 2.5,
                pointRadius: 0,
                fill: false
            },
            {
                label: 'P90',
                data: p90,
                borderColor: '#2563eb',
                borderWidth: 1.2,
                pointRadius: 0,
                fill: '-1',
                backgroundColor: 'rgba(37,99,235,0.10)'
            }
        );

        const data = { labels, datasets };

        const options = {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                tooltip: {
                    callbacks: {
                        label: (ctx) => `${ctx.dataset.label}: ${new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD', maximumFractionDigits: 0 }).format(ctx.parsed.y)}`
                    }
                }
            },
            scales: {
                y: {
                    ticks: { callback: (v) => '$' + Number(v).toLocaleString() }
                }
            }
        };

        if (!mcPercentileChartInst) {
            mcPercentileChartInst = new Chart(document.getElementById('mcPercentileChart').getContext('2d'), {
                type: 'line',
                data,
                options
            });
            return;
        }

        mcPercentileChartInst.data = data;
        mcPercentileChartInst.options = options;
        mcPercentileChartInst.update('none');
    }

    async function calculateRetirement(runMonteCarloNow = true) {
        if (isRecalculating) {
            queuedRecalc = runMonteCarloNow || queuedRecalc === true;
            return;
        }
        isRecalculating = true;
        saveInputs();
        const runStatusEl = document.getElementById('runStatus');
        const runBtn = document.getElementById('calcBtn');
        const stopBtn = document.getElementById('stopBtn');

        try {

        let age = parseInt(document.getElementById('age').value);
        let rrsp = parseFloat(document.getElementById('rrsp').value);
        let tfsa = parseFloat(document.getElementById('tfsa').value);
        let nonreg = parseFloat(document.getElementById('nonreg').value);
        let currentAcb = parseFloat(document.getElementById('nonregAcb').value);
        
        if (currentAcb > nonreg) { currentAcb = nonreg; document.getElementById('nonregAcb').value = nonreg; }

        let baseSpending = parseFloat(document.getElementById('spending').value);
        const spendingSchedule = getValidatedSpendingSchedule();
        const spendingMode = document.getElementById('spendingMode').value;
        const targetSuccessRate = Math.max(0.5, Math.min(0.99, (parseFloat(document.getElementById('targetSuccess').value) || 90) / 100));
        const solvePrecision = Math.max(10, parseFloat(document.getElementById('solvePrecision').value) || 100);
        const lifeExpectancy = Math.max(age, Math.min(120, parseInt(document.getElementById('lifeExpectancy').value) || 100));
        const inflation = parseFloat(document.getElementById('inflation').value) / 100;
        const growth = parseFloat(document.getElementById('growth').value) / 100;
        const provCode = document.getElementById('province').value;
        
        const cppScenarioAge = parseInt(document.getElementById('cppScenario').value);
        let selectedCPPMonthly = cppScenarioAge === 60 ? parseFloat(document.getElementById('cpp60').value) : 
                                 cppScenarioAge === 70 ? parseFloat(document.getElementById('cpp70').value) : 
                                 parseFloat(document.getElementById('cpp65').value);

        const oasPercent = parseFloat(document.getElementById('oasPercent').value) / 100;
        const rrifStartAge = parseInt(document.getElementById('rrifStartAge').value);
        const enforceRrifMin = document.getElementById('enforceRrifMin').value === 'yes';
        const strategy = document.getElementById('strategy').value;
        const strategyMode = document.getElementById('strategyMode').value;
        const selectedStrategyMode = strategyMode === 'advanced' ? 'outcome-based' : strategy;
        const enableMonteCarlo = document.getElementById('enableMonteCarlo').checked;
        const mcTrials = Math.max(100, Math.min(10000, parseInt(document.getElementById('mcTrials').value) || 1000));
        const mcVolatility = Math.max(0, parseFloat(document.getElementById('mcVolatility').value) / 100 || 0);
        const mcInflationVolatility = Math.max(0, parseFloat(document.getElementById('mcInflationVolatility').value) / 100 || 0);
        const mcSeedRaw = document.getElementById('mcSeed').value;
        const mcSeed = mcSeedRaw === '' ? NaN : parseInt(mcSeedRaw);

        let solvedSpendOutput = null;

        if (spendingMode === 'solve') {
            if (!enableMonteCarlo) {
                if (runStatusEl) {
                    runStatusEl.style.color = '#b45309';
                    runStatusEl.innerText = 'Enable Monte Carlo to solve sustainable spending.';
                }
            } else if (runMonteCarloNow) {
                if (runStatusEl) {
                    runStatusEl.style.color = '#0369a1';
                    runStatusEl.innerText = 'Solving sustainable spending...';
                }
                const solved = await solveSustainableSpending({
                    targetSuccessRate,
                    precision: solvePrecision,
                    maxIterations: 18,
                    baselineSpend: baseSpending,
                    monteCarloParams: {
                        age,
                        rrspStart: parseFloat(document.getElementById('rrsp').value),
                        tfsaStart: parseFloat(document.getElementById('tfsa').value),
                        nonregStart: parseFloat(document.getElementById('nonreg').value),
                        acbStart: parseFloat(document.getElementById('nonregAcb').value),
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
                        shouldCancel: () => mcCancelRequested
                    },
                    onIteration: (msg) => { if (runStatusEl) runStatusEl.innerText = msg; },
                    shouldCancel: () => mcCancelRequested
                });
                if (solved !== null) {
                    baseSpending = solved;
                    solvedSpendOutput = solved;
                    lastSolvedSpend = solved;
                    const spendingEl = document.getElementById('spending');
                    if (spendingEl) spendingEl.value = Math.round(solved);
                }
            }
        }

        const activeSchedule = spendingMode === 'solve' ? [] : spendingSchedule;
        let effectiveStrategy = selectedStrategyMode;
        const constructedMixByAge = {};
        const showAdvancedProgress = selectedStrategyMode === 'outcome-based' && runMonteCarloNow;

        if (showAdvancedProgress && runBtn) {
            runBtn.disabled = true;
            runBtn.innerText = 'Optimizing...';
        }

        const results =[];
        let isDepleted = false;

        for (let i = 0; age + i <= lifeExpectancy; i++) {
            let currentAge = age + i;
            let inflationFactor = Math.pow(1 + inflation, i);
            let ageBaseSpending = getBaseSpendingForAge(currentAge, baseSpending, activeSchedule);
            let targetSpending = ageBaseSpending * inflationFactor;
            
            let totalIncomeTaxThisYear = 0;
            let oasClawbackThisYear = 0;
            let mandatoryRrifDrawThisYear = 0;
            let debugClawbackIterations = 0;
            let debugFinalTaxableIncome = 0;

            let grossCPP = 0, grossOAS = 0;
            let drawRRSP = 0, drawTFSA = 0, drawNonReg = 0;
            let netNeeded = 0;

            if (currentAge >= cppScenarioAge) grossCPP = (selectedCPPMonthly * 12) * inflationFactor;
            if (currentAge >= 65) {
                let baseOASMonthly = currentAge >= 75 ? 817.36 : 743.05;
                grossOAS = (baseOASMonthly * 12) * oasPercent * inflationFactor;
            }

            let currentTaxableIncome = grossCPP + grossOAS;
            let baseTax = calculateTax(currentTaxableIncome, provCode, inflationFactor);
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
                let amountToDraw = Math.min(targetNet, netNeeded);

                if (accountType === 'tfsa' && tfsa > 0) {
                    let tfsaNetDraw = Math.min(tfsa, amountToDraw);
                    tfsa -= tfsaNetDraw;
                    netNeeded -= tfsaNetDraw;
                    drawTFSA += tfsaNetDraw;

                } else if (accountType === 'nonreg' && nonreg > 0) {
                    // Safe ACB ratio to prevent NaN if nonreg nears 0
                    let acbRatio = nonreg > 0.01 ? Math.min(currentAcb / nonreg, 1.0) : 1.0;
                    let inclusionRate = (1 - acbRatio) * 0.50; 
                    
                    let res = findGrossDraw(amountToDraw, nonreg, currentTaxableIncome, inclusionRate, provCode, inflationFactor);
                    nonreg -= res.gross;
                    netNeeded -= res.net;
                    totalIncomeTaxThisYear += res.tax;
                    drawNonReg += res.gross;
                    currentTaxableIncome += res.taxableAdd;
                    
                    currentAcb -= (res.gross * acbRatio);
                    if (currentAcb < 0) currentAcb = 0;

                } else if (accountType === 'rrsp' && rrsp > 0) {
                    let res = findGrossDraw(amountToDraw, rrsp, currentTaxableIncome, 1.0, provCode, inflationFactor);
                    rrsp -= res.gross;
                    netNeeded -= res.net;
                    totalIncomeTaxThisYear += res.tax;
                    drawRRSP += res.gross;
                    currentTaxableIncome += res.taxableAdd;
                }
            };

            // Approximate taxable-income ceiling where calculated tax is still effectively zero,
            // then use remaining room for low-friction RRSP draw before strategy withdrawals.
            let maxTaxFreeInc = 0;
            let low = 0, high = 50000 * inflationFactor;
            for(let j=0; j<20; j++) {
                let mid = (low+high)/2;
                if(calculateTax(mid, provCode, inflationFactor) <= 0.01) low=mid; else high=mid;
            }
            maxTaxFreeInc = low;
            
            let remainingZeroTaxRoom = Math.max(0, maxTaxFreeInc - currentTaxableIncome);
            let rrspTaxFreeDraw = Math.min(rrsp, remainingZeroTaxRoom, netNeeded);
            
            if (rrspTaxFreeDraw > 0) {
                rrsp -= rrspTaxFreeDraw;
                netNeeded -= rrspTaxFreeDraw;
                drawRRSP += rrspTaxFreeDraw;
                currentTaxableIncome += rrspTaxFreeDraw;
            }

            const executeByStrategy = (targetNet) => {
                if (targetNet <= 0 || netNeeded <= 0) return;

                if (effectiveStrategy === 'proportional') {
                    for (let k = 0; k < 10 && netNeeded > 0.01; k++) {
                        let tot = rrsp + tfsa + nonreg;
                        if (tot <= 0) break;

                        let pRRSP = rrsp / tot;
                        let pTFSA = tfsa / tot;
                        let pNonReg = nonreg / tot;
                        let needNetToSplit = netNeeded;

                        executeDraw('tfsa', needNetToSplit * pTFSA);
                        executeDraw('nonreg', needNetToSplit * pNonReg);
                        executeDraw('rrsp', needNetToSplit * pRRSP);
                    }
                } else if (effectiveStrategy === 'outcome-based') {
                    const weights = getNormalizedOutcomeWeights();
                    const probeNeed = Math.max(250, netNeeded);
                    const oasThreshold = 90997 * inflationFactor;
                    const available = ['tfsa', 'nonreg', 'rrsp'].filter(acc => (acc === 'tfsa' ? tfsa : acc === 'nonreg' ? nonreg : rrsp) > 0);
                    let bestMix = { tfsa: 1/3, nonreg: 1/3, rrsp: 1/3 };
                    let bestScore = -Infinity;

                    const objectiveWeights = [weights.wTax, weights.wOas, weights.wEstate, weights.wSuccess];
                    const maxObjectiveWeight = Math.max(...objectiveWeights);
                    const dominantSingleObjective = maxObjectiveWeight >= 0.95;

                if (runStatusEl && (i % 3 === 0)) {
                    runStatusEl.style.color = '#0369a1';
                    runStatusEl.innerText = `Constructing outcome-based policy: age ${currentAge}`;
                }

                    const horizonScoreForMix = (mix) => {
                        let sRrsp = rrsp, sTfsa = tfsa, sNon = nonreg, sAcb = currentAcb;
                        let sTaxable = currentTaxableIncome;
                        let totalTax = 0;
                        let totalClaw = 0;
                        let totalShortfall = 0;

                        const runYear = (ageAtYear, yearInflationFactor, needNet, forcedMix) => {
                            let yearTax = 0;
                            const drawSim = (acc, targetNet) => {
                                if (targetNet <= 0 || needNet <= 0) return;
                                const amt = Math.min(targetNet, needNet);
                                if (acc === 'tfsa' && sTfsa > 0) {
                                    const d = Math.min(sTfsa, amt);
                                    sTfsa -= d;
                                    needNet -= d;
                                } else if (acc === 'nonreg' && sNon > 0) {
                                    const acbRatio = sNon > 0.01 ? Math.min(sAcb / sNon, 1.0) : 1.0;
                                    const inclusionRate = (1 - acbRatio) * 0.50;
                                    const res = findGrossDraw(amt, sNon, sTaxable, inclusionRate, provCode, yearInflationFactor);
                                    sNon -= res.gross;
                                    needNet -= res.net;
                                    yearTax += res.tax;
                                    sTaxable += res.taxableAdd;
                                    sAcb -= (res.gross * acbRatio);
                                    if (sAcb < 0) sAcb = 0;
                                } else if (acc === 'rrsp' && sRrsp > 0) {
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
                                drawSim('tfsa', needNet * (active.tfsa / den));
                                drawSim('nonreg', needNet * (active.nonreg / den));
                                drawSim('rrsp', needNet * (active.rrsp / den));
                            }
                            if (needNet > 0.01) ['tfsa', 'nonreg', 'rrsp'].forEach(acc => drawSim(acc, needNet));

                            const yearOasThreshold = 90997 * yearInflationFactor;
                            let claw = 0;
                            if (ageAtYear >= 65 && sTaxable > yearOasThreshold) {
                                claw = Math.max(0, (sTaxable - yearOasThreshold) * 0.15);
                            }
                            totalTax += yearTax;
                            totalClaw += claw;
                            totalShortfall += Math.max(0, needNet);
                            return needNet;
                        };

                        const yearOffset = currentAge - age;
                        for (let y = yearOffset; age + y <= lifeExpectancy; y++) {
                            const ageY = age + y;
                            const inflY = Math.pow(1 + inflation, y);
                            const targetY = getBaseSpendingForAge(ageY, baseSpending, activeSchedule) * inflY;

                            let grossCPPY = 0, grossOASY = 0;
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

                    // Coarse-to-fine search over TFSA/Non-Reg/RRSP mix weights for this age year.
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

                                let simTaxable = currentTaxableIncome;
                                let simTax = 0;
                                let simNeed = probeNeed;
                                let simTfsa = tfsa;
                                let simNon = nonreg;
                                let simRrsp = rrsp;
                                let simAcb = currentAcb;

                                const simDraw = (acc, targetNet) => {
                                    if (targetNet <= 0 || simNeed <= 0) return;
                                    const amt = Math.min(targetNet, simNeed);
                                    if (acc === 'tfsa' && simTfsa > 0) {
                                        const d = Math.min(simTfsa, amt);
                                        simTfsa -= d;
                                        simNeed -= d;
                                    } else if (acc === 'nonreg' && simNon > 0) {
                                        const acbRatio = simNon > 0.01 ? Math.min(simAcb / simNon, 1.0) : 1.0;
                                        const inclusionRate = (1 - acbRatio) * 0.50;
                                        const res = findGrossDraw(amt, simNon, simTaxable, inclusionRate, provCode, inflationFactor);
                                        simNon -= res.gross;
                                        simNeed -= res.net;
                                        simTax += res.tax;
                                        simTaxable += res.taxableAdd;
                                        simAcb -= (res.gross * acbRatio);
                                        if (simAcb < 0) simAcb = 0;
                                    } else if (acc === 'rrsp' && simRrsp > 0) {
                                        const res = findGrossDraw(amt, simRrsp, simTaxable, 1.0, provCode, inflationFactor);
                                        simRrsp -= res.gross;
                                        simNeed -= res.net;
                                        simTax += res.tax;
                                        simTaxable += res.taxableAdd;
                                    }
                                };

                                simDraw('tfsa', probeNeed * mix.tfsa);
                                simDraw('nonreg', probeNeed * mix.nonreg);
                                simDraw('rrsp', probeNeed * mix.rrsp);

                                const simulatedEstate = simTfsa + simNon + simRrsp;
                                const oasPenalty = currentAge >= 65 ? Math.max(0, simTaxable - oasThreshold) * 0.15 : 0;
                                const shortfallPenalty = simNeed;
                                candidates.push({ mix, simTax, oasPenalty, simulatedEstate, shortfallPenalty });
                            }
                        }
                        return candidates;
                    };

                    let candidates;
                    if (dominantSingleObjective) {
                        // Fast path: when one objective dominates, test a compact set of anchor mixes.
                        // Fast path when one objective dominates (e.g., Maximize Estate = 100)
                        candidates = [
                            { mix: { tfsa: 1, nonreg: 0, rrsp: 0 } },
                            { mix: { tfsa: 0, nonreg: 1, rrsp: 0 } },
                            { mix: { tfsa: 0, nonreg: 0, rrsp: 1 } },
                            { mix: { tfsa: 0.5, nonreg: 0.5, rrsp: 0 } },
                            { mix: { tfsa: 0.5, nonreg: 0, rrsp: 0.5 } },
                            { mix: { tfsa: 0, nonreg: 0.5, rrsp: 0.5 } },
                            { mix: { tfsa: 1/3, nonreg: 1/3, rrsp: 1/3 } }
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
                        // Refine around the best coarse candidate for a better local solution.
                        const refined = evaluateCandidates(0.10, bestMix, 0.2);
                        if (refined.length) scoreCandidates(refined);
                    }

                    const normDen = bestMix.tfsa + bestMix.nonreg + bestMix.rrsp;
                    const normalizedMix = normDen > 0 ? {
                        tfsa: bestMix.tfsa / normDen,
                        nonreg: bestMix.nonreg / normDen,
                        rrsp: bestMix.rrsp / normDen
                    } : { tfsa: 1/3, nonreg: 1/3, rrsp: 1/3 };
                    constructedMixByAge[currentAge] = normalizedMix;

                    for (let k = 0; k < 20 && netNeeded > 0.01; k++) {
                        const active = {
                            tfsa: tfsa > 0 ? normalizedMix.tfsa : 0,
                            nonreg: nonreg > 0 ? normalizedMix.nonreg : 0,
                            rrsp: rrsp > 0 ? normalizedMix.rrsp : 0
                        };
                        const den = active.tfsa + active.nonreg + active.rrsp;
                        if (den <= 0) break;
                        executeDraw('tfsa', netNeeded * (active.tfsa / den));
                        executeDraw('nonreg', netNeeded * (active.nonreg / den));
                        executeDraw('rrsp', netNeeded * (active.rrsp / den));
                    }
                    if (netNeeded > 0.01) {
                        ['tfsa', 'nonreg', 'rrsp'].forEach(acc => executeDraw(acc, netNeeded));
                    }
                } else {
                const sequences = {
                    'tfsa-rrsp-nonreg': ['tfsa', 'rrsp', 'nonreg'],
                    'tfsa-nonreg-rrsp': ['tfsa', 'nonreg', 'rrsp'],
                    'rrsp-tfsa-nonreg': ['rrsp', 'tfsa', 'nonreg'],
                    'nonreg-tfsa-rrsp': ['nonreg', 'tfsa', 'rrsp'],
                    'nonreg-rrsp-tfsa': ['nonreg', 'rrsp', 'tfsa'],
                    'rrsp-nonreg-tfsa': ['rrsp', 'nonreg', 'tfsa']
                };
                    sequences[effectiveStrategy].forEach(acc => executeDraw(acc, targetNet));
                }
            };

            executeByStrategy(netNeeded);

            if (effectiveStrategy !== 'proportional' && effectiveStrategy !== 'outcome-based' && netNeeded > 0.01) {
                const sequences = {
                    'tfsa-rrsp-nonreg': ['tfsa', 'rrsp', 'nonreg'],
                    'tfsa-nonreg-rrsp': ['tfsa', 'nonreg', 'rrsp'],
                    'rrsp-tfsa-nonreg': ['rrsp', 'tfsa', 'nonreg'],
                    'nonreg-tfsa-rrsp': ['nonreg', 'tfsa', 'rrsp'],
                    'nonreg-rrsp-tfsa': ['nonreg', 'rrsp', 'tfsa'],
                    'rrsp-nonreg-tfsa': ['rrsp', 'nonreg', 'tfsa']
                };
                sequences[effectiveStrategy].forEach(acc => executeDraw(acc, netNeeded));
            }

            if (grossOAS > 0) {
                // Same iterative clawback solve in deterministic mode.
                let oasThreshold = 90997 * inflationFactor;
                let prevClawback = 0;

                for (let k = 0; k < 10; k++) {
                    debugClawbackIterations = k + 1;
                    let clawback = 0;
                    if (currentTaxableIncome > oasThreshold) {
                        clawback = (currentTaxableIncome - oasThreshold) * 0.15;
                    }
                    clawback = Math.min(clawback, grossOAS);

                    let deltaClawback = clawback - prevClawback;
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

            let totalAssets = rrsp + tfsa + nonreg;
            if (netNeeded > 1) isDepleted = true;

            results.push({
                yearIndex: i,
                age: currentAge,
                spending: targetSpending,
                cpp: grossCPP,
                oas: grossOAS,
                drawRRSP: drawRRSP,
                drawTFSA: drawTFSA,
                drawNonReg: drawNonReg,
                rrsp: rrsp,
                tfsa: tfsa,
                nonreg: nonreg,
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

            if (showAdvancedProgress && runStatusEl && (i % 1 === 0)) {
                const totalYears = Math.max(1, lifeExpectancy - age + 1);
                runStatusEl.style.color = '#0369a1';
                runStatusEl.innerText = `Constructing advanced policy: year ${i + 1}/${totalYears} (age ${currentAge})`;
                // Yield to keep progress text/controls responsive during advanced-policy construction.
                await new Promise(resolve => setTimeout(resolve, 0));
            }

            if (isDepleted) break;

            rrsp *= (1 + growth); tfsa *= (1 + growth); nonreg *= (1 + growth);
        }

        let monteCarloResults = null;
        let monteCarloStale = false;
        if (enableMonteCarlo && runMonteCarloNow) {
            if (runStatusEl) {
                runStatusEl.style.color = '#0369a1';
                runStatusEl.innerText = `Running Monte Carlo (${mcTrials.toLocaleString()} trials)...`;
            }
            if (runBtn) {
                runBtn.disabled = true;
                runBtn.innerText = 'Running...';
            }
            if (stopBtn) stopBtn.style.display = 'block';
            mcCancelRequested = false;
            mcIsRunning = true;
            try {
                monteCarloResults = await runMonteCarlo({
                    age,
                    rrspStart: parseFloat(document.getElementById('rrsp').value),
                    tfsaStart: parseFloat(document.getElementById('tfsa').value),
                    nonregStart: parseFloat(document.getElementById('nonreg').value),
                    acbStart: parseFloat(document.getElementById('nonregAcb').value),
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
                    constructedMixByAge: effectiveStrategy === 'outcome-based' ? constructedMixByAge : null,
                    onProgress: (done, total, bucketLabels, bucketCounts, ageLabels, assetP10, assetP25, assetP50, assetP75, assetP90) => {
                        if (runStatusEl) {
                            const pct = ((done / total) * 100).toFixed(0);
                            runStatusEl.innerText = `Running Monte Carlo: ${done.toLocaleString()} / ${total.toLocaleString()} (${pct}%)`;
                        }
                        const partialResults = {
                            trials: done,
                            requestedTrials: total,
                            cancelled: false,
                            bucketLabels,
                            bucketCounts,
                            ageLabels,
                            assetP10,
                            assetP25,
                            assetP50,
                            assetP75,
                            assetP90
                        };
                        renderMonteCarloOutcomeChart(partialResults);
                        renderMonteCarloPercentileChart(partialResults);
                    },
                    shouldCancel: () => mcCancelRequested
                });
            } finally {
                mcIsRunning = false;
                if (runBtn) {
                    runBtn.disabled = false;
                    runBtn.innerText = 'Run Simulation';
                }
                if (stopBtn) stopBtn.style.display = 'none';
            }
            if (runStatusEl) {
                if (monteCarloResults.cancelled) {
                    runStatusEl.style.color = '#b45309';
                    runStatusEl.innerText = `Monte Carlo cancelled after ${monteCarloResults.trials.toLocaleString()} / ${monteCarloResults.requestedTrials.toLocaleString()} trials.`;
                } else {
                    runStatusEl.style.color = '#166534';
                    runStatusEl.innerText = `Monte Carlo complete: ${(monteCarloResults.successRate * 100).toFixed(1)}% success over ${monteCarloResults.trials.toLocaleString()} trials.`;
                }
            }
            lastMonteCarloResults = monteCarloResults;
            lastMonteCarloMeta = {
                trials: mcTrials,
                returnVolatility: mcVolatility,
                inflationVolatility: mcInflationVolatility,
                seed: Number.isFinite(mcSeed) ? mcSeed : null,
                runAtIso: new Date().toISOString(),
                cancelled: monteCarloResults.cancelled,
                completedTrials: monteCarloResults.trials,
                requestedTrials: monteCarloResults.requestedTrials
            };
        } else if (enableMonteCarlo && !runMonteCarloNow) {
            // Intentionally keep the last MC run visible until the user explicitly reruns simulation.
            if (runStatusEl) {
                runStatusEl.style.color = '#64748b';
                runStatusEl.innerText = 'Monte Carlo inputs changed. Click Run Simulation to refresh probability results.';
            }
            if (lastMonteCarloResults) {
                monteCarloResults = lastMonteCarloResults;
                monteCarloStale = true;
            }
        } else if (runStatusEl) {
            runStatusEl.style.color = '#64748b';
            runStatusEl.innerText = 'Deterministic mode ready.';
        }

        if (showAdvancedProgress && runBtn && !(enableMonteCarlo && runMonteCarloNow)) {
            runBtn.disabled = false;
            runBtn.innerText = 'Run Simulation';
        }

        updateUI(results, monteCarloResults, enableMonteCarlo, monteCarloStale, lastMonteCarloMeta, solvedSpendOutput, targetSuccessRate, spendingMode, selectedStrategyMode, effectiveStrategy);
        } finally {
            isRecalculating = false;
            if (queuedRecalc !== null) {
                const nextRunMonteCarlo = queuedRecalc;
                queuedRecalc = null;
                calculateRetirement(nextRunMonteCarlo);
            }
        }
    }

    function recalculateForUiChange() {
        if (recalcTimer) clearTimeout(recalcTimer);
        const enabled = document.getElementById('enableMonteCarlo').checked;
        const runStatusEl = document.getElementById('runStatus');
        const advancedMix = document.getElementById('strategyMode')?.value === 'advanced';
        if (runStatusEl && advancedMix) {
            runStatusEl.style.color = '#0369a1';
            runStatusEl.innerText = 'Updating outcome-based strategy...';
        }
        recalcTimer = setTimeout(() => {
            calculateRetirement(!enabled);
        }, 180);
    }

    function deferOutcomeBasedExecutionNotice() {
        const runStatusEl = document.getElementById('runStatus');
        if (!runStatusEl) return;
        runStatusEl.style.color = '#64748b';
        runStatusEl.innerText = 'Outcome settings changed. Click Run Simulation to apply.';
    }

    function updateMonteCarloSettingsVisibility() {
        const enabled = document.getElementById('enableMonteCarlo').checked;
        const box = document.getElementById('mcSettingsBox');
        if (box) box.style.display = enabled ? 'block' : 'none';
    }

    function updateOutcomeSettingsVisibility() {
        const mode = document.getElementById('strategyMode')?.value;
        const enabled = mode === 'advanced';
        const box = document.getElementById('outcomeSettings');
        const hint = document.getElementById('advancedModeHint');
        const simpleGroup = document.getElementById('simpleStrategyGroup');
        const simpleSelect = document.getElementById('strategy');
        if (box) box.style.display = enabled ? 'block' : 'none';
        if (hint) hint.style.display = enabled ? 'block' : 'none';
        if (simpleGroup) simpleGroup.style.display = enabled ? 'none' : 'block';
        if (simpleSelect) simpleSelect.disabled = enabled;
    }

    function applyOutcomePreset(preset) {
        const map = {
            balanced: { wTax: 30, wOas: 20, wEstate: 20, wSuccess: 30 },
            tax: { wTax: 60, wOas: 15, wEstate: 10, wSuccess: 15 },
            oas: { wTax: 15, wOas: 60, wEstate: 10, wSuccess: 15 },
            estate: { wTax: 15, wOas: 10, wEstate: 60, wSuccess: 15 },
            success: { wTax: 15, wOas: 10, wEstate: 10, wSuccess: 65 }
        };
        if (preset === 'custom') return;
        const p = map[preset] || map.balanced;
        ['wTax', 'wOas', 'wEstate', 'wSuccess'].forEach(k => {
            const el = document.getElementById(k);
            if (el) el.value = p[k];
        });
    }

    function updateOutcomePresetLockState() {
        const preset = document.getElementById('outcomePreset')?.value;
        const isCustom = preset === 'custom';
        ['wTax', 'wOas', 'wEstate', 'wSuccess'].forEach(k => {
            const el = document.getElementById(k);
            if (!el) return;
            el.disabled = !isCustom;
            el.style.backgroundColor = isCustom ? '#fff' : '#f1f5f9';
            el.style.cursor = isCustom ? 'text' : 'not-allowed';
        });
    }

    function setupCollapsibleSections() {
        let saved = {};
        try {
            saved = JSON.parse(localStorage.getItem('retirePlanner_sectionState') || '{}');
        } catch (e) {
            saved = {};
        }

        const defaultOpen = {
            'Basic Info & Taxes': false,
            'Current Assets ($)': false,
            'Canada Pension Plan (CPP)': false,
            'Old Age Security (OAS)': false,
            'RRIF Minimum Withdrawals': false,
            'Withdrawal Strategy': true,
            'Monte Carlo Simulation ?': true,
            'Display Options': false
        };

        const sections = Array.from(document.querySelectorAll('.input-section'));
        sections.forEach(section => {
            const h4 = section.querySelector('h4');
            if (!h4) return;
            section.classList.add('collapsible');
            const title = h4.textContent.trim();
            const key = title;

            let body = section.querySelector(':scope > .section-body');
            if (!body) {
                body = document.createElement('div');
                body.className = 'section-body';
                const children = Array.from(section.children).filter(el => el !== h4);
                children.forEach(el => body.appendChild(el));
                section.appendChild(body);
            }

            const isOpen = Object.prototype.hasOwnProperty.call(saved, key) ? !!saved[key] : !!defaultOpen[title];
            body.style.display = isOpen ? 'block' : 'none';
            section.classList.toggle('collapsed', !isOpen);

            h4.addEventListener('click', () => {
                const nowOpen = section.classList.contains('collapsed');
                section.classList.toggle('collapsed', !nowOpen);
                body.style.display = nowOpen ? 'block' : 'none';
                saved[key] = nowOpen;
                try {
                    localStorage.setItem('retirePlanner_sectionState', JSON.stringify(saved));
                } catch (e) {}
            });
        });
    }

    function getNormalizedOutcomeWeights() {
        const wTax = Math.max(0, parseFloat(document.getElementById('wTax').value) || 0);
        const wOas = Math.max(0, parseFloat(document.getElementById('wOas').value) || 0);
        const wEstate = Math.max(0, parseFloat(document.getElementById('wEstate').value) || 0);
        const wSuccess = Math.max(0, parseFloat(document.getElementById('wSuccess').value) || 0);
        const sum = wTax + wOas + wEstate + wSuccess;
        if (sum <= 0) return { wTax: 0.25, wOas: 0.25, wEstate: 0.25, wSuccess: 0.25 };
        return { wTax: wTax / sum, wOas: wOas / sum, wEstate: wEstate / sum, wSuccess: wSuccess / sum };
    }

    function updateSpendingModeVisibility() {
        const mode = document.getElementById('spendingMode').value;
        const targetEl = document.getElementById('targetSuccessGroup');
        const precisionEl = document.getElementById('solvePrecisionGroup');
        const scheduleWrap = document.getElementById('spendingScheduleContainer');
        const scheduleNote = document.getElementById('spendingScheduleSolveNote');
        const scheduleStatus = document.getElementById('spendingScheduleStatus');
        const spendingInput = document.getElementById('spending');
        const spendingLabel = document.getElementById('spendingLabel');
        const spendingInputGroup = document.getElementById('spendingInputGroup');
        const spendingHelp = document.getElementById('spendingModeHelp');
        const toggle = document.getElementById('spendingModeToggle');
        const visible = mode === 'solve';

        if (toggle) {
            toggle.querySelectorAll('button[data-mode]').forEach(btn => {
                btn.classList.toggle('active', btn.dataset.mode === mode);
            });
        }

        if (targetEl) targetEl.style.display = visible ? 'block' : 'none';
        if (precisionEl) precisionEl.style.display = visible ? 'block' : 'none';
        if (scheduleWrap) scheduleWrap.style.display = visible ? 'none' : 'block';
        if (scheduleNote) scheduleNote.style.display = visible ? 'block' : 'none';
        if (scheduleStatus) scheduleStatus.style.display = visible ? 'none' : 'block';
        if (spendingInput) {
            spendingInput.readOnly = visible;
            spendingInput.style.backgroundColor = visible ? '#f1f5f9' : '#fff';
            spendingInput.style.cursor = visible ? 'not-allowed' : 'text';
        }
        if (spendingLabel) spendingLabel.innerText = visible ? 'Solved Net Spend/Yr' : 'Desired Net Spend/Yr';
        if (spendingInputGroup) spendingInputGroup.style.opacity = visible ? '0.9' : '1';
        if (spendingHelp) spendingHelp.innerText = visible ? 'Solves a flat spend to hit your MC success target.' : 'Uses your entered spend.';
    }

    function replaceWithFlatScheduleFromCurrentSpend(spendOverride = null) {
        const container = document.getElementById('spendingScheduleRows');
        if (!container) return;
        const currentAge = parseInt(document.getElementById('age').value) || 60;
        const lifeExpectancy = Math.max(currentAge, Math.min(120, parseInt(document.getElementById('lifeExpectancy').value) || 100));
        const spend = Number.isFinite(spendOverride) ? spendOverride : (parseFloat(document.getElementById('spending').value) || 0);
        container.innerHTML = '';
        container.appendChild(createSpendingScheduleRow(currentAge, lifeExpectancy, Math.round(spend)));
        saveSpendingSchedule();
    }

    function scheduleDiffersFromFlatCurrentSpend(spendOverride = null) {
        const rows = Array.from(document.querySelectorAll('#spendingScheduleRows .spending-row'));
        const currentAge = parseInt(document.getElementById('age').value) || 60;
        const lifeExpectancy = Math.max(currentAge, Math.min(120, parseInt(document.getElementById('lifeExpectancy').value) || 100));
        const spend = Math.round(Number.isFinite(spendOverride) ? spendOverride : (parseFloat(document.getElementById('spending').value) || 0));

        if (rows.length !== 1) return true;

        const row = rows[0];
        const start = parseInt(row.querySelector('.sched-start').value);
        const end = parseInt(row.querySelector('.sched-end').value);
        const amount = Math.round(parseFloat(row.querySelector('.sched-amount').value) || 0);

        if (!Number.isFinite(start) || !Number.isFinite(end) || !Number.isFinite(amount)) return true;
        return !(start === currentAge && end === lifeExpectancy && amount === spend);
    }

    function updateUI(results, monteCarloResults, monteCarloEnabled, monteCarloStale, monteCarloMeta, solvedSpendOutput, targetSuccessRate, spendingMode, selectedStrategy, effectiveStrategy) {
        const displayInflated = document.getElementById('displayMode').checked;
        const inflation = parseFloat(document.getElementById('inflation').value) / 100;
        
        const adj = (val, idx) => displayInflated ? val : val / Math.pow(1 + inflation, idx);

        const strSuffix = displayInflated ? "(Inflated/Nominal Dollars)" : "(Today's Dollars)";
        const mcSuffix = monteCarloEnabled ? ' - Baseline Path' : '';
        document.getElementById('chart1Title').innerText = `Asset Balances Over Time ${strSuffix}${mcSuffix}`;
        document.getElementById('chart2Title').innerText = `Gross Income Sources vs Net Target ${strSuffix}${mcSuffix}`;
        document.getElementById('tableSubtitle').innerText = strSuffix;
        document.getElementById('summarySubtitle').innerText = strSuffix;

        // --- TABLE ---
        const tbody = document.getElementById('tableBody');
        tbody.innerHTML = '';
        
        results.forEach(r => {
            const tr = document.createElement('tr');
            if (r.depleted) tr.classList.add('depleted');
            
            tr.innerHTML = `
                <td>${r.age}</td>
                <td>${formatCurrency(adj(r.spending, r.yearIndex))} ${r.depleted ? '<br><small style="color:red;">(Shortfall)</small>' : ''}</td>
                <td>${formatCurrency(adj(r.cpp, r.yearIndex))}</td>
                <td>${formatCurrency(adj(r.oas, r.yearIndex))}</td>
                <td>${formatCurrency(adj(r.drawRRSP, r.yearIndex))}</td>
                <td>${formatCurrency(adj(r.drawTFSA, r.yearIndex))}</td>
                <td>${formatCurrency(adj(r.drawNonReg, r.yearIndex))}</td>
                <td style="color:#ef4444;">${formatCurrency(adj(r.incomeTax, r.yearIndex))}</td>
                <td style="color:#ef4444;">${formatCurrency(adj(r.oasClawback, r.yearIndex))}</td>
                <td>${formatCurrency(adj(r.rrsp, r.yearIndex))}</td>
                <td>${formatCurrency(adj(r.tfsa, r.yearIndex))}</td>
                <td>${formatCurrency(adj(r.nonreg, r.yearIndex))}<br><small style="color:#64748b;">(ACB: ${formatCurrency(adj(r.acb, r.yearIndex))})</small></td>
                <td class="text-bold">${formatCurrency(adj(r.total, r.yearIndex))}</td>
            `;
            tbody.appendChild(tr);
        });

        // --- SUMMARY ---
        let totRRSP = 0, totTFSA = 0, totNonReg = 0, totCPP = 0, totOAS = 0, totTax = 0, totClawback = 0;
        results.forEach(r => {
            totRRSP += adj(r.drawRRSP, r.yearIndex);
            totTFSA += adj(r.drawTFSA, r.yearIndex);
            totNonReg += adj(r.drawNonReg, r.yearIndex);
            totCPP += adj(r.cpp, r.yearIndex);
            totOAS += adj(r.oas, r.yearIndex);
            totTax += adj(r.incomeTax, r.yearIndex);
            totClawback += adj(r.oasClawback, r.yearIndex);
        });

        const finalRow = results[results.length - 1];
        const finalEstate = adj(finalRow.total, finalRow.yearIndex);
        const depleted = finalRow.depleted;
        
        document.getElementById('summaryGrid').innerHTML = `
            <div class="summary-box ${depleted ? 'alert' : 'highlight'}">
                <div class="summary-title">${depleted ? 'Depleted At Age' : 'Final Estate Value (Age ' + finalRow.age + ')'}</div>
                <div class="summary-value">${depleted ? finalRow.age : formatCurrency(finalEstate)}</div>
            </div>
            <div class="summary-box">
                <div class="summary-title">Total Portfolio Drawn</div>
                <div class="summary-value">${formatCurrency(totRRSP + totTFSA + totNonReg)}</div>
            </div>
            <div class="summary-box">
                <div class="summary-title">Total CPP + OAS (Gross)</div>
                <div class="summary-value">${formatCurrency(totCPP + totOAS)}</div>
            </div>
            <div class="summary-box alert">
                <div class="summary-title">Total Income Tax Paid</div>
                <div class="summary-value">${formatCurrency(totTax)}</div>
            </div>
            <div class="summary-box alert">
                <div class="summary-title">Total OAS Clawback</div>
                <div class="summary-value">${formatCurrency(totClawback)}</div>
            </div>
        `;

        const existing = document.getElementById('optimizedStrategyNote');
        if (existing) existing.remove();
        if (selectedStrategy === 'outcome-based') {
            const note = document.createElement('div');
            note.id = 'optimizedStrategyNote';
            note.style.marginTop = '10px';
            note.style.fontSize = '0.82rem';
            note.style.color = '#475569';
            note.innerText = 'Outcome-based mode constructs a deterministic year-by-year draw mix from your weight settings.';
            document.getElementById('summaryGrid').after(note);
        }

        const mcEl = document.getElementById('mcSummary');
        if (monteCarloEnabled && monteCarloResults) {
            const failRate = 1 - monteCarloResults.successRate;
            const depText = monteCarloResults.medianDepletionAge === null ? 'No depletion in failed paths' : `Age ${Math.round(monteCarloResults.medianDepletionAge)}`;
            const runAt = monteCarloMeta && monteCarloMeta.runAtIso ? new Date(monteCarloMeta.runAtIso).toLocaleString() : 'Unknown';
            const seedText = monteCarloMeta && monteCarloMeta.seed !== null ? monteCarloMeta.seed : 'Random';
            const staleLine = monteCarloStale ? '<span style="color:#b45309; font-weight:600;">Results are from a previous run. Click Run Simulation to refresh.</span>' : '<span style="color:#166534;">Results are current with shown inputs.</span>';
            const partialLine = monteCarloResults.cancelled ? `<span style="color:#b45309; font-weight:600;">Partial run: ${monteCarloResults.trials.toLocaleString()} / ${monteCarloResults.requestedTrials.toLocaleString()} trials completed.</span>` : '';
            const solvedLine = (spendingMode === 'solve' && solvedSpendOutput) ? `Solved sustainable spend (today's dollars): ${formatCurrency(solvedSpendOutput)} at ${(targetSuccessRate * 100).toFixed(0)}% target success` : '';
            mcEl.innerHTML = [
                '<strong>Monte Carlo Summary:</strong>',
                `Trials completed: ${monteCarloResults.trials.toLocaleString()} / ${monteCarloResults.requestedTrials.toLocaleString()}`,
                `Success probability: ${(monteCarloResults.successRate * 100).toFixed(1)}%`,
                `Failure probability: ${(failRate * 100).toFixed(1)}%`,
                `Median depletion age (failed paths): ${depText}`,
                `Final estate (P10 / Median / P90): ${formatCurrency(monteCarloResults.p10FinalEstate)} / ${formatCurrency(monteCarloResults.medianFinalEstate)} / ${formatCurrency(monteCarloResults.p90FinalEstate)}`,
                `Avg lifetime tax / clawback: ${formatCurrency(monteCarloResults.avgTax)} / ${formatCurrency(monteCarloResults.avgClawback)}`,
                `Last run: ${runAt}`,
                `Settings used (trials / return vol / inflation vol / seed): ${(monteCarloMeta?.trials ?? monteCarloResults.trials).toLocaleString()} / ${((monteCarloMeta?.returnVolatility ?? 0) * 100).toFixed(1)}% / ${((monteCarloMeta?.inflationVolatility ?? 0) * 100).toFixed(1)}% / ${seedText}`,
                solvedLine,
                partialLine,
                staleLine
            ].join('<br>');
            mcEl.style.display = 'block';
        } else {
            mcEl.style.display = 'none';
            mcEl.innerHTML = '';
        }

        if (monteCarloEnabled) {
            renderMonteCarloOutcomeChart(monteCarloResults);
            renderMonteCarloPercentileChart(monteCarloResults);
        } else {
            renderMonteCarloOutcomeChart(null);
            renderMonteCarloPercentileChart(null);
        }

        const debugMode = document.getElementById('debugMode').value;
        const debugEl = document.getElementById('debugSummary');
        if (debugMode === 'on' || debugMode === 'table') {
            let maxTaxable = 0;
            let maxShortfall = 0;
            let maxClawbackIterations = 0;
            let yearsWithClawback = 0;
            let yearsWithMandatoryRrif = 0;
            let totalMandatoryRrif = 0;

            results.forEach(r => {
                if (r.taxableIncome > maxTaxable) maxTaxable = r.taxableIncome;
                if (r.netShortfall > maxShortfall) maxShortfall = r.netShortfall;
                if (r.clawbackIterations > maxClawbackIterations) maxClawbackIterations = r.clawbackIterations;
                if (r.oasClawback > 0) yearsWithClawback++;
                if (r.mandatoryRrifDraw > 0) yearsWithMandatoryRrif++;
                totalMandatoryRrif += adj(r.mandatoryRrifDraw, r.yearIndex);
            });

            const finalRowDebug = results[results.length - 1];
            const debugLines = [
                `<strong>Debug Summary:</strong>`,
                `Max taxable income in any year: ${formatCurrency(adj(maxTaxable, 0))}`,
                `Years with OAS clawback: ${yearsWithClawback}`,
                `Years with mandatory RRIF draw: ${yearsWithMandatoryRrif}`,
                `Total mandatory RRIF draw: ${formatCurrency(totalMandatoryRrif)}`,
                `Max OAS clawback iterations used in a year: ${maxClawbackIterations}`,
                `Ending-year unmet net need: ${formatCurrency(adj(finalRowDebug.netShortfall, finalRowDebug.yearIndex))}`,
                `Max unmet net need in any year: ${formatCurrency(adj(maxShortfall, 0))}`
            ];

            if (debugMode === 'table') {
                const rows = results.map(r => `
                    <tr>
                        <td style="text-align:center;">${r.age}</td>
                        <td>${formatCurrency(adj(r.taxableIncome, r.yearIndex))}</td>
                        <td>${formatCurrency(adj(r.mandatoryRrifDraw, r.yearIndex))}</td>
                        <td>${formatCurrency(adj(r.oasClawback, r.yearIndex))}</td>
                        <td style="text-align:center;">${(r.mixTFSA === null || r.mixNonReg === null || r.mixRRSP === null) ? '-' : `${Math.round(r.mixTFSA * 100)} / ${Math.round(r.mixNonReg * 100)} / ${Math.round(r.mixRRSP * 100)}`}</td>
                        <td style="text-align:center;">${r.clawbackIterations}</td>
                        <td>${formatCurrency(adj(r.netShortfall, r.yearIndex))}</td>
                    </tr>
                `).join('');

                debugLines.push(
                    `<div style="margin-top:10px; overflow-x:auto;">` +
                    `<table style="width:100%; border-collapse:collapse; font-size:0.82rem; white-space:nowrap;">` +
                    `<thead><tr>` +
                    `<th style="text-align:center; border-bottom:1px solid #cbd5e1; padding:6px;">Age</th>` +
                    `<th style="text-align:right; border-bottom:1px solid #cbd5e1; padding:6px;">Taxable Income</th>` +
                    `<th style="text-align:right; border-bottom:1px solid #cbd5e1; padding:6px;">RRIF Min Draw</th>` +
                    `<th style="text-align:right; border-bottom:1px solid #cbd5e1; padding:6px;">OAS Clawback</th>` +
                    `<th style="text-align:center; border-bottom:1px solid #cbd5e1; padding:6px;">Mix % (T/N/R)</th>` +
                    `<th style="text-align:center; border-bottom:1px solid #cbd5e1; padding:6px;">Iterations</th>` +
                    `<th style="text-align:right; border-bottom:1px solid #cbd5e1; padding:6px;">Unmet Net Need</th>` +
                    `</tr></thead>` +
                    `<tbody>${rows}</tbody>` +
                    `</table>` +
                    `</div>`
                );
            }

            debugEl.innerHTML = debugLines.join('<br>');
            debugEl.style.display = 'block';
        } else {
            debugEl.style.display = 'none';
            debugEl.innerHTML = '';
        }

        // --- CHARTS ---
        const labels = results.map(r => r.age);
        const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

        const sharedOptions = {
            responsive: true, maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: { tooltip: { callbacks: { label: function(ctx) {
                let label = ctx.dataset.label || ''; if (label) label += ': ';
                if (ctx.parsed.y !== null) label += new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD', maximumFractionDigits: 0 }).format(ctx.parsed.y);
                return label;
            }}}},
            scales: { x: { stacked: true }, y: { stacked: true, ticks: { callback: function(v) { return '$' + v.toLocaleString(); } } } }
        };

        if (balanceChartInst) balanceChartInst.destroy();
        balanceChartInst = new Chart(document.getElementById('balanceChart').getContext('2d'), {
            type: 'bar',
            data: {
                labels: labels,
                datasets:[
                    { label: 'RRSP', data: results.map(r => adj(r.rrsp, r.yearIndex)), backgroundColor: cssVar('--color-rrsp') },
                    { label: 'TFSA', data: results.map(r => adj(r.tfsa, r.yearIndex)), backgroundColor: cssVar('--color-tfsa') },
                    { label: 'Non-Reg', data: results.map(r => adj(r.nonreg, r.yearIndex)), backgroundColor: cssVar('--color-nonreg') }
                ]
            }, options: { ...sharedOptions }
        });

        if (incomeChartInst) incomeChartInst.destroy();
        incomeChartInst = new Chart(document.getElementById('incomeChart').getContext('2d'), {
            type: 'bar',
            data: {
                labels: labels,
                datasets:[
                    { 
                        type: 'line', 
                        label: 'Net Spend Goal', 
                        data: results.map(r => adj(r.spending, r.yearIndex)), 
                        borderColor: '#1e293b', 
                        borderWidth: 2, 
                        borderDash: [5, 5],
                        fill: false, 
                        pointRadius: 0,
                        order: 0 
                    },
                    { label: 'CPP', data: results.map(r => adj(r.cpp, r.yearIndex)), backgroundColor: cssVar('--color-cpp'), order: 1 },
                    { label: 'OAS', data: results.map(r => adj(r.oas, r.yearIndex)), backgroundColor: cssVar('--color-oas'), order: 1 },
                    { label: 'RRSP Draw', data: results.map(r => adj(r.drawRRSP, r.yearIndex)), backgroundColor: cssVar('--color-rrsp'), order: 1 },
                    { label: 'TFSA Draw', data: results.map(r => adj(r.drawTFSA, r.yearIndex)), backgroundColor: cssVar('--color-tfsa'), order: 1 },
                    { label: 'Non-Reg Draw', data: results.map(r => adj(r.drawNonReg, r.yearIndex)), backgroundColor: cssVar('--color-nonreg'), order: 1 }
                ]
            }, options: { ...sharedOptions }
        });
    }

    // --- INITIALIZATION ---
    setupCollapsibleSections();
    loadInputs();
    loadSpendingSchedule();
    updateMonteCarloSettingsVisibility();
    updateSpendingModeVisibility();
    updateOutcomeSettingsVisibility();

    const outcomePresetEl = document.getElementById('outcomePreset');
    if (outcomePresetEl) {
        applyOutcomePreset(outcomePresetEl.value);
        updateOutcomePresetLockState();
        outcomePresetEl.addEventListener('change', () => {
            suppressInputChangeRecalc = true;
            applyOutcomePreset(outcomePresetEl.value);
            updateOutcomePresetLockState();
            saveInputs();
            const advancedMix = document.getElementById('strategyMode')?.value === 'advanced';
            if (advancedMix) deferOutcomeBasedExecutionNotice();
            else recalculateForUiChange();
            setTimeout(() => { suppressInputChangeRecalc = false; }, 0);
        });
    }

    const spendingModeToggle = document.getElementById('spendingModeToggle');
    if (spendingModeToggle) {
        spendingModeToggle.addEventListener('click', (e) => {
            const btn = e.target.closest('button[data-mode]');
            if (!btn) return;
            const modeInput = document.getElementById('spendingMode');
            if (!modeInput) return;
            const prevMode = modeInput.value;
            modeInput.value = btn.dataset.mode;

            if (prevMode === 'input' && modeInput.value === 'solve') {
                const spendEl = document.getElementById('spending');
                const val = spendEl ? parseFloat(spendEl.value) : NaN;
                desiredSpendBeforeSolve = Number.isFinite(val) ? val : desiredSpendBeforeSolve;
            }

            if (prevMode === 'solve' && modeInput.value === 'input') {
                const spendEl = document.getElementById('spending');
                const solvedSpend = Number.isFinite(lastSolvedSpend) ? lastSolvedSpend : (parseFloat(spendEl?.value) || 0);
                const desiredSpend = Number.isFinite(desiredSpendBeforeSolve) ? desiredSpendBeforeSolve : solvedSpend;

                if (spendEl && Number.isFinite(solvedSpend) && Math.round(desiredSpend) !== Math.round(solvedSpend)) {
                    const applySolvedEverywhere = window.confirm('Your previous desired spend differs from the solved spend.\n\nDo you want to update BOTH Desired Net Spend/Yr and the spending schedule to the solved value for a like-for-like comparison?');
                    if (applySolvedEverywhere) {
                        spendEl.value = Math.round(solvedSpend);
                        replaceWithFlatScheduleFromCurrentSpend(solvedSpend);
                    } else {
                        spendEl.value = Math.round(desiredSpend);
                    }
                } else if (spendEl) {
                    spendEl.value = Math.round(desiredSpend);
                }
            }

            updateSpendingModeVisibility();
            saveInputs();
            recalculateForUiChange();
        });
    }

    const schedContainer = document.getElementById('spendingScheduleRows');
    const addSchedBtn = document.getElementById('addSpendingRow');
    if (addSchedBtn) {
        addSchedBtn.addEventListener('click', () => {
            const lastRow = schedContainer.querySelector('.spending-row:last-child');
            let nextStart = parseInt(document.getElementById('age').value) || 60;
            const lifeExpectancy = parseInt(document.getElementById('lifeExpectancy').value) || 100;
            let nextAmount = parseFloat(document.getElementById('spending').value) || 60000;
            if (lastRow) {
                const prevEnd = parseInt(lastRow.querySelector('.sched-end').value);
                const prevAmt = parseFloat(lastRow.querySelector('.sched-amount').value);
                if (Number.isFinite(prevEnd)) nextStart = Math.min(prevEnd + 1, lifeExpectancy);
                if (Number.isFinite(prevAmt)) nextAmount = prevAmt;
            }
            schedContainer.appendChild(createSpendingScheduleRow(nextStart, lifeExpectancy, nextAmount));
            saveSpendingSchedule();
            recalculateForUiChange();
        });
    }

    if (schedContainer) {
        schedContainer.addEventListener('click', (e) => {
            if (e.target.classList.contains('remove-spending-row')) {
                const rows = schedContainer.querySelectorAll('.spending-row');
                if (rows.length <= 1) return;
                e.target.closest('.spending-row').remove();
                saveSpendingSchedule();
                recalculateForUiChange();
            }
        });

        schedContainer.addEventListener('change', (e) => {
            if (e.target.classList.contains('sched-start') || e.target.classList.contains('sched-end') || e.target.classList.contains('sched-amount')) {
                saveSpendingSchedule();
                recalculateForUiChange();
            }
        });
    }
    
    // Bind all inputs safely inside the script, avoiding global scope issues
    inputIds.forEach(id => {
        const el = document.getElementById(id);
        if(el) el.addEventListener('change', () => {
            if (suppressInputChangeRecalc) return;
            if (id === 'enableMonteCarlo') updateMonteCarloSettingsVisibility();
            if (id === 'strategy' || id === 'strategyMode') updateOutcomeSettingsVisibility();
            if (id === 'spendingMode') updateSpendingModeVisibility();

            if (id === 'strategyMode' && document.getElementById('strategyMode')?.value === 'advanced') {
                saveInputs();
                deferOutcomeBasedExecutionNotice();
                return;
            }

            if (id === 'age' || id === 'spending' || id === 'lifeExpectancy') {
                const rows = document.querySelectorAll('#spendingScheduleRows .spending-row');
                if (rows.length === 1) {
                    const r = rows[0];
                    if (id === 'age') r.querySelector('.sched-start').value = el.value;
                    if (id === 'spending') r.querySelector('.sched-amount').value = el.value;
                    if (id === 'lifeExpectancy') r.querySelector('.sched-end').value = el.value;
                    saveSpendingSchedule();
                }
            }

            const advancedMix = document.getElementById('strategyMode')?.value === 'advanced';
            const outcomeSettingIds = ['wTax', 'wOas', 'wEstate', 'wSuccess', 'outcomePreset', 'requireMinSuccess', 'minSuccess'];
            if (advancedMix && outcomeSettingIds.includes(id)) {
                saveInputs();
                deferOutcomeBasedExecutionNotice();
                return;
            }

            recalculateForUiChange();
        });
    });

    // Bind the button
    const runBtn = document.getElementById('calcBtn');
    if(runBtn) runBtn.addEventListener('click', () => calculateRetirement(true));
    const stopBtn = document.getElementById('stopBtn');
    if (stopBtn) {
        stopBtn.addEventListener('click', () => {
            if (!mcIsRunning) return;
            mcCancelRequested = true;
            const runStatusEl = document.getElementById('runStatus');
            if (runStatusEl) {
                runStatusEl.style.color = '#b45309';
                runStatusEl.innerText = 'Stopping Monte Carlo after current batch...';
            }
        });
    }

    // Run initial calculation (skip heavy advanced auto-run)
    const initialAdvancedMode = document.getElementById('strategyMode')?.value === 'advanced';
    if (initialAdvancedMode) {
        deferOutcomeBasedExecutionNotice();
    } else {
        calculateRetirement(false);
    }
});
