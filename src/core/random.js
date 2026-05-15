export function createSeededRng(seed) {
  // Mulberry32 PRNG: fast, deterministic, and good enough for UI Monte Carlo use.
  let s = seed >>> 0;
  return function rng() {
    s += 0x6d2b79f5;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randomNormal(rng) {
  // Box-Muller transform from uniform(0,1) -> standard normal N(0,1).
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function randomStudentT(rng, degreesOfFreedom = 5) {
  if (degreesOfFreedom <= 2) {
    throw new Error("degreesOfFreedom must be greater than 2");
  }

  let chiSquare = 0;
  for (let i = 0; i < degreesOfFreedom; i++) {
    const z = randomNormal(rng);
    chiSquare += z * z;
  }

  return randomNormal(rng) / Math.sqrt(chiSquare / degreesOfFreedom);
}

export function randomShock(rng, model = "normal") {
  if (model === "fat-tail") {
    const degreesOfFreedom = 5;
    const varianceScale = Math.sqrt((degreesOfFreedom - 2) / degreesOfFreedom);
    return randomStudentT(rng, degreesOfFreedom) * varianceScale;
  }

  return randomNormal(rng);
}

export function percentile(values, p) {
  if (!values.length) return 0;
  // Nearest-rank style index keeps outputs stable across reruns/tests.
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.max(
    0,
    Math.min(sorted.length - 1, Math.round((p / 100) * (sorted.length - 1))),
  );
  return sorted[idx];
}
