import Chart from "chart.js/auto";
import { runMonteCarlo } from "./core/monteCarlo.js";
import {
  sanitizeScheduleRows,
  normalizeScheduleRows,
  getScheduleValidationError,
} from "./core/spending.js";
import { runDeterministicProjection } from "./core/projection.js";
import { solveSustainableSpending } from "./core/solveSpending.js";
import { readScenarioInputs, SCENARIO_INPUT_DEFAULTS } from "./core/inputs.js";
import { runRetirementCalculation } from "./core/calculateRetirement.js";

document.addEventListener("DOMContentLoaded", () => {
  // UI-level state: keep long-running calc/MC interactions responsive and cancellable.
  let balanceChartInst = null;
  let incomeChartInst = null;
  let mcOutcomeChartInst = null;
  let mcPercentileChartInst = null;
  let mcSpendPercentileChartInst = null;
  let mcSampleAssetChartInst = null;
  let mcSampleSpendChartInst = null;
  let activeMonteCarloResults = null;
  let hiddenSamplePathIndices = new Set();
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
    "retirementAge",
    "spending",
    "desiredMinSpend",
    "desiredMaxSpend",
    "spendSensitivity",
    "spendingMode",
    "amortizationRate",
    "targetEstateValue",
    "rollingMinSpend",
    "rollingMaxSpend",
    "targetSuccess",
    "solvePrecision",
    "lifeExpectancy",
    "grossEmploymentIncome",
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
    "enableGIS",
    "gisInitialPriorYearIncome",
    "rrifStartAge",
    "enforceRrifMin",
    "strategy",
    "enableMonteCarlo",
    "mcModel",
    "mcTrials",
    "mcSamplePaths",
    "mcVolatility",
    "mcInflationVolatility",
    "mcSeed",
  ];

  const formatCurrency = (num) => {
    if (num === 0 || Math.abs(num) < 0.5) return "-";
    return new Intl.NumberFormat("en-CA", {
      style: "currency",
      currency: "CAD",
      maximumFractionDigits: 0,
    }).format(num);
  };

  function setRunButtonState({ running = false } = {}) {
    const runBtn = document.getElementById("calcBtn");
    if (!runBtn) return;
    runBtn.disabled = false;
    if (!running) {
      runBtn.innerText = "Run Simulation";
      runBtn.style.backgroundColor = "";
      return;
    }
    runBtn.innerText = "Stop Simulation";
    runBtn.style.backgroundColor = "#b91c1c";
  }

  const readUiInt = (id, fallback) => {
    const value = parseInt(document.getElementById(id)?.value);
    return Number.isFinite(value) ? value : fallback;
  };

  const readUiFloat = (id, fallback) => {
    const value = parseFloat(document.getElementById(id)?.value);
    return Number.isFinite(value) ? value : fallback;
  };

  const setInputValueIfChanged = (id, nextValue) => {
    const el = document.getElementById(id);
    if (!el) return;
    const normalized = String(nextValue);
    if (el.value !== normalized) el.value = normalized;
  };

  function syncInputsToForm(inputs) {
    suppressInputChangeRecalc = true;
    try {
      setInputValueIfChanged("age", inputs.age);
      setInputValueIfChanged("retirementAge", inputs.retirementAge);
      setInputValueIfChanged("rrsp", inputs.rrsp);
      setInputValueIfChanged("tfsa", inputs.tfsa);
      setInputValueIfChanged("nonreg", inputs.nonreg);
      setInputValueIfChanged("nonregAcb", inputs.currentAcb);
      setInputValueIfChanged("spending", inputs.baseSpending);
      setInputValueIfChanged("desiredMinSpend", inputs.desiredMinSpend);
      setInputValueIfChanged("desiredMaxSpend", inputs.desiredMaxSpend);
      setInputValueIfChanged("spendSensitivity", inputs.spendSensitivity);
      setInputValueIfChanged("amortizationRate", inputs.amortizationRate * 100);
      setInputValueIfChanged("targetEstateValue", inputs.targetEstateValue);
      setInputValueIfChanged("rollingMinSpend", inputs.rollingMinSpend);
      setInputValueIfChanged("rollingMaxSpend", inputs.rollingMaxSpend);
      setInputValueIfChanged("targetSuccess", inputs.targetSuccessRate * 100);
      setInputValueIfChanged("solvePrecision", inputs.solvePrecision);
      setInputValueIfChanged("lifeExpectancy", inputs.lifeExpectancy);
      setInputValueIfChanged(
        "grossEmploymentIncome",
        inputs.grossEmploymentIncome,
      );
      setInputValueIfChanged("inflation", inputs.inflation * 100);
      setInputValueIfChanged("growth", inputs.growth * 100);
      setInputValueIfChanged("cpp60", readUiFloat("cpp60", 0));
      setInputValueIfChanged("cpp65", readUiFloat("cpp65", 0));
      setInputValueIfChanged("cpp70", readUiFloat("cpp70", 0));
      setInputValueIfChanged("oasPercent", inputs.oasPercent * 100);
      setInputValueIfChanged(
        "gisInitialPriorYearIncome",
        inputs.gisInitialPriorYearIncome,
      );
      setInputValueIfChanged("rrifStartAge", inputs.rrifStartAge);
      setInputValueIfChanged("mcTrials", inputs.mcTrials);
      setInputValueIfChanged("mcSamplePaths", inputs.mcSamplePaths);
      setInputValueIfChanged("mcModel", inputs.mcModel);
      setInputValueIfChanged("mcVolatility", inputs.mcVolatility * 100);
      setInputValueIfChanged(
        "mcInflationVolatility",
        inputs.mcInflationVolatility * 100,
      );
    } finally {
      suppressInputChangeRecalc = false;
    }
  }

  function updateDesiredSpendingBoundsStatus(inputs) {
    const statusEl = document.getElementById("desiredSpendingBoundsStatus");
    if (!statusEl) return;
    if (inputs?.spendingMode !== "input") {
      statusEl.style.display = "none";
      statusEl.innerText = "";
      return;
    }
    statusEl.style.display = "block";
    if (inputs.desiredSpendingBoundsError) {
      statusEl.style.color = "#b91c1c";
      statusEl.innerText = `${inputs.desiredSpendingBoundsError} Monte Carlo adaptive spending will fall back to plain desired spending until fixed.`;
      return;
    }
    statusEl.style.color = "#166534";
    statusEl.innerText = `Monte Carlo adaptive spending will target ${formatCurrency(inputs.baseSpending)} and flex between ${formatCurrency(inputs.desiredMinSpend)} and ${formatCurrency(inputs.desiredMaxSpend)} using ${inputs.spendSensitivity} sensitivity.`;
  }

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
                <div style="flex:1; min-width:0;">
                    <label class="sched-amount-label">Net Spend/Yr</label>
                    <input type="number" class="sched-amount" min="0" value="${amount}">
                </div>
                <button type="button" class="remove-spending-row" title="Remove phase" aria-label="Remove phase" style="width:30px; min-width:30px; height:36px; margin-top:0; padding:0; font-size:1rem; line-height:1; display:flex; align-items:center; justify-content:center; background:#64748b;">×</button>
            </div>
        `;
    return row;
  }

  function updateSpendingScheduleLabels() {
    const sectionLabel = document.getElementById("spendingScheduleLabel");
    if (sectionLabel) {
      sectionLabel.innerText = "Optional Age Adjustments (%)";
    }

    document.querySelectorAll(".sched-amount-label").forEach((label) => {
      label.innerText = "Spend Adjustment (%)";
    });
  }

  function updateSpendingScheduleVisibility() {
    const container = document.getElementById("spendingScheduleRows");
    const emptyState = document.getElementById("spendingScheduleEmptyState");
    if (!container || !emptyState) return;

    const hasRows = container.querySelectorAll(".spending-row").length > 0;
    container.style.display = hasRows ? "flex" : "none";
    emptyState.style.display = hasRows ? "none" : "block";
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
        "retirePlanner_ageAdjustments",
        JSON.stringify(rows),
      );
      updateSpendingScheduleVisibility();
    } catch (e) {
      console.warn("Local storage unavailable", e);
    }
  }

  function loadSpendingSchedule() {
    const container = document.getElementById("spendingScheduleRows");
    container.innerHTML = "";
    updateSpendingScheduleLabels();

    let rows = null;
    try {
      const raw = localStorage.getItem("retirePlanner_ageAdjustments");
      if (raw) rows = JSON.parse(raw);
    } catch (e) {
      console.warn("Spending schedule load failed", e);
    }

    if (!Array.isArray(rows) || rows.length === 0) {
      updateSpendingScheduleVisibility();
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
    updateSpendingScheduleVisibility();
  }

  function getValidatedSpendingSchedule() {
    // This is the UI-facing wrapper around core schedule normalization/validation.
    // It translates validation outcomes into user-readable status text.
    const statusEl = document.getElementById("spendingScheduleStatus");
    const currentAge = readUiInt("age", SCENARIO_INPUT_DEFAULTS.age);
    const lifeExpectancy = Math.max(
      currentAge,
      Math.min(
        120,
        readUiInt("lifeExpectancy", SCENARIO_INPUT_DEFAULTS.lifeExpectancy),
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
      statusEl.style.color = "#64748b";
      statusEl.innerText =
        "No age adjustments configured. Using 100% through all ages.";
      return [];
    }

    const validationError = getScheduleValidationError(cleaned);
    if (validationError === "invalid-range") {
      statusEl.style.color = "#b91c1c";
      statusEl.innerText =
        "Each row needs Start Age <= End Age. Using 100% through all ages.";
      return [];
    }
    if (validationError === "overlap") {
      statusEl.style.color = "#b91c1c";
      statusEl.innerText =
        "Age adjustment rows overlap. Using 100% through all ages.";
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
    statusEl.innerText = `Using ${cleaned.length} age adjustment phase${cleaned.length === 1 ? "" : "s"} through age ${lifeExpectancy}.`;
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
      readUiFloat("inflation", SCENARIO_INPUT_DEFAULTS.inflationPct) / 100;
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
          beginAtZero: true,
          min: 0,
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

  function renderMonteCarloSpendPercentileChart(monteCarloResults) {
    const card = document.getElementById("mcSpendPercentileCard");
    const subtitle = document.getElementById("mcSpendPercentileSubtitle");
    if (!card || !subtitle) return;

    if (
      !monteCarloResults ||
      !monteCarloResults.trials ||
      !monteCarloResults.ageLabels?.length
    ) {
      if (mcSpendPercentileChartInst) {
        mcSpendPercentileChartInst.destroy();
        mcSpendPercentileChartInst = null;
      }
      card.style.display = "none";
      subtitle.innerText = "";
      return;
    }

    card.style.display = "block";
    const displayInflated = document.getElementById("displayMode").checked;
    const baseInflation =
      readUiFloat("inflation", SCENARIO_INPUT_DEFAULTS.inflationPct) / 100;
    subtitle.innerText = `Based on ${monteCarloResults.trials.toLocaleString()} / ${monteCarloResults.requestedTrials.toLocaleString()} trials${monteCarloResults.cancelled ? " (partial run)" : ""}. P10 means 10% of paths spent below this level. Values shown in ${displayInflated ? "inflated/nominal" : "today's"} dollars.`;

    const labels = monteCarloResults.ageLabels;
    const adjustSeries = (series) =>
      (series || []).map((v, idx) => {
        if (displayInflated) return v;
        return v / Math.pow(1 + baseInflation, idx);
      });
    const p10 = adjustSeries(monteCarloResults.spendP10);
    const p25 = adjustSeries(monteCarloResults.spendP25);
    const p50 = adjustSeries(monteCarloResults.spendP50);
    const p75 = adjustSeries(monteCarloResults.spendP75);
    const p90 = adjustSeries(monteCarloResults.spendP90);

    const data = {
      labels,
      datasets: [
        {
          label: "P10",
          data: p10,
          borderColor: "#f59e0b",
          borderWidth: 1.2,
          pointRadius: 0,
          fill: false,
        },
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
      ],
    };

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
          beginAtZero: true,
          min: 0,
          ticks: { callback: (v) => "$" + Number(v).toLocaleString() },
        },
      },
    };

    if (!mcSpendPercentileChartInst) {
      mcSpendPercentileChartInst = new Chart(
        document.getElementById("mcSpendPercentileChart").getContext("2d"),
        {
          type: "line",
          data,
          options,
        },
      );
      return;
    }

    mcSpendPercentileChartInst.data = data;
    mcSpendPercentileChartInst.options = options;
    mcSpendPercentileChartInst.update("none");
  }

  function getSamplePathStroke(index, total) {
    const hue = total <= 1 ? 210 : Math.round((index / total) * 300);
    return `hsl(${hue}, 70%, 42%)`;
  }

  function getSamplePathCount(monteCarloResults) {
    return Math.max(
      monteCarloResults?.sampleAssetPaths?.length || 0,
      monteCarloResults?.sampleSpendPaths?.length || 0,
    );
  }

  function pruneSamplePathVisibility(pathCount) {
    hiddenSamplePathIndices = new Set(
      [...hiddenSamplePathIndices].filter((index) => index < pathCount),
    );
  }

  function refreshMonteCarloSampleViews() {
    renderMonteCarloSamplePathControls(activeMonteCarloResults);
    renderMonteCarloSampleAssetChart(activeMonteCarloResults);
    renderMonteCarloSampleSpendChart(activeMonteCarloResults);
  }

  function renderMonteCarloSamplePathControls(monteCarloResults) {
    activeMonteCarloResults = monteCarloResults;
    const card = document.getElementById("mcSamplePathControlsCard");
    const controlsEl = document.getElementById("mcSamplePathControls");
    const subtitleEl = document.getElementById("mcSamplePathControlsSubtitle");
    if (!card || !controlsEl || !subtitleEl) return;

    const pathCount = getSamplePathCount(monteCarloResults);
    if (!monteCarloResults || !monteCarloResults.trials || pathCount === 0) {
      card.style.display = "none";
      controlsEl.innerHTML = "";
      subtitleEl.innerText = "";
      hiddenSamplePathIndices = new Set();
      return;
    }

    pruneSamplePathVisibility(pathCount);
    card.style.display = "block";
    const visibleCount = pathCount - hiddenSamplePathIndices.size;
    subtitleEl.innerText = `${visibleCount.toLocaleString()} of ${pathCount.toLocaleString()} sampled path pairs visible. Each toggle applies to the matching asset and spending path.`;

    controlsEl.innerHTML = `
      <div style="display:flex; flex-wrap:wrap; gap:8px; margin-bottom:10px;">
        <button type="button" id="showAllSamplePaths" style="background:#0f766e;">Show all</button>
        <button type="button" id="hideAllSamplePaths" style="background:#475569;">Hide all</button>
      </div>
      <div style="display:flex; flex-wrap:wrap; gap:8px;"></div>
    `;

    const buttonsRow = controlsEl.lastElementChild;
    for (let index = 0; index < pathCount; index++) {
      const label = document.createElement("label");
      label.style.display = "inline-flex";
      label.style.alignItems = "center";
      label.style.gap = "8px";
      label.style.padding = "6px 10px";
      label.style.border = "1px solid #cbd5e1";
      label.style.borderRadius = "999px";
      label.style.background = "#fff";
      label.style.fontSize = "0.85rem";
      label.style.cursor = "pointer";

      const input = document.createElement("input");
      input.type = "checkbox";
      input.checked = !hiddenSamplePathIndices.has(index);
      input.style.width = "auto";
      input.addEventListener("change", () => {
        if (input.checked) hiddenSamplePathIndices.delete(index);
        else hiddenSamplePathIndices.add(index);
        refreshMonteCarloSampleViews();
      });

      const swatch = document.createElement("span");
      swatch.style.display = "inline-block";
      swatch.style.width = "12px";
      swatch.style.height = "12px";
      swatch.style.borderRadius = "999px";
      swatch.style.background = getSamplePathStroke(index, pathCount);

      const text = document.createElement("span");
      text.innerText = `Path ${index + 1}`;

      label.appendChild(input);
      label.appendChild(swatch);
      label.appendChild(text);
      buttonsRow.appendChild(label);
    }

    document
      .getElementById("showAllSamplePaths")
      ?.addEventListener("click", () => {
        hiddenSamplePathIndices = new Set();
        refreshMonteCarloSampleViews();
      });
    document
      .getElementById("hideAllSamplePaths")
      ?.addEventListener("click", () => {
        hiddenSamplePathIndices = new Set(
          Array.from({ length: pathCount }, (_, index) => index),
        );
        refreshMonteCarloSampleViews();
      });
  }

  function renderMonteCarloSamplePathChart({
    monteCarloResults,
    cardId,
    subtitleId,
    canvasId,
    chartRef,
    assignChart,
    seriesKey,
    titleNoun,
  }) {
    const card = document.getElementById(cardId);
    const subtitle = document.getElementById(subtitleId);
    if (!card || !subtitle) return;

    const samplePaths = monteCarloResults?.[seriesKey] || [];
    activeMonteCarloResults = monteCarloResults;
    if (
      !monteCarloResults ||
      !monteCarloResults.trials ||
      !monteCarloResults.ageLabels?.length ||
      samplePaths.length === 0
    ) {
      if (chartRef) {
        chartRef.destroy();
        assignChart(null);
      }
      card.style.display = "none";
      subtitle.innerText = "";
      return;
    }

    card.style.display = "block";
    pruneSamplePathVisibility(samplePaths.length);
    const displayInflated = document.getElementById("displayMode").checked;
    const baseInflation =
      readUiFloat("inflation", SCENARIO_INPUT_DEFAULTS.inflationPct) / 100;
    const labels = monteCarloResults.ageLabels;
    const adjustedPaths = samplePaths.map((series, pathIndex) => {
      const pathInflationFactors = monteCarloResults.sampleInflationPaths || [];
      const inflationSeries = pathInflationFactors[pathIndex] || [];
      return series.map((value, idx) => {
        if (displayInflated) return value;
        const fallbackFactor = Math.pow(1 + baseInflation, idx);
        const displayFactor = inflationSeries[idx] || fallbackFactor;
        return value / displayFactor;
      });
    });
    const visiblePaths = adjustedPaths
      .map((series, index) => ({ series, index }))
      .filter(({ index }) => !hiddenSamplePathIndices.has(index));
    subtitle.innerText = `Showing ${visiblePaths.length.toLocaleString()} of ${adjustedPaths.length.toLocaleString()} sample ${titleNoun.toLowerCase()} path${adjustedPaths.length === 1 ? "" : "s"} from ${monteCarloResults.trials.toLocaleString()} completed trial${monteCarloResults.trials === 1 ? "" : "s"}${monteCarloResults.cancelled ? " (partial run)" : ""}. Values shown in ${displayInflated ? "inflated/nominal" : "today's"} dollars.`;

    const data = {
      labels,
      datasets: visiblePaths.map(({ series, index }) => ({
        label: `Path ${index + 1}`,
        data: series,
        borderColor: getSamplePathStroke(index, adjustedPaths.length),
        borderWidth: 1.8,
        pointRadius: 0,
        fill: false,
      })),
    };

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
          beginAtZero: true,
          min: 0,
          ticks: { callback: (v) => "$" + Number(v).toLocaleString() },
        },
      },
    };

    if (!chartRef) {
      assignChart(
        new Chart(document.getElementById(canvasId).getContext("2d"), {
          type: "line",
          data,
          options,
        }),
      );
      return;
    }

    chartRef.data = data;
    chartRef.options = options;
    chartRef.update("none");
  }

  function renderMonteCarloSampleAssetChart(monteCarloResults) {
    renderMonteCarloSamplePathChart({
      monteCarloResults,
      cardId: "mcSampleAssetCard",
      subtitleId: "mcSampleAssetSubtitle",
      canvasId: "mcSampleAssetChart",
      chartRef: mcSampleAssetChartInst,
      assignChart: (chart) => {
        mcSampleAssetChartInst = chart;
      },
      seriesKey: "sampleAssetPaths",
      titleNoun: "Asset",
    });
  }

  function renderMonteCarloSampleSpendChart(monteCarloResults) {
    renderMonteCarloSamplePathChart({
      monteCarloResults,
      cardId: "mcSampleSpendCard",
      subtitleId: "mcSampleSpendSubtitle",
      canvasId: "mcSampleSpendChart",
      chartRef: mcSampleSpendChartInst,
      assignChart: (chart) => {
        mcSampleSpendChartInst = chart;
      },
      seriesKey: "sampleSpendPaths",
      titleNoun: "Spending",
    });
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
    const runStatusEl = document.getElementById("runStatus");

    try {
      const inputs = readScenarioInputs(document, getValidatedSpendingSchedule);
      syncInputsToForm(inputs);
      updateDesiredSpendingBoundsStatus(inputs);
      saveInputs();

      const withAdaptiveWarning = (baseText) =>
        inputs.spendingMode === "input" && inputs.desiredSpendingBoundsError
          ? `${baseText} Adaptive desired spending was not applied: ${inputs.desiredSpendingBoundsError}`
          : baseText;

      const setRunStatus = (color, text) => {
        if (!runStatusEl) return;
        runStatusEl.style.color = color;
        runStatusEl.innerText = withAdaptiveWarning(text);
      };

      setRunButtonState({ running: false });

      const outcome = await runRetirementCalculation({
        inputs,
        runMonteCarloNow,
        lastMonteCarloResults,
        runMonteCarlo,
        solveSustainableSpending,
        runDeterministicProjection,
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
        onMonteCarloStart: (trials) => {
          if (runStatusEl) {
            runStatusEl.style.color = "#0369a1";
            runStatusEl.innerText = `Running simulation (${trials.toLocaleString()} trials)...`;
          }
          mcCancelRequested = false;
          mcIsRunning = true;
          setRunButtonState({ running: true });
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
          spendP10,
          spendP25,
          spendP50,
          spendP75,
          spendP90,
          sampleAssetPaths,
          sampleSpendPaths,
          sampleInflationPaths,
        ) => {
          if (runStatusEl) {
            const pct = ((done / total) * 100).toFixed(0);
            runStatusEl.innerText = `Running simulation: ${done.toLocaleString()} / ${total.toLocaleString()} (${pct}%)`;
            setRunButtonState({ running: true });
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
            spendP10,
            spendP25,
            spendP50,
            spendP75,
            spendP90,
            sampleAssetPaths,
            sampleSpendPaths,
            sampleInflationPaths,
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
          renderMonteCarloSpendPercentileChart({
            trials: done,
            requestedTrials: total,
            cancelled: false,
            bucketLabels,
            bucketCounts,
            ageLabels,
            spendP10,
            spendP25,
            spendP50,
            spendP75,
            spendP90,
          });
          renderMonteCarloSamplePathControls({
            trials: done,
            requestedTrials: total,
            cancelled: false,
            ageLabels,
            sampleAssetPaths,
            sampleSpendPaths,
          });
          renderMonteCarloSampleAssetChart({
            trials: done,
            requestedTrials: total,
            cancelled: false,
            ageLabels,
            sampleAssetPaths,
            sampleInflationPaths,
          });
          renderMonteCarloSampleSpendChart({
            trials: done,
            requestedTrials: total,
            cancelled: false,
            ageLabels,
            sampleSpendPaths,
            sampleInflationPaths,
          });
        },
        shouldCancel: () => mcCancelRequested,
      });

      mcIsRunning = false;
      setRunButtonState({ running: false });

      if (outcome.shouldPromptEnableMcForSolve && runStatusEl) {
        setRunStatus(
          "#b45309",
          "Enable simulation to solve sustainable spending.",
        );
      } else if (outcome.solveFailed && runStatusEl) {
        setRunStatus(
          "#b45309",
          "Could not solve sustainable spending: target success is unattainable even at $0 spend. Showing results for the current spend.",
        );
      } else if (
        outcome.enableMonteCarlo &&
        outcome.runMonteCarloNow &&
        outcome.monteCarloResults &&
        runStatusEl
      ) {
        if (outcome.monteCarloResults.cancelled) {
          setRunStatus(
            "#b45309",
            `Simulation cancelled after ${outcome.monteCarloResults.trials.toLocaleString()} / ${outcome.monteCarloResults.requestedTrials.toLocaleString()} trials.`,
          );
        } else {
          setRunStatus(
            "#166534",
            `Simulation complete: ${(outcome.monteCarloResults.successRate * 100).toFixed(1)}% success over ${outcome.monteCarloResults.trials.toLocaleString()} trials.`,
          );
        }
      } else if (
        outcome.enableMonteCarlo &&
        !outcome.runMonteCarloNow &&
        runStatusEl
      ) {
        setRunStatus(
          "#64748b",
          "Simulation inputs changed. Click Run Simulation to refresh probability results.",
        );
      } else if (runStatusEl) {
        setRunStatus("#64748b", "Deterministic mode ready.");
      }

      if (outcome.solvedSpendOutput !== null) {
        lastSolvedSpend = outcome.solvedSpendOutput;
        const spendingEl = document.getElementById("spending");
        if (spendingEl)
          spendingEl.value = Math.round(outcome.solvedSpendOutput);
      } else if (outcome.spendingMode === "rolling-amortization") {
        const firstYearSpendValue = document.getElementById(
          "firstYearSpendValue",
        );
        if (firstYearSpendValue)
          firstYearSpendValue.innerText = formatCurrency(
            outcome.currentYearSpending,
          );
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
        outcome.resultsWithoutRetirementCredits,
        outcome.monteCarloResults,
        outcome.enableMonteCarlo,
        outcome.monteCarloStale,
        lastMonteCarloMeta,
        outcome.solvedSpendOutput,
        outcome.targetSuccessRate,
        outcome.spendingMode,
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
    recalcTimer = setTimeout(() => {
      calculateRetirement(!enabled);
    }, 180);
  }

  function updateMonteCarloSettingsVisibility() {
    const enabled = document.getElementById("enableMonteCarlo").checked;
    const box = document.getElementById("mcSettingsBox");
    if (box) box.style.display = enabled ? "block" : "none";
    if (!enabled) {
      renderMonteCarloOutcomeChart(null);
      renderMonteCarloPercentileChart(null);
      renderMonteCarloSpendPercentileChart(null);
      renderMonteCarloSamplePathControls(null);
      renderMonteCarloSampleAssetChart(null);
      renderMonteCarloSampleSpendChart(null);
      return;
    }

    if (lastMonteCarloResults) {
      renderMonteCarloOutcomeChart(lastMonteCarloResults);
      renderMonteCarloPercentileChart(lastMonteCarloResults);
      renderMonteCarloSpendPercentileChart(lastMonteCarloResults);
      renderMonteCarloSamplePathControls(lastMonteCarloResults);
      renderMonteCarloSampleAssetChart(lastMonteCarloResults);
      renderMonteCarloSampleSpendChart(lastMonteCarloResults);
    }
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
      "Spending Policy": true,
      "Current Assets ($)": false,
      "Canada Pension Plan (CPP)": false,
      "Old Age Security (OAS)": false,
      "Guaranteed Income Supplement (GIS)": false,
      "RRIF Minimum Withdrawals": false,
      "Withdrawal Strategy": true,
      Simulation: true,
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

  function setupResultsCollapsibleCards() {
    let saved = {};
    try {
      saved = JSON.parse(
        localStorage.getItem("retirePlanner_resultsCardState") || "{}",
      );
    } catch {
      saved = {};
    }

    const cards = Array.from(
      document.querySelectorAll(".result-card.collapsible"),
    );
    cards.forEach((card) => {
      const heading = card.querySelector(":scope > h3");
      const body = card.querySelector(":scope > .result-body");
      if (!heading || !body) return;

      const key = card.id || heading.textContent.trim();
      const isOpen = Object.prototype.hasOwnProperty.call(saved, key)
        ? !!saved[key]
        : true;

      body.style.display = isOpen ? "block" : "none";
      card.classList.toggle("collapsed", !isOpen);

      heading.addEventListener("click", () => {
        const nowOpen = card.classList.contains("collapsed");
        card.classList.toggle("collapsed", !nowOpen);
        body.style.display = nowOpen ? "block" : "none";
        saved[key] = nowOpen;
        try {
          localStorage.setItem(
            "retirePlanner_resultsCardState",
            JSON.stringify(saved),
          );
        } catch {}
        if (nowOpen) {
          balanceChartInst?.resize();
          incomeChartInst?.resize();
          mcOutcomeChartInst?.resize();
          mcPercentileChartInst?.resize();
          mcSpendPercentileChartInst?.resize();
          mcSampleAssetChartInst?.resize();
          mcSampleSpendChartInst?.resize();
        }
      });
    });
  }

  function updateSpendingModeVisibility() {
    const mode = document.getElementById("spendingMode").value;
    const targetEl = document.getElementById("targetSuccessGroup");
    const precisionEl = document.getElementById("solvePrecisionGroup");
    const amortizationEl = document.getElementById("amortizationRateGroup");
    const targetEstateEl = document.getElementById("targetEstateValueGroup");
    const minSpendEl = document.getElementById("rollingMinSpendGroup");
    const maxSpendEl = document.getElementById("rollingMaxSpendGroup");
    const desiredAdaptiveEl = document.getElementById(
      "desiredAdaptiveSpendingGroup",
    );
    const scheduleGroup = document.getElementById("spendingScheduleGroup");
    const scheduleWrap = document.getElementById("spendingScheduleContainer");
    const scheduleNote = document.getElementById("spendingScheduleSolveNote");
    const scheduleStatus = document.getElementById("spendingScheduleStatus");
    const spendingInput = document.getElementById("spending");
    const spendingLabel = document.getElementById("spendingLabel");
    const spendingInputGroup = document.getElementById("spendingInputGroup");
    const firstYearSpendSummary = document.getElementById(
      "firstYearSpendSummary",
    );
    const spendingHelp = document.getElementById("spendingModeHelp");
    const toggle = document.getElementById("spendingModeToggle");
    const isInputMode = mode === "input";
    const isSolveMode = mode === "solve";
    const isRollingMode = mode === "rolling-amortization";

    if (toggle) {
      toggle.querySelectorAll("button[data-mode]").forEach((btn) => {
        btn.classList.toggle("active", btn.dataset.mode === mode);
      });
    }

    if (targetEl) targetEl.style.display = isSolveMode ? "block" : "none";
    if (precisionEl) precisionEl.style.display = isSolveMode ? "block" : "none";
    if (amortizationEl)
      amortizationEl.style.display = isRollingMode ? "block" : "none";
    if (targetEstateEl)
      targetEstateEl.style.display = isRollingMode ? "block" : "none";
    if (minSpendEl) minSpendEl.style.display = isRollingMode ? "block" : "none";
    if (maxSpendEl) maxSpendEl.style.display = isRollingMode ? "block" : "none";
    if (desiredAdaptiveEl)
      desiredAdaptiveEl.style.display = isInputMode ? "block" : "none";
    if (scheduleGroup) scheduleGroup.style.display = "block";
    if (scheduleWrap)
      scheduleWrap.style.display = isSolveMode ? "none" : "block";
    if (scheduleNote)
      scheduleNote.style.display = isSolveMode ? "block" : "none";
    if (scheduleStatus)
      scheduleStatus.style.display = isSolveMode ? "none" : "block";
    if (spendingInputGroup)
      spendingInputGroup.style.display = isRollingMode ? "none" : "grid";
    if (firstYearSpendSummary)
      firstYearSpendSummary.style.display = isRollingMode ? "block" : "none";
    if (spendingInput) {
      spendingInput.readOnly = isSolveMode;
      spendingInput.style.backgroundColor = isSolveMode ? "#f1f5f9" : "#fff";
      spendingInput.style.cursor = isSolveMode ? "not-allowed" : "text";
    }
    if (spendingLabel)
      spendingLabel.innerText = isSolveMode
        ? "Solved Net Spend/Yr"
        : isRollingMode
          ? "Rolling Net Spend/Yr"
          : "Desired Net Spend/Yr";
    if (spendingInputGroup)
      spendingInputGroup.style.opacity = isSolveMode ? "0.9" : "1";
    if (spendingHelp)
      spendingHelp.innerText = isSolveMode
        ? "Solves a flat spend to hit your simulation success target."
        : isRollingMode
          ? "Recomputes annual spend from remaining assets, remaining years, amortization rate, and target estate value, then applies your min/max spend bounds. Simulation negative-return spending cuts are ignored in this mode."
          : "Uses your entered spend as the target. Monte Carlo can flex spending between your min/max bounds based on annual returns.";
    if (!isInputMode) updateDesiredSpendingBoundsStatus({ spendingMode: mode });
    if (scheduleNote)
      scheduleNote.innerText =
        "Age adjustments are ignored in sustainable mode because the solver uses one flat annual spend.";
    updateSpendingScheduleLabels();
  }

  function updateUI(
    results,
    resultsWithoutRetirementCredits,
    monteCarloResults,
    monteCarloEnabled,
    monteCarloStale,
    monteCarloMeta,
    solvedSpendOutput,
    targetSuccessRate,
    spendingMode,
  ) {
    // Presentation layer only: charts, table, summary cards, and explanatory copy.
    if (!Array.isArray(results) || results.length === 0) {
      const runStatusEl = document.getElementById("runStatus");
      if (runStatusEl) {
        runStatusEl.style.color = "#b45309";
        runStatusEl.innerText =
          "Unable to generate a projection from the current inputs. Missing numeric fields were reset to defaults.";
      }
      document.getElementById("tableBody").innerHTML = "";
      document.getElementById("summaryGrid").innerHTML = "";
      renderMonteCarloOutcomeChart(null);
      renderMonteCarloPercentileChart(null);
      renderMonteCarloSpendPercentileChart(null);
      renderMonteCarloSamplePathControls(null);
      renderMonteCarloSampleAssetChart(null);
      renderMonteCarloSampleSpendChart(null);
      const debugEl = document.getElementById("debugSummary");
      if (debugEl) {
        debugEl.style.display = "none";
        debugEl.innerHTML = "";
      }
      return;
    }

    const displayInflated = document.getElementById("displayMode").checked;
    const inflation =
      readUiFloat("inflation", SCENARIO_INPUT_DEFAULTS.inflationPct) / 100;

    const adj = (val, idx) =>
      displayInflated ? val : val / Math.pow(1 + inflation, idx);

    const comparisonRows = Array.isArray(resultsWithoutRetirementCredits)
      ? results.map((row, idx) => {
          const noCreditRow = resultsWithoutRetirementCredits[idx];
          const annualTaxWithCredits = adj(row.incomeTax, row.yearIndex);
          const annualTaxWithoutCredits = noCreditRow
            ? adj(noCreditRow.incomeTax, noCreditRow.yearIndex)
            : annualTaxWithCredits;
          return {
            age: row.age,
            annualTaxWithCredits,
            annualTaxWithoutCredits,
            annualTaxSavings: Math.max(
              0,
              annualTaxWithoutCredits - annualTaxWithCredits,
            ),
          };
        })
      : [];

    const strSuffix = displayInflated
      ? "(Inflated/Nominal Dollars)"
      : "(Today's Dollars)";
    const mcSuffix = monteCarloEnabled ? " - Baseline Path" : "";
    document.getElementById("chart1Title").innerText =
      `Asset Balances Over Time ${strSuffix}${mcSuffix}`;
    document.getElementById("chart2Title").innerText =
      `Gross Income Sources vs Net Target ${strSuffix}${mcSuffix}`;
    document.getElementById("tableSubtitle").innerText = "";
    const summarySubtitleEl = document.getElementById("summarySubtitle");
    if (summarySubtitleEl) summarySubtitleEl.innerText = "";

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
                <td>${formatCurrency(adj(r.gis || 0, r.yearIndex))}</td>
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
      totGIS = 0,
      totTax = 0,
      totClawback = 0,
      totTaxWithoutCredits = 0;
    results.forEach((r) => {
      totRRSP += adj(r.drawRRSP, r.yearIndex);
      totTFSA += adj(r.drawTFSA, r.yearIndex);
      totNonReg += adj(r.drawNonReg, r.yearIndex);
      totCPP += adj(r.cpp, r.yearIndex);
      totOAS += adj(r.oas, r.yearIndex);
      totGIS += adj(r.gis || 0, r.yearIndex);
      totTax += adj(r.incomeTax, r.yearIndex);
      totClawback += adj(r.oasClawback, r.yearIndex);
    });
    comparisonRows.forEach((r) => {
      totTaxWithoutCredits += r.annualTaxWithoutCredits;
    });

    const finalRow = results[results.length - 1];
    const finalEstateGross = adj(finalRow.total, finalRow.yearIndex);
    const finalEstateNet = adj(finalRow.estateAfterTax, finalRow.yearIndex);
    const finalEstateTax = adj(finalRow.terminalEstateTax, finalRow.yearIndex);
    const depleted = finalRow.depleted;
    const totalTaxSavings = Math.max(0, totTaxWithoutCredits - totTax);
    const gisEnabled = document.getElementById("enableGIS")?.checked;
    const hasAge65Year = results.some((r) => r.age >= 65);
    const hasOasYear = results.some((r) => (r.oas || 0) > 0);

    if (summarySubtitleEl && gisEnabled && totGIS <= 0.5) {
      summarySubtitleEl.innerText = !hasAge65Year
        ? "GIS is enabled, but this projection never reaches age 65."
        : !hasOasYear
          ? "GIS is enabled, but OAS is not being received in this projection."
          : "GIS is enabled, but prior-year income stays high enough that the model pays no GIS.";
    }

    document.getElementById("summaryGrid").innerHTML = `
            <div class="summary-box ${depleted ? "alert" : "highlight"}">
                <div class="summary-title">${depleted ? "Depleted At Age" : "Final Estate Value Net of Estimated Terminal Tax (Age " + finalRow.age + ")"}</div>
                <div class="summary-value">${depleted ? finalRow.age : formatCurrency(finalEstateNet)}</div>
                ${depleted ? "" : `<div class="summary-subtext">Gross estate: ${formatCurrency(finalEstateGross)}<br>Estimated terminal tax: ${formatCurrency(finalEstateTax)}</div>`}
            </div>
            <div class="summary-box">
                <div class="summary-title">Total Portfolio Drawn</div>
                <div class="summary-value">${formatCurrency(totRRSP + totTFSA + totNonReg)}</div>
            </div>
            <div class="summary-box">
                <div class="summary-title">Total CPP + OAS + GIS (Gross)</div>
                <div class="summary-value">${formatCurrency(totCPP + totOAS + totGIS)}</div>
            </div>
            <div class="summary-box">
                <div class="summary-title">Total GIS (Gross)</div>
                <div class="summary-value">${formatCurrency(totGIS)}</div>
            </div>
            <div class="summary-box alert">
                <div class="summary-title">Total Income Tax Paid</div>
                <div class="summary-value">${formatCurrency(totTax)}</div>
            </div>
            <div class="summary-box">
                <div class="summary-title">Tax Saved From Retirement Credits</div>
                <div class="summary-value">${formatCurrency(totalTaxSavings)}</div>
            </div>
            <div class="summary-box alert">
                <div class="summary-title">Total OAS Clawback</div>
                <div class="summary-value">${formatCurrency(totClawback)}</div>
            </div>
        `;

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
        spendingMode === "solve" && solvedSpendOutput !== null
          ? `Solved sustainable spend (today's dollars): ${formatCurrency(solvedSpendOutput)} at ${(targetSuccessRate * 100).toFixed(0)}% target success`
          : "";
      const mcSummaryLines = [
        `Trials completed: ${monteCarloResults.trials.toLocaleString()} / ${monteCarloResults.requestedTrials.toLocaleString()}`,
        `Success probability: ${(monteCarloResults.successRate * 100).toFixed(1)}%`,
        `Failure probability: ${(failRate * 100).toFixed(1)}%`,
        `Median depletion age (failed paths): ${depText}`,
        `Final estate, gross (P10 / Median / P90): ${formatCurrency(monteCarloResults.p10FinalEstate)} / ${formatCurrency(monteCarloResults.medianFinalEstate)} / ${formatCurrency(monteCarloResults.p90FinalEstate)}`,
        `Avg lifetime tax / clawback: ${formatCurrency(monteCarloResults.avgTax)} / ${formatCurrency(monteCarloResults.avgClawback)}`,
        `Last run: ${runAt}`,
        `Settings used (model / trials / return vol / inflation vol / seed): ${monteCarloMeta?.model === "fat-tail" ? "Fat-tail MC" : "Normal MC"} / ${(monteCarloMeta?.trials ?? monteCarloResults.trials).toLocaleString()} / ${((monteCarloMeta?.returnVolatility ?? 0) * 100).toFixed(1)}% / ${((monteCarloMeta?.inflationVolatility ?? 0) * 100).toFixed(1)}% / ${seedText}`,
        `Sample paths shown: ${monteCarloMeta?.samplePathCount ?? monteCarloResults.sampleAssetPaths?.length ?? 0}`,
        solvedLine,
        partialLine,
        staleLine,
      ];

      if (mcEl) {
        mcEl.style.display = "none";
        mcEl.innerHTML = "";
      }

      console.info(
        "Simulation Summary:\n" +
          mcSummaryLines
            .map((line) => String(line).replace(/<[^>]*>/g, ""))
            .filter((line) => line.trim().length > 0)
            .join("\n"),
      );
    } else {
      if (mcEl) {
        mcEl.style.display = "none";
        mcEl.innerHTML = "";
      }
    }

    if (monteCarloEnabled) {
      renderMonteCarloOutcomeChart(monteCarloResults);
      renderMonteCarloPercentileChart(monteCarloResults);
      renderMonteCarloSpendPercentileChart(monteCarloResults);
      renderMonteCarloSamplePathControls(monteCarloResults);
      renderMonteCarloSampleAssetChart(monteCarloResults);
      renderMonteCarloSampleSpendChart(monteCarloResults);
    } else {
      renderMonteCarloOutcomeChart(null);
      renderMonteCarloPercentileChart(null);
      renderMonteCarloSpendPercentileChart(null);
      renderMonteCarloSamplePathControls(null);
      renderMonteCarloSampleAssetChart(null);
      renderMonteCarloSampleSpendChart(null);
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
    const grossIncomeStackValues = results.map(
      (r) =>
        adj(r.cpp, r.yearIndex) +
        adj(r.oas, r.yearIndex) +
        adj(r.gis || 0, r.yearIndex) +
        adj(r.drawRRSP, r.yearIndex) +
        adj(r.drawTFSA, r.yearIndex) +
        adj(r.drawNonReg, r.yearIndex),
    );
    const effectiveTaxRatePct = results.map((r) => {
      const spending = adj(r.spending, r.yearIndex);
      const incomeTax = adj(r.incomeTax, r.yearIndex);
      if (spending <= 0) return 0;
      return (incomeTax / spending) * 100;
    });
    const overlayTaxValues = [
      ...results.map((r) => adj(r.spending, r.yearIndex)),
      ...results.map((r) => adj(r.oasClawback, r.yearIndex)),
      ...results.map((r) => adj(r.incomeTax, r.yearIndex)),
      ...comparisonRows.map((r) => r.annualTaxWithoutCredits),
    ];
    const sharedIncomeMax =
      Math.max(0, ...grossIncomeStackValues, ...overlayTaxValues) * 1.05 || 1;
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
              yAxisID: "yOverlay",
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
              label: "GIS",
              data: results.map((r) => adj(r.gis || 0, r.yearIndex)),
              backgroundColor: cssVar("--color-gis"),
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
              yAxisID: "yOverlay",
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
              yAxisID: "yOverlay",
              order: 0,
            },
            {
              type: "line",
              label: "Income Tax Without Credits",
              data: comparisonRows.map((r) => r.annualTaxWithoutCredits),
              borderColor: "#94a3b8",
              borderWidth: 2,
              borderDash: [6, 4],
              fill: false,
              pointRadius: 0,
              yAxisID: "yOverlay",
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
                footer: function (tooltipItems) {
                  const incomeTaxItem = tooltipItems.find(
                    (item) => item.dataset.label === "Income Tax",
                  );
                  const noCreditItem = tooltipItems.find(
                    (item) =>
                      item.dataset.label === "Income Tax Without Credits",
                  );
                  if (!incomeTaxItem || !noCreditItem) return "";
                  const taxSaved = Math.max(
                    0,
                    noCreditItem.parsed.y - incomeTaxItem.parsed.y,
                  );
                  return `Tax Saved: ${new Intl.NumberFormat("en-CA", {
                    style: "currency",
                    currency: "CAD",
                    maximumFractionDigits: 0,
                  }).format(taxSaved)}`;
                },
              },
            },
          },
          scales: {
            x: { stacked: true },
            y: {
              stacked: true,
              min: 0,
              max: sharedIncomeMax,
              ticks: {
                callback: function (v) {
                  return "$" + v.toLocaleString();
                },
              },
            },
            yOverlay: {
              position: "left",
              min: 0,
              max: sharedIncomeMax,
              grid: { drawOnChartArea: false, display: false },
              ticks: { display: false },
              border: { display: false },
            },
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
  setupResultsCollapsibleCards();
  loadInputs();
  loadSpendingSchedule();
  updateMonteCarloSettingsVisibility();
  updateSpendingModeVisibility();

  const spendingModeToggle = document.getElementById("spendingModeToggle");
  if (spendingModeToggle) {
    spendingModeToggle.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-mode]");
      if (!btn) return;
      const modeInput = document.getElementById("spendingMode");
      if (!modeInput) return;
      const prevMode = modeInput.value;
      modeInput.value = btn.dataset.mode;

      if (prevMode === "input" && modeInput.value !== "input") {
        const spendEl = document.getElementById("spending");
        const val = spendEl ? parseFloat(spendEl.value) : NaN;
        desiredSpendBeforeSolve = Number.isFinite(val)
          ? val
          : desiredSpendBeforeSolve;
      }

      if (prevMode !== "input" && modeInput.value === "input") {
        const spendEl = document.getElementById("spending");
        const solvedSpend =
          prevMode === "solve" && Number.isFinite(lastSolvedSpend)
            ? lastSolvedSpend
            : parseFloat(spendEl?.value) || 0;
        const desiredSpend = Number.isFinite(desiredSpendBeforeSolve)
          ? desiredSpendBeforeSolve
          : solvedSpend;

        if (
          prevMode === "solve" &&
          spendEl &&
          Number.isFinite(solvedSpend) &&
          Math.round(desiredSpend) !== Math.round(solvedSpend)
        ) {
          spendEl.value = Math.round(desiredSpend);
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
      let nextStart = readUiInt("age", SCENARIO_INPUT_DEFAULTS.age);
      const lifeExpectancy = readUiInt(
        "lifeExpectancy",
        SCENARIO_INPUT_DEFAULTS.lifeExpectancy,
      );
      let nextAmount = 100;
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
        if (id === "enableMonteCarlo") {
          updateMonteCarloSettingsVisibility();
          saveInputs();
          return;
        }
        if (id === "spendingMode") updateSpendingModeVisibility();

        if (id === "age" || id === "lifeExpectancy") {
          const rows = document.querySelectorAll(
            "#spendingScheduleRows .spending-row",
          );
          if (rows.length === 1) {
            const r = rows[0];
            if (id === "age") r.querySelector(".sched-start").value = el.value;
            if (id === "lifeExpectancy")
              r.querySelector(".sched-end").value = el.value;
            saveSpendingSchedule();
          }
        }

        recalculateForUiChange();
      });
  });

  // Bind the button
  const runBtn = document.getElementById("calcBtn");
  if (runBtn)
    runBtn.addEventListener("click", () => {
      if (!mcIsRunning) return;
      mcCancelRequested = true;
      const runStatusEl = document.getElementById("runStatus");
      if (runStatusEl) {
        runStatusEl.style.color = "#b45309";
        runStatusEl.innerText = "Stopping simulation after current batch...";
      }
      return;
    });
  if (runBtn)
    runBtn.addEventListener("click", () => {
      if (mcIsRunning) return;
      calculateRetirement(true);
    });

  calculateRetirement(false);
});
