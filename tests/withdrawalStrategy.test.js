import { describe, expect, it } from "vitest";
import {
  applyProportionalDraw,
  applyWeightedMixDraw,
  applySequenceDraw,
  applyEarlyRetirementDraw,
} from "../src/core/withdrawalStrategy.js";

describe("withdrawal strategy helpers", () => {
  it("applies sequence draw in configured order", () => {
    const calls = [];
    let netNeeded = 100;
    const executeDraw = (acc, targetNet) => {
      calls.push([acc, targetNet]);
      netNeeded = 0;
    };

    applySequenceDraw({
      strategy: "tfsa-rrsp-nonreg",
      targetNet: 100,
      getNetNeeded: () => netNeeded,
      executeDraw,
    });

    expect(calls.map((c) => c[0])).toEqual(["tfsa", "rrsp", "nonreg"]);
  });

  it("splits proportional draw by balances", () => {
    const calls = [];
    let netNeeded = 60;
    const executeDraw = (acc, targetNet) => {
      calls.push([acc, targetNet]);
      netNeeded -= targetNet;
    };

    applyProportionalDraw({
      getBalances: () => ({ rrsp: 30, tfsa: 20, nonreg: 10 }),
      getNetNeeded: () => netNeeded,
      executeDraw,
      iterations: 1,
    });

    expect(calls.length).toBe(3);
    expect(calls[0][1]).toBeCloseTo(20);
    expect(calls[1][1]).toBeCloseTo(10);
    expect(calls[2][1]).toBeCloseTo(30);
  });

  it("uses weighted mix and fallback", () => {
    const calls = [];
    let netNeeded = 100;
    const executeDraw = (acc, targetNet) => {
      calls.push([acc, targetNet]);
      netNeeded = Math.max(0, netNeeded - targetNet);
    };

    applyWeightedMixDraw({
      getBalances: () => ({ rrsp: 100, tfsa: 100, nonreg: 100 }),
      getNetNeeded: () => netNeeded,
      executeDraw,
      mix: { tfsa: 0.5, nonreg: 0.3, rrsp: 0.2 },
      iterations: 1,
      allowFallback: true,
    });

    expect(calls[0][0]).toBe("tfsa");
    expect(calls[1][0]).toBe("nonreg");
    expect(calls[2][0]).toBe("rrsp");
    expect(calls.length).toBeGreaterThanOrEqual(3);
  });

  it("early-retirement draws rrsp then nonreg", () => {
    const calls = [];
    let netNeeded = 5000;
    let taxableIncome = 50000;
    const balances = { rrsp: 100000, tfsa: 100000, nonreg: 100000 };

    const executeDraw = (acc, targetNet) => {
      calls.push([acc, targetNet]);
      const used = Math.min(netNeeded, targetNet);
      if (acc === "rrsp") taxableIncome += used;
      if (acc === "rrsp") balances.rrsp = Math.max(0, balances.rrsp - used);
      if (acc === "nonreg")
        balances.nonreg = Math.max(0, balances.nonreg - used);
      if (acc === "tfsa") balances.tfsa = Math.max(0, balances.tfsa - used);
      netNeeded = Math.max(0, netNeeded - used);
    };

    applyEarlyRetirementDraw({
      getBalances: () => balances,
      getNetNeeded: () => netNeeded,
      getCurrentTaxableIncome: () => taxableIncome,
      getGrossOAS: () => 0,
      executeDraw,
      provCode: "ON",
      inflationFactor: 1,
    });

    expect(calls[0][0]).toBe("rrsp");
    if (calls.length > 1) expect(calls[1][0]).toBe("nonreg");
  });
});
