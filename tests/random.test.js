import { describe, expect, it } from "vitest";
import {
  createSeededRng,
  percentile,
  randomNormal,
} from "../src/core/random.js";

describe("random helpers", () => {
  it("seeded rng is deterministic", () => {
    const a = createSeededRng(3);
    const b = createSeededRng(3);
    const seqA = [a(), a(), a(), a(), a()];
    const seqB = [b(), b(), b(), b(), b()];
    expect(seqA).toEqual(seqB);
  });

  it("randomNormal returns finite values", () => {
    const rng = createSeededRng(42);
    const values = Array.from({ length: 1000 }, () => randomNormal(rng));
    expect(values.every(Number.isFinite)).toBe(true);
  });

  it("percentile selects expected value", () => {
    expect(percentile([1, 2, 3, 4, 5], 50)).toBe(3);
    expect(percentile([1, 2, 3, 4, 5], 10)).toBe(1);
  });
});
