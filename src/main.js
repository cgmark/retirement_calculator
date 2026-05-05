import Chart from "chart.js/auto";
import { runMonteCarlo } from "./core/monteCarlo.js";
import {
  sanitizeScheduleRows,
  normalizeScheduleRows,
  getScheduleValidationError,
  buildFlatSchedule,
} from "./core/spending.js";
import { runDeterministicProjection } from "./core/projection.js";
import { solveSustainableSpending } from "./core/solveSpending.js";
import { readScenarioInputs } from "./core/inputs.js";
import { runRetirementCalculation } from "./core/calculateRetirement.js";

document.addEventListener("DOMContentLoaded", () => {
  // UI-level state: keep long-running calc/MC interactions responsive and cancellable.
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

  const inputIds = [
    "displayMode",
    "debugMode",
    "age",
    "spending",
    "spendingMode",
    "targetSuccess",
    "solvePrecision",
    "lifeExpectancy",
    "inflation",
    "growth",
    "province",
    "rrsp",
    "tfsa",
    "nonreg",
    "nonregAcb",
    "cpp60",
    "cpp65",
    "cpp70",
    "cppScenario",
    "oasPercent",
    "rrifStartAge",
    "enforceRrifMin",
    "strategy",
    "strategyMode",
    "enableMonteCarlo",
    "mcTrials",
    "mcVolatility",
    "mcInflationVolatility",
    "mcBadYearSpendCut",
    "mcSeed",
    "wTax",
    "wOas",
    "wEstate",
    "wSuccess",
    "outcomePreset",
    "requireMinSuccess",
    "minSuccess",
  ];

  const formatCurrency = (num) => {
    if (num === 0 || Math.abs(num) < 0.5) return "-";
    return new Intl.NumberFormat("en-CA", {
      style: "currency",
      currency: "CAD",
      maximumFractionDigits: 0,
    }).format(num);
  };

  function saveInputs() {
    try {
      // Persist every control so refresh/revisit restores the last scenario quickly.
      inputIds.forEach((id) => {
        const el = document.getElementById(id);
        if (el) {
          const v = el.type === "checkbox" ? String(el.checked) : el.value;
          localStorage.setItem(`retirePlanner_${id}`, v);
        }
      });
    } catch (e) {
      console.warn("Local storage unavailable", e);
    }
  }

  function loadInputs() {
    try {
      inputIds.forEach((id) => {
        const val = localStorage.getItem(`retirePlanner_${id}`);
        const el = document.getElementById(id);
        if (val !== null && el) {
          if (el.type === "checkbox") el.checked = val === "true";
          else el.value = val;
        }
      });
    } catch (e) {
      console.warn("Local storage unavailable", e);
    }
  }

  function createSpendingScheduleRow(startAge, endAge, amount) {
    const row = document.createElement("div");
    row.className = "spending-row";
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
      const rows = Array.from(
        document.querySelectorAll("#spendingScheduleRows .spending-row"),
      ).map((row) => ({
        startAge: parseInt(row.querySelector(".sched-start").value),
        endAge: parseInt(row.querySelector(".sched-end").value),
        amount: parseFloat(row.querySelector(".sched-amount").value),
      }));
      localStorage.setItem(
        "retirePlanner_spendingSchedule",
        JSON.stringify(rows),
      );
    } catch (e) {
      console.warn("Local storage unavailable", e);
    }
  }

  function loadSpendingSchedule() {
    const container = document.getElementById("spendingScheduleRows");
    container.innerHTML = "";

    let rows = null;
    try {
      const raw = localStorage.getItem("retirePlanner_spendingSchedule");
      if (raw) rows = JSON.parse(raw);
    } catch (e) {
      console.warn("Spending schedule load failed", e);
    }

    if (!Array.isArray(rows) || rows.length === 0) {
      // First run/default fallback: seed schedule from current headline inputs.
      const currentAge = parseInt(document.getElementById("age").value) || 60;
      const lifeExpectancy =
        parseInt(document.getElementById("lifeExpectancy").value) || 100;
      const spend =
        parseFloat(document.getElementById("spending").value) || 60000;
      container.appendChild(
        createSpendingScheduleRow(currentAge, lifeExpectancy, spend),
      );
      return;
    }

    sanitizeScheduleRows(rows).forEach((r) => {
      const startAge = r.startAge;
      const endAge = r.endAge;
      const amount = r.amount;
      container.appendChild(
        createSpendingScheduleRow(startAge, endAge, amount),
      );
    });
  }

  function getValidatedSpendingSchedule() {
    // This is the UI-facing wrapper around core schedule normalization/validation.
    // It translates validation outcomes into user-readable status text.
    const statusEl = document.getElementById("spendingScheduleStatus");
    const currentAge = parseInt(document.getElementById("age").value) || 60;
    const lifeExpectancy = Math.max(
      currentAge,
      Math.min(
        120,
        parseInt(document.getElementById("lifeExpectancy").value) || 100,
      ),
    );
    const rawRows = Array.from(
      document.querySelectorAll("#spendingScheduleRows .spending-row"),
    ).map((row) => ({
      startAge: parseInt(row.querySelector(".sched-start").value),
      endAge: parseInt(row.querySelector(".sched-end").value),
      amount: parseFloat(row.querySelector(".sched-amount").value),
    }));

    const { cleaned, wasClamped } = normalizeScheduleRows(
      rawRows,
      currentAge,
      lifeExpectancy,
    );
    if (cleaned.length === 0) {
      statusEl.style.color = "#b91c1c";
      statusEl.innerText =
        "No valid schedule rows found. Using default Desired Net Spend/Yr.";
      return [];
    }

    const validationError = getScheduleValidationError(cleaned);
    if (validationError === "invalid-range") {
      statusEl.style.color = "#b91c1c";
      statusEl.innerText =
        "Each row needs Start Age <= End Age. Using default Desired Net Spend/Yr.";
      return [];
    }
    if (validationError === "overlap") {
      statusEl.style.color = "#b91c1c";
      statusEl.innerText =
        "Spending schedule rows overlap. Using default Desired Net Spend/Yr.";
      return [];
    }

    if (wasClamped) {
      const rowEls = Array.from(
        document.querySelectorAll("#spendingScheduleRows .spending-row"),
      );
      cleaned.forEach((r, idx) => {
        const rowEl = rowEls[idx];
        if (!rowEl) return;
        rowEl.querySelector(".sched-start").value = r.startAge;
        rowEl.querySelector(".sched-end").value = r.endAge;
      });
      saveSpendingSchedule();
      statusEl.style.color = "#b45309";
      statusEl.innerText = `Schedule ages were clamped to current age (${currentAge}) and life expectancy (${lifeExpectancy}).`;
      return cleaned;
    }

    statusEl.style.color = "#166534";
    statusEl.innerText = `Using ${cleaned.length} spending phase${cleaned.length === 1 ? "" : "s"} through age ${lifeExpectancy}.`;
    return cleaned;
  }

  function renderMonteCarloOutcomeChart(monteCarloResults) {
    const mcCard = document.getElementById("mcOutcomeCard");
    const mcSubtitle = document.getElementById("mcChartSubtitle");
    if (!mcCard || !mcSubtitle) return;

    if (
      !monteCarloResults ||
      !monteCarloResults.trials ||
      monteCarloResults.trials <= 0
    ) {
      if (mcOutcomeChartInst) {
        mcOutcomeChartInst.destroy();
        mcOutcomeChartInst = null;
      }
      mcCard.style.display = "none";
      mcSubtitle.innerText = "";
      return;
    }

    mcCard.style.display = "block";
    const bucketLabels = monteCarloResults.bucketLabels || [];
    const counts = bucketLabels.map(
      (l) => monteCarloResults.bucketCounts?.[l] || 0,
    );
    const percents = counts.map((c) => (c / monteCarloResults.trials) * 100);
    mcSubtitle.innerText = `Based on ${monteCarloResults.trials.toLocaleString()} / ${monteCarloResults.requestedTrials.toLocaleString()} trials${monteCarloResults.cancelled ? " (partial run)" : ""}`;

    if (!mcOutcomeChartInst) {
      mcOutcomeChartInst = new Chart(
        document.getElementById("mcOutcomeChart").getContext("2d"),
        {
          type: "bar",
          data: {
            labels: bucketLabels,
            datasets: [
              {
                label: "Trial Share (%)",
                data: percents,
                backgroundColor: bucketLabels.map((l) =>
                  l.includes("(Success)") ? "#16a34a" : "#f59e0b",
                ),
              },
            ],
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: false,
            plugins: {
              tooltip: {
                callbacks: {
                  label: (ctx) =>
                    `${ctx.parsed.y.toFixed(1)}% (${counts[ctx.dataIndex].toLocaleString()} trials)`,
                },
              },
            },
            scales: {
              x: { ticks: { maxRotation: 0, minRotation: 0 } },
              y: { beginAtZero: true, ticks: { callback: (v) => `${v}%` } },
            },
          },
        },
      );
      return;
    }

    mcOutcomeChartInst.data.labels = bucketLabels;
    mcOutcomeChartInst.data.datasets[0].data = percents;
    mcOutcomeChartInst.data.datasets[0].backgroundColor = bucketLabels.map(
      (l) => (l.includes("(Success)") ? "#16a34a" : "#f59e0b"),
    );
    mcOutcomeChartInst.options.plugins.tooltip.callbacks.label = (ctx) =>
      `${ctx.parsed.y.toFixed(1)}% (${counts[ctx.dataIndex].toLocaleString()} trials)`;
    mcOutcomeChartInst.update("none");
  }

  function renderMonteCarloPercentileChart(monteCarloResults) {
    const card = document.getElementById("mcPercentileCard");
    const subtitle = document.getElementById("mcPercentileSubtitle");
    if (!card || !subtitle) return;

    if (
      !monteCarloResults ||
      !monteCarloResults.trials ||
      !monteCarloResults.ageLabels?.length
    ) {
      if (mcPercentileChartInst) {
        mcPercentileChartInst.destroy();
        mcPercentileChartInst = null;
      }
      card.style.display = "none";
      subtitle.innerText = "";
      return;
    }

    card.style.display = "block";
    const displayInflated = document.getElementById("displayMode").checked;
    const baseInflation =
      parseFloat(document.getElementById("inflation").value) / 100;
    subtitle.innerText = `Based on ${monteCarloResults.trials.toLocaleString()} / ${monteCarloResults.requestedTrials.toLocaleString()} trials${monteCarloResults.cancelled ? " (partial run)" : ""}. P10 means 10% of paths were below this level. Values shown in ${displayInflated ? "inflated/nominal" : "today's"} dollars.`;

    const labels = monteCarloResults.ageLabels;
    const adjustSeries = (series) =>
      (series || []).map((v, idx) => {
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
        label: "P10",
        data: p10,
        borderColor: "#f59e0b",
        borderWidth: 1.2,
        pointRadius: 0,
        fill: false,
      },
    ];

    datasets.push(
      {
        label: "P25",
        data: p25,
        borderColor: "#0ea5a4",
        borderWidth: 1.2,
        pointRadius: 0,
        fill: false,
      },
      {
        label: "P75",
        data: p75,
        borderColor: "#0ea5a4",
        borderWidth: 1.2,
        pointRadius: 0,
        fill: "-1",
        backgroundColor: "rgba(14,165,164,0.18)",
      },
    );

    datasets.push(
      {
        label: "P50",
        data: p50,
        borderColor: "#0f766e",
        borderWidth: 2.5,
        pointRadius: 0,
        fill: false,
      },
      {
        label: "P90",
        data: p90,
        borderColor: "#2563eb",
        borderWidth: 1.2,
        pointRadius: 0,
        fill: "-1",
        backgroundColor: "rgba(37,99,235,0.10)",
      },
    );

    const data = { labels, datasets };

    const options = {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        tooltip: {
          callbacks: {
            label: (ctx) =>
              `${ctx.dataset.label}: ${new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD", maximumFractionDigits: 0 }).format(ctx.parsed.y)}`,
          },
        },
      },
      scales: {
        y: {
          ticks: { callback: (v) => "$" + Number(v).toLocaleString() },
        },
      },
    };

    if (!mcPercentileChartInst) {
      mcPercentileChartInst = new Chart(
        document.getElementById("mcPercentileChart").getContext("2d"),
        {
          type: "line",
          data,
          options,
        },
      );
      return;
    }

    mcPercentileChartInst.data = data;
    mcPercentileChartInst.options = options;
    mcPercentileChartInst.update("none");
  }

  async function calculateRetirement(runMonteCarloNow = true) {
    if (recalcTimer) {
      clearTimeout(recalcTimer);
      recalcTimer = null;
    }
    // Coalesce rapid UI changes: if a run is in-flight, queue only one rerun flag.
    if (isRecalculating) {
      queuedRecalc = runMonteCarloNow || queuedRecalc === true;
      return;
    }
    isRecalculating = true;
    saveInputs();
    const runStatusEl = document.getElementById("runStatus");
    const runBtn = document.getElementById("calcBtn");
    const stopBtn = document.getElementById("stopBtn");

    try {
      const inputs = readScenarioInputs(document, getValidatedSpendingSchedule);
      if (inputs.currentAcb > inputs.nonreg) {
        // Mirror the ACB clamp back into the input so UI and model stay consistent.
        const acbEl = document.getElementById("nonregAcb");
        if (acbEl) acbEl.value = String(inputs.nonreg);
      }

      if (runBtn) {
        runBtn.disabled = false;
        runBtn.innerText = "Run Simulation";
      }
      if (stopBtn) stopBtn.style.display = "none";

      const outcome = await runRetirementCalculation({
        inputs,
        runMonteCarloNow,
        lastMonteCarloResults,
        runMonteCarlo,
        solveSustainableSpending,
        runDeterministicProjection,
        getNormalizedOutcomeWeights,
        formatCurrency,
        onSolveStart: () => {
          if (!runStatusEl) return;
          runStatusEl.style.color = "#0369a1";
          runStatusEl.innerText = "Solving sustainable spending...";
        },
        onSolveIteration: (msg) => {
          if (!runStatusEl) return;
          runStatusEl.innerText = msg;
        },
        onAdvancedPolicyProgress: (ageAtYear) => {
          if (!runStatusEl) return;
          runStatusEl.style.color = "#0369a1";
          runStatusEl.innerText = `Constructing outcome-based policy: age ${ageAtYear}`;
          if (runBtn) {
            runBtn.disabled = true;
            runBtn.innerText = "Optimizing...";
          }
        },
        onAdvancedYearProgress: async (
          yearIndex,
          ageAtYear,
          projectionAge,
          startAge,
        ) => {
          if (!runStatusEl) return;
          const totalYears = Math.max(1, projectionAge - startAge + 1);
          runStatusEl.style.color = "#0369a1";
          runStatusEl.innerText = `Constructing advanced policy: year ${yearIndex + 1}/${totalYears} (age ${ageAtYear})`;
          await new Promise((resolve) => setTimeout(resolve, 0));
        },
        onMonteCarloStart: (trials) => {
          if (runStatusEl) {
            runStatusEl.style.color = "#0369a1";
            runStatusEl.innerText = `Running Monte Carlo (${trials.toLocaleString()} trials)...`;
          }
          if (runBtn) {
            runBtn.disabled = true;
            runBtn.innerText = "Running...";
          }
          if (stopBtn) stopBtn.style.display = "block";
          mcCancelRequested = false;
          mcIsRunning = true;
        },
        onMonteCarloProgress: (
          done,
          total,
          bucketLabels,
          bucketCounts,
          ageLabels,
          assetP10,
          assetP25,
          assetP50,
          assetP75,
          assetP90,
        ) => {
          if (runStatusEl) {
            const pct = ((done / total) * 100).toFixed(0);
            runStatusEl.innerText = `Running Monte Carlo: ${done.toLocaleString()} / ${total.toLocaleString()} (${pct}%)`;
          }
          renderMonteCarloOutcomeChart({
            // Render partial MC snapshots so users can see convergence in real time.
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
            assetP90,
          });
          renderMonteCarloPercentileChart({
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
            assetP90,
          });
        },
        shouldCancel: () => mcCancelRequested,
      });

      mcIsRunning = false;
      if (runBtn) {
        runBtn.disabled = false;
        runBtn.innerText = "Run Simulation";
      }
      if (stopBtn) stopBtn.style.display = "none";

      if (outcome.shouldPromptEnableMcForSolve && runStatusEl) {
        runStatusEl.style.color = "#b45309";
        runStatusEl.innerText =
          "Enable Monte Carlo to solve sustainable spending.";
      } else if (
        outcome.enableMonteCarlo &&
        outcome.runMonteCarloNow &&
        outcome.monteCarloResults &&
        runStatusEl
      ) {
        if (outcome.monteCarloResults.cancelled) {
          runStatusEl.style.color = "#b45309";
          runStatusEl.innerText = `Monte Carlo cancelled after ${outcome.monteCarloResults.trials.toLocaleString()} / ${outcome.monteCarloResults.requestedTrials.toLocaleString()} trials.`;
        } else {
          runStatusEl.style.color = "#166534";
          runStatusEl.innerText = `Monte Carlo complete: ${(outcome.monteCarloResults.successRate * 100).toFixed(1)}% success over ${outcome.monteCarloResults.trials.toLocaleString()} trials.`;
        }
      } else if (
        outcome.enableMonteCarlo &&
        !outcome.runMonteCarloNow &&
        runStatusEl
      ) {
        runStatusEl.style.color = "#64748b";
        runStatusEl.innerText =
          "Monte Carlo inputs changed. Click Run Simulation to refresh probability results.";
      } else if (runStatusEl) {
        runStatusEl.style.color = "#64748b";
        runStatusEl.innerText = "Deterministic mode ready.";
      }

      if (outcome.solvedSpendOutput !== null) {
        lastSolvedSpend = outcome.solvedSpendOutput;
        const spendingEl = document.getElementById("spending");
        if (spendingEl)
          spendingEl.value = Math.round(outcome.solvedSpendOutput);
      }
      if (
        outcome.monteCarloResults &&
        outcome.enableMonteCarlo &&
        outcome.runMonteCarloNow
      ) {
        lastMonteCarloResults = outcome.monteCarloResults;
      }
      if (outcome.monteCarloMeta) {
        lastMonteCarloMeta = outcome.monteCarloMeta;
      }

      updateUI(
        outcome.results,
        outcome.monteCarloResults,
        outcome.enableMonteCarlo,
        outcome.monteCarloStale,
        lastMonteCarloMeta,
        outcome.solvedSpendOutput,
        outcome.targetSuccessRate,
        outcome.spendingMode,
        outcome.selectedStrategyMode,
      );
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
    // Debounce change-driven reruns to avoid recomputing on every keystroke burst.
    if (recalcTimer) clearTimeout(recalcTimer);
    const enabled = document.getElementById("enableMonteCarlo").checked;
    const runStatusEl = document.getElementById("runStatus");
    const advancedMix =
      document.getElementById("strategyMode")?.value === "advanced";
    if (runStatusEl && advancedMix) {
      runStatusEl.style.color = "#0369a1";
      runStatusEl.innerText = "Updating outcome-based strategy...";
    }
    recalcTimer = setTimeout(() => {
      calculateRetirement(!enabled);
    }, 180);
  }

  function deferOutcomeBasedExecutionNotice() {
    const runStatusEl = document.getElementById("runStatus");
    if (!runStatusEl) return;
    runStatusEl.style.color = "#64748b";
    runStatusEl.innerText =
      "Outcome settings changed. Click Run Simulation to apply.";
  }

  function updateMonteCarloSettingsVisibility() {
    const enabled = document.getElementById("enableMonteCarlo").checked;
    const box = document.getElementById("mcSettingsBox");
    if (box) box.style.display = enabled ? "block" : "none";
  }

  function updateOutcomeSettingsVisibility() {
    // Advanced mode hides simple strategy selector because policy is optimizer-driven.
    const mode = document.getElementById("strategyMode")?.value;
    const enabled = mode === "advanced";
    const box = document.getElementById("outcomeSettings");
    const hint = document.getElementById("advancedModeHint");
    const simpleGroup = document.getElementById("simpleStrategyGroup");
    const simpleSelect = document.getElementById("strategy");
    if (box) box.style.display = enabled ? "block" : "none";
    if (hint) hint.style.display = enabled ? "block" : "none";
    if (simpleGroup) simpleGroup.style.display = enabled ? "none" : "block";
    if (simpleSelect) simpleSelect.disabled = enabled;
  }

  function applyOutcomePreset(preset) {
    const map = {
      balanced: { wTax: 30, wOas: 20, wEstate: 20, wSuccess: 30 },
      tax: { wTax: 60, wOas: 15, wEstate: 10, wSuccess: 15 },
      oas: { wTax: 15, wOas: 60, wEstate: 10, wSuccess: 15 },
      estate: { wTax: 15, wOas: 10, wEstate: 60, wSuccess: 15 },
      success: { wTax: 15, wOas: 10, wEstate: 10, wSuccess: 65 },
    };
    if (preset === "custom") return;
    const p = map[preset] || map.balanced;
    ["wTax", "wOas", "wEstate", "wSuccess"].forEach((k) => {
      const el = document.getElementById(k);
      if (el) el.value = p[k];
    });
  }

  function updateOutcomePresetLockState() {
    const preset = document.getElementById("outcomePreset")?.value;
    const isCustom = preset === "custom";
    ["wTax", "wOas", "wEstate", "wSuccess"].forEach((k) => {
      const el = document.getElementById(k);
      if (!el) return;
      el.disabled = !isCustom;
      el.style.backgroundColor = isCustom ? "#fff" : "#f1f5f9";
      el.style.cursor = isCustom ? "text" : "not-allowed";
    });
  }

  function setupCollapsibleSections() {
    // Purely UX: remember collapsed/open cards between sessions.
    let saved = {};
    try {
      saved = JSON.parse(
        localStorage.getItem("retirePlanner_sectionState") || "{}",
      );
    } catch {
      saved = {};
    }

    const defaultOpen = {
      "Basic Info & Taxes": false,
      "Current Assets ($)": false,
      "Canada Pension Plan (CPP)": false,
      "Old Age Security (OAS)": false,
      "RRIF Minimum Withdrawals": false,
      "Withdrawal Strategy": true,
      "Monte Carlo Simulation ?": true,
      "Display Options": false,
    };

    const sections = Array.from(document.querySelectorAll(".input-section"));
    sections.forEach((section) => {
      const h4 = section.querySelector("h4");
      if (!h4) return;
      section.classList.add("collapsible");
      const title = h4.textContent.trim();
      const key = title;

      let body = section.querySelector(":scope > .section-body");
      if (!body) {
        body = document.createElement("div");
        body.className = "section-body";
        const children = Array.from(section.children).filter((el) => el !== h4);
        children.forEach((el) => body.appendChild(el));
        section.appendChild(body);
      }

      const isOpen = Object.prototype.hasOwnProperty.call(saved, key)
        ? !!saved[key]
        : !!defaultOpen[title];
      body.style.display = isOpen ? "block" : "none";
      section.classList.toggle("collapsed", !isOpen);

      h4.addEventListener("click", () => {
        const nowOpen = section.classList.contains("collapsed");
        section.classList.toggle("collapsed", !nowOpen);
        body.style.display = nowOpen ? "block" : "none";
        saved[key] = nowOpen;
        try {
          localStorage.setItem(
            "retirePlanner_sectionState",
            JSON.stringify(saved),
          );
        } catch {}
      });
    });
  }

  function getNormalizedOutcomeWeights() {
    const wTax = Math.max(
      0,
      parseFloat(document.getElementById("wTax").value) || 0,
    );
    const wOas = Math.max(
      0,
      parseFloat(document.getElementById("wOas").value) || 0,
    );
    const wEstate = Math.max(
      0,
      parseFloat(document.getElementById("wEstate").value) || 0,
    );
    const wSuccess = Math.max(
      0,
      parseFloat(document.getElementById("wSuccess").value) || 0,
    );
    const sum = wTax + wOas + wEstate + wSuccess;
    if (sum <= 0)
      return { wTax: 0.25, wOas: 0.25, wEstate: 0.25, wSuccess: 0.25 };
    return {
      wTax: wTax / sum,
      wOas: wOas / sum,
      wEstate: wEstate / sum,
      wSuccess: wSuccess / sum,
    };
  }

  function updateSpendingModeVisibility() {
    const mode = document.getElementById("spendingMode").value;
    const targetEl = document.getElementById("targetSuccessGroup");
    const precisionEl = document.getElementById("solvePrecisionGroup");
    const scheduleWrap = document.getElementById("spendingScheduleContainer");
    const scheduleNote = document.getElementById("spendingScheduleSolveNote");
    const scheduleStatus = document.getElementById("spendingScheduleStatus");
    const spendingInput = document.getElementById("spending");
    const spendingLabel = document.getElementById("spendingLabel");
    const spendingInputGroup = document.getElementById("spendingInputGroup");
    const spendingHelp = document.getElementById("spendingModeHelp");
    const toggle = document.getElementById("spendingModeToggle");
    const visible = mode === "solve";

    if (toggle) {
      toggle.querySelectorAll("button[data-mode]").forEach((btn) => {
        btn.classList.toggle("active", btn.dataset.mode === mode);
      });
    }

    if (targetEl) targetEl.style.display = visible ? "block" : "none";
    if (precisionEl) precisionEl.style.display = visible ? "block" : "none";
    if (scheduleWrap) scheduleWrap.style.display = visible ? "none" : "block";
    if (scheduleNote) scheduleNote.style.display = visible ? "block" : "none";
    if (scheduleStatus)
      scheduleStatus.style.display = visible ? "none" : "block";
    if (spendingInput) {
      spendingInput.readOnly = visible;
      spendingInput.style.backgroundColor = visible ? "#f1f5f9" : "#fff";
      spendingInput.style.cursor = visible ? "not-allowed" : "text";
    }
    if (spendingLabel)
      spendingLabel.innerText = visible
        ? "Solved Net Spend/Yr"
        : "Desired Net Spend/Yr";
    if (spendingInputGroup)
      spendingInputGroup.style.opacity = visible ? "0.9" : "1";
    if (spendingHelp)
      spendingHelp.innerText = visible
        ? "Solves a flat spend to hit your MC success target."
        : "Uses your entered spend.";
  }

  function replaceWithFlatScheduleFromCurrentSpend(spendOverride = null) {
    const container = document.getElementById("spendingScheduleRows");
    if (!container) return;
    const currentAge = parseInt(document.getElementById("age").value) || 60;
    const lifeExpectancy = Math.max(
      currentAge,
      Math.min(
        120,
        parseInt(document.getElementById("lifeExpectancy").value) || 100,
      ),
    );
    const spend = Number.isFinite(spendOverride)
      ? spendOverride
      : parseFloat(document.getElementById("spending").value) || 0;
    const flatRows = buildFlatSchedule(currentAge, lifeExpectancy, spend);
    container.innerHTML = "";
    flatRows.forEach((row) =>
      container.appendChild(
        createSpendingScheduleRow(row.startAge, row.endAge, row.amount),
      ),
    );
    saveSpendingSchedule();
  }

  function updateUI(
    results,
    monteCarloResults,
    monteCarloEnabled,
    monteCarloStale,
    monteCarloMeta,
    solvedSpendOutput,
    targetSuccessRate,
    spendingMode,
    selectedStrategy,
  ) {
    // Presentation layer only: charts, table, summary cards, and explanatory copy.
    const displayInflated = document.getElementById("displayMode").checked;
    const inflation =
      parseFloat(document.getElementById("inflation").value) / 100;

    const adj = (val, idx) =>
      displayInflated ? val : val / Math.pow(1 + inflation, idx);

    const strSuffix = displayInflated
      ? "(Inflated/Nominal Dollars)"
      : "(Today's Dollars)";
    const mcSuffix = monteCarloEnabled ? " - Baseline Path" : "";
    document.getElementById("chart1Title").innerText =
      `Asset Balances Over Time ${strSuffix}${mcSuffix}`;
    document.getElementById("chart2Title").innerText =
      `Gross Income Sources vs Net Target ${strSuffix}${mcSuffix}`;
    document.getElementById("tableSubtitle").innerText = strSuffix;
    document.getElementById("summarySubtitle").innerText = strSuffix;

    // --- TABLE ---
    const tbody = document.getElementById("tableBody");
    tbody.innerHTML = "";

    results.forEach((r) => {
      const tr = document.createElement("tr");
      if (r.depleted) tr.classList.add("depleted");

      tr.innerHTML = `
                <td>${r.age}</td>
                <td>${formatCurrency(adj(r.spending, r.yearIndex))} ${r.depleted ? '<br><small style="color:red;">(Shortfall)</small>' : ""}</td>
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
    let totRRSP = 0,
      totTFSA = 0,
      totNonReg = 0,
      totCPP = 0,
      totOAS = 0,
      totTax = 0,
      totClawback = 0;
    results.forEach((r) => {
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

    document.getElementById("summaryGrid").innerHTML = `
            <div class="summary-box ${depleted ? "alert" : "highlight"}">
                <div class="summary-title">${depleted ? "Depleted At Age" : "Final Estate Value (Age " + finalRow.age + ")"}</div>
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

    const existing = document.getElementById("optimizedStrategyNote");
    if (existing) existing.remove();
    if (selectedStrategy === "outcome-based") {
      const note = document.createElement("div");
      note.id = "optimizedStrategyNote";
      note.style.marginTop = "10px";
      note.style.fontSize = "0.82rem";
      note.style.color = "#475569";
      note.innerText =
        "Outcome-based mode constructs a deterministic year-by-year draw mix from your weight settings.";
      document.getElementById("summaryGrid").after(note);
    }

    const mcEl = document.getElementById("mcSummary");
    if (monteCarloEnabled && monteCarloResults) {
      const failRate = 1 - monteCarloResults.successRate;
      const depText =
        monteCarloResults.medianDepletionAge === null
          ? "No depletion in failed paths"
          : `Age ${Math.round(monteCarloResults.medianDepletionAge)}`;
      const runAt =
        monteCarloMeta && monteCarloMeta.runAtIso
          ? new Date(monteCarloMeta.runAtIso).toLocaleString()
          : "Unknown";
      const seedText =
        monteCarloMeta && monteCarloMeta.seed !== null
          ? monteCarloMeta.seed
          : "Random";
      const staleLine = monteCarloStale
        ? '<span style="color:#b45309; font-weight:600;">Results are from a previous run. Click Run Simulation to refresh.</span>'
        : '<span style="color:#166534;">Results are current with shown inputs.</span>';
      const partialLine = monteCarloResults.cancelled
        ? `<span style="color:#b45309; font-weight:600;">Partial run: ${monteCarloResults.trials.toLocaleString()} / ${monteCarloResults.requestedTrials.toLocaleString()} trials completed.</span>`
        : "";
      const solvedLine =
        spendingMode === "solve" && solvedSpendOutput
          ? `Solved sustainable spend (today's dollars): ${formatCurrency(solvedSpendOutput)} at ${(targetSuccessRate * 100).toFixed(0)}% target success`
          : "";
      mcEl.innerHTML = [
        "<strong>Monte Carlo Summary:</strong>",
        `Trials completed: ${monteCarloResults.trials.toLocaleString()} / ${monteCarloResults.requestedTrials.toLocaleString()}`,
        `Success probability: ${(monteCarloResults.successRate * 100).toFixed(1)}%`,
        `Failure probability: ${(failRate * 100).toFixed(1)}%`,
        `Median depletion age (failed paths): ${depText}`,
        `Final estate (P10 / Median / P90): ${formatCurrency(monteCarloResults.p10FinalEstate)} / ${formatCurrency(monteCarloResults.medianFinalEstate)} / ${formatCurrency(monteCarloResults.p90FinalEstate)}`,
        `Avg lifetime tax / clawback: ${formatCurrency(monteCarloResults.avgTax)} / ${formatCurrency(monteCarloResults.avgClawback)}`,
        `Last run: ${runAt}`,
        `Settings used (trials / return vol / inflation vol / seed): ${(monteCarloMeta?.trials ?? monteCarloResults.trials).toLocaleString()} / ${((monteCarloMeta?.returnVolatility ?? 0) * 100).toFixed(1)}% / ${((monteCarloMeta?.inflationVolatility ?? 0) * 100).toFixed(1)}% / ${seedText}`,
        `Bad-year spending cut: ${((monteCarloMeta?.badYearSpendCutPct ?? 0) * 100).toFixed(1)}%`,
        solvedLine,
        partialLine,
        staleLine,
      ].join("<br>");
      mcEl.style.display = "block";
    } else {
      mcEl.style.display = "none";
      mcEl.innerHTML = "";
    }

    if (monteCarloEnabled) {
      renderMonteCarloOutcomeChart(monteCarloResults);
      renderMonteCarloPercentileChart(monteCarloResults);
    } else {
      renderMonteCarloOutcomeChart(null);
      renderMonteCarloPercentileChart(null);
    }

    const debugMode = document.getElementById("debugMode").value;
    const debugEl = document.getElementById("debugSummary");
    if (debugMode === "on" || debugMode === "table") {
      let maxTaxable = 0;
      let maxShortfall = 0;
      let maxClawbackIterations = 0;
      let yearsWithClawback = 0;
      let yearsWithMandatoryRrif = 0;
      let totalMandatoryRrif = 0;

      results.forEach((r) => {
        if (r.taxableIncome > maxTaxable) maxTaxable = r.taxableIncome;
        if (r.netShortfall > maxShortfall) maxShortfall = r.netShortfall;
        if (r.clawbackIterations > maxClawbackIterations)
          maxClawbackIterations = r.clawbackIterations;
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
        `Max unmet net need in any year: ${formatCurrency(adj(maxShortfall, 0))}`,
      ];

      if (debugMode === "table") {
        const rows = results
          .map(
            (r) => `
                    <tr>
                        <td style="text-align:center;">${r.age}</td>
                        <td>${formatCurrency(adj(r.taxableIncome, r.yearIndex))}</td>
                        <td>${formatCurrency(adj(r.mandatoryRrifDraw, r.yearIndex))}</td>
                        <td>${formatCurrency(adj(r.oasClawback, r.yearIndex))}</td>
                        <td style="text-align:center;">${r.mixTFSA === null || r.mixNonReg === null || r.mixRRSP === null ? "-" : `${Math.round(r.mixTFSA * 100)} / ${Math.round(r.mixNonReg * 100)} / ${Math.round(r.mixRRSP * 100)}`}</td>
                        <td style="text-align:center;">${r.clawbackIterations}</td>
                        <td>${formatCurrency(adj(r.netShortfall, r.yearIndex))}</td>
                    </tr>
                `,
          )
          .join("");

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
            `</div>`,
        );
      }

      debugEl.innerHTML = debugLines.join("<br>");
      debugEl.style.display = "block";
    } else {
      debugEl.style.display = "none";
      debugEl.innerHTML = "";
    }

    // --- CHARTS ---
    const labels = results.map((r) => r.age);
    const effectiveTaxRatePct = results.map((r) => {
      const spending = adj(r.spending, r.yearIndex);
      const incomeTax = adj(r.incomeTax, r.yearIndex);
      if (spending <= 0) return 0;
      return (incomeTax / spending) * 100;
    });
    const cssVar = (name) =>
      getComputedStyle(document.documentElement).getPropertyValue(name).trim();

    const sharedOptions = {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        tooltip: {
          callbacks: {
            label: function (ctx) {
              let label = ctx.dataset.label || "";
              if (label) label += ": ";
              if (ctx.parsed.y !== null)
                label += new Intl.NumberFormat("en-CA", {
                  style: "currency",
                  currency: "CAD",
                  maximumFractionDigits: 0,
                }).format(ctx.parsed.y);
              return label;
            },
          },
        },
      },
      scales: {
        x: { stacked: true },
        y: {
          stacked: true,
          ticks: {
            callback: function (v) {
              return "$" + v.toLocaleString();
            },
          },
        },
      },
    };

    if (balanceChartInst) balanceChartInst.destroy();
    balanceChartInst = new Chart(
      document.getElementById("balanceChart").getContext("2d"),
      {
        type: "bar",
        data: {
          labels: labels,
          datasets: [
            {
              label: "RRSP",
              data: results.map((r) => adj(r.rrsp, r.yearIndex)),
              backgroundColor: cssVar("--color-rrsp"),
            },
            {
              label: "TFSA",
              data: results.map((r) => adj(r.tfsa, r.yearIndex)),
              backgroundColor: cssVar("--color-tfsa"),
            },
            {
              label: "Non-Reg",
              data: results.map((r) => adj(r.nonreg, r.yearIndex)),
              backgroundColor: cssVar("--color-nonreg"),
            },
          ],
        },
        options: { ...sharedOptions },
      },
    );

    if (incomeChartInst) incomeChartInst.destroy();
    incomeChartInst = new Chart(
      document.getElementById("incomeChart").getContext("2d"),
      {
        type: "bar",
        data: {
          labels: labels,
          datasets: [
            {
              type: "line",
              label: "Net Spend Goal",
              data: results.map((r) => adj(r.spending, r.yearIndex)),
              borderColor: "#1e293b",
              borderWidth: 2,
              borderDash: [5, 5],
              fill: false,
              pointRadius: 0,
              order: 0,
            },
            {
              label: "CPP",
              data: results.map((r) => adj(r.cpp, r.yearIndex)),
              backgroundColor: cssVar("--color-cpp"),
              order: 1,
            },
            {
              label: "OAS",
              data: results.map((r) => adj(r.oas, r.yearIndex)),
              backgroundColor: cssVar("--color-oas"),
              order: 1,
            },
            {
              label: "RRSP Draw",
              data: results.map((r) => adj(r.drawRRSP, r.yearIndex)),
              backgroundColor: cssVar("--color-rrsp"),
              order: 1,
            },
            {
              label: "TFSA Draw",
              data: results.map((r) => adj(r.drawTFSA, r.yearIndex)),
              backgroundColor: cssVar("--color-tfsa"),
              order: 1,
            },
            {
              label: "Non-Reg Draw",
              data: results.map((r) => adj(r.drawNonReg, r.yearIndex)),
              backgroundColor: cssVar("--color-nonreg"),
              order: 1,
            },
            {
              type: "line",
              label: "OAS Clawback",
              data: results.map((r) => adj(r.oasClawback, r.yearIndex)),
              borderColor: "#dc2626",
              borderWidth: 2,
              borderDash: [4, 4],
              fill: false,
              pointRadius: 0,
              yAxisID: "y",
              order: 0,
            },
            {
              type: "line",
              label: "Income Tax",
              data: results.map((r) => adj(r.incomeTax, r.yearIndex)),
              borderColor: "#ef4444",
              borderWidth: 2,
              fill: false,
              pointRadius: 0,
              yAxisID: "y",
              order: 0,
            },
            {
              type: "line",
              label: "Effective Tax Rate",
              data: effectiveTaxRatePct,
              borderColor: "#b45309",
              borderWidth: 2,
              fill: false,
              pointRadius: 0,
              yAxisID: "y1",
              order: 0,
            },
          ],
        },
        options: {
          ...sharedOptions,
          plugins: {
            ...sharedOptions.plugins,
            tooltip: {
              callbacks: {
                label: function (ctx) {
                  const label = ctx.dataset.label || "";
                  if (label === "Effective Tax Rate") {
                    return `${label}: ${ctx.parsed.y.toFixed(1)}%`;
                  }
                  let valueLabel = label;
                  if (valueLabel) valueLabel += ": ";
                  if (ctx.parsed.y !== null) {
                    valueLabel += new Intl.NumberFormat("en-CA", {
                      style: "currency",
                      currency: "CAD",
                      maximumFractionDigits: 0,
                    }).format(ctx.parsed.y);
                  }
                  return valueLabel;
                },
              },
            },
          },
          scales: {
            ...sharedOptions.scales,
            y1: {
              position: "right",
              min: 0,
              max: 60,
              grid: { drawOnChartArea: false },
              ticks: {
                callback: function (v) {
                  return `${Number(v).toFixed(0)}%`;
                },
              },
            },
          },
        },
      },
    );
  }

  // --- INITIALIZATION ---
  setupCollapsibleSections();
  loadInputs();
  loadSpendingSchedule();
  updateMonteCarloSettingsVisibility();
  updateSpendingModeVisibility();
  updateOutcomeSettingsVisibility();

  const outcomePresetEl = document.getElementById("outcomePreset");
  if (outcomePresetEl) {
    applyOutcomePreset(outcomePresetEl.value);
    updateOutcomePresetLockState();
    outcomePresetEl.addEventListener("change", () => {
      suppressInputChangeRecalc = true;
      applyOutcomePreset(outcomePresetEl.value);
      updateOutcomePresetLockState();
      saveInputs();
      const advancedMix =
        document.getElementById("strategyMode")?.value === "advanced";
      if (advancedMix) deferOutcomeBasedExecutionNotice();
      else recalculateForUiChange();
      setTimeout(() => {
        suppressInputChangeRecalc = false;
      }, 0);
    });
  }

  const spendingModeToggle = document.getElementById("spendingModeToggle");
  if (spendingModeToggle) {
    spendingModeToggle.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-mode]");
      if (!btn) return;
      const modeInput = document.getElementById("spendingMode");
      if (!modeInput) return;
      const prevMode = modeInput.value;
      modeInput.value = btn.dataset.mode;

      if (prevMode === "input" && modeInput.value === "solve") {
        const spendEl = document.getElementById("spending");
        const val = spendEl ? parseFloat(spendEl.value) : NaN;
        desiredSpendBeforeSolve = Number.isFinite(val)
          ? val
          : desiredSpendBeforeSolve;
      }

      if (prevMode === "solve" && modeInput.value === "input") {
        const spendEl = document.getElementById("spending");
        const solvedSpend = Number.isFinite(lastSolvedSpend)
          ? lastSolvedSpend
          : parseFloat(spendEl?.value) || 0;
        const desiredSpend = Number.isFinite(desiredSpendBeforeSolve)
          ? desiredSpendBeforeSolve
          : solvedSpend;

        if (
          spendEl &&
          Number.isFinite(solvedSpend) &&
          Math.round(desiredSpend) !== Math.round(solvedSpend)
        ) {
          const applySolvedEverywhere = window.confirm(
            "Your previous desired spend differs from the solved spend.\n\nDo you want to update BOTH Desired Net Spend/Yr and the spending schedule to the solved value for a like-for-like comparison?",
          );
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

  const schedContainer = document.getElementById("spendingScheduleRows");
  const addSchedBtn = document.getElementById("addSpendingRow");
  if (addSchedBtn) {
    addSchedBtn.addEventListener("click", () => {
      const lastRow = schedContainer.querySelector(".spending-row:last-child");
      let nextStart = parseInt(document.getElementById("age").value) || 60;
      const lifeExpectancy =
        parseInt(document.getElementById("lifeExpectancy").value) || 100;
      let nextAmount =
        parseFloat(document.getElementById("spending").value) || 60000;
      if (lastRow) {
        const prevEnd = parseInt(lastRow.querySelector(".sched-end").value);
        const prevAmt = parseFloat(
          lastRow.querySelector(".sched-amount").value,
        );
        if (Number.isFinite(prevEnd))
          nextStart = Math.min(prevEnd + 1, lifeExpectancy);
        if (Number.isFinite(prevAmt)) nextAmount = prevAmt;
      }
      schedContainer.appendChild(
        createSpendingScheduleRow(nextStart, lifeExpectancy, nextAmount),
      );
      saveSpendingSchedule();
      recalculateForUiChange();
    });
  }

  if (schedContainer) {
    schedContainer.addEventListener("click", (e) => {
      if (e.target.classList.contains("remove-spending-row")) {
        const rows = schedContainer.querySelectorAll(".spending-row");
        if (rows.length <= 1) return;
        e.target.closest(".spending-row").remove();
        saveSpendingSchedule();
        recalculateForUiChange();
      }
    });

    schedContainer.addEventListener("change", (e) => {
      if (
        e.target.classList.contains("sched-start") ||
        e.target.classList.contains("sched-end") ||
        e.target.classList.contains("sched-amount")
      ) {
        saveSpendingSchedule();
        recalculateForUiChange();
      }
    });
  }

  // Bind all inputs safely inside the script, avoiding global scope issues
  inputIds.forEach((id) => {
    const el = document.getElementById(id);
    if (el)
      el.addEventListener("change", () => {
        if (suppressInputChangeRecalc) return;
        if (id === "enableMonteCarlo") updateMonteCarloSettingsVisibility();
        if (id === "strategy" || id === "strategyMode")
          updateOutcomeSettingsVisibility();
        if (id === "spendingMode") updateSpendingModeVisibility();

        if (
          id === "strategyMode" &&
          document.getElementById("strategyMode")?.value === "advanced"
        ) {
          saveInputs();
          deferOutcomeBasedExecutionNotice();
          return;
        }

        if (id === "age" || id === "spending" || id === "lifeExpectancy") {
          const rows = document.querySelectorAll(
            "#spendingScheduleRows .spending-row",
          );
          if (rows.length === 1) {
            const r = rows[0];
            if (id === "age") r.querySelector(".sched-start").value = el.value;
            if (id === "spending")
              r.querySelector(".sched-amount").value = el.value;
            if (id === "lifeExpectancy")
              r.querySelector(".sched-end").value = el.value;
            saveSpendingSchedule();
          }
        }

        const advancedMix =
          document.getElementById("strategyMode")?.value === "advanced";
        const outcomeSettingIds = [
          "wTax",
          "wOas",
          "wEstate",
          "wSuccess",
          "outcomePreset",
          "requireMinSuccess",
          "minSuccess",
        ];
        if (advancedMix && outcomeSettingIds.includes(id)) {
          saveInputs();
          deferOutcomeBasedExecutionNotice();
          return;
        }

        recalculateForUiChange();
      });
  });

  // Bind the button
  const runBtn = document.getElementById("calcBtn");
  if (runBtn) runBtn.addEventListener("click", () => calculateRetirement(true));
  const stopBtn = document.getElementById("stopBtn");
  if (stopBtn) {
    stopBtn.addEventListener("click", () => {
      if (!mcIsRunning) return;
      mcCancelRequested = true;
      const runStatusEl = document.getElementById("runStatus");
      if (runStatusEl) {
        runStatusEl.style.color = "#b45309";
        runStatusEl.innerText = "Stopping Monte Carlo after current batch...";
      }
    });
  }

  // Run initial calculation (skip heavy advanced auto-run)
  const initialAdvancedMode =
    document.getElementById("strategyMode")?.value === "advanced";
  if (initialAdvancedMode) {
    deferOutcomeBasedExecutionNotice();
  } else {
    calculateRetirement(false);
  }
});
