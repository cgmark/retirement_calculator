import { describe, expect, it } from "vitest";
import { getRrifMinimumRate } from "../src/core/rrif.js";

describe("getRrifMinimumRate", () => {
  it("returns 0 before age 71", () => {
    expect(getRrifMinimumRate(70)).toBe(0);
  });

  it("returns table rate for known ages", () => {
    expect(getRrifMinimumRate(71)).toBe(0.0528);
    expect(getRrifMinimumRate(80)).toBe(0.0682);
  });

  it("caps to 20% at age 95+", () => {
    expect(getRrifMinimumRate(95)).toBe(0.2);
    expect(getRrifMinimumRate(100)).toBe(0.2);
  });
});
