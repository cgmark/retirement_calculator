export const provData = {
  ON: { bpa: 12399, lowestRate: 0.0505, brackets: [{ limit: 51446, rate: 0.0505 }, { limit: 102894, rate: 0.0915 }, { limit: 150000, rate: 0.1116 }, { limit: 220000, rate: 0.1216 }, { limit: Infinity, rate: 0.1316 }] },
  BC: { bpa: 12580, lowestRate: 0.0506, brackets: [{ limit: 47937, rate: 0.0506 }, { limit: 95875, rate: 0.077 }, { limit: 110076, rate: 0.105 }, { limit: 133797, rate: 0.1229 }, { limit: 181232, rate: 0.147 }, { limit: 252752, rate: 0.168 }, { limit: Infinity, rate: 0.205 }] },
  AB: { bpa: 21885, lowestRate: 0.1, brackets: [{ limit: 148269, rate: 0.1 }, { limit: 177922, rate: 0.12 }, { limit: 237230, rate: 0.13 }, { limit: 355845, rate: 0.14 }, { limit: Infinity, rate: 0.15 }] },
  QC: { bpa: 18056, lowestRate: 0.14, brackets: [{ limit: 51780, rate: 0.14 }, { limit: 103545, rate: 0.19 }, { limit: 126000, rate: 0.24 }, { limit: Infinity, rate: 0.2575 }] },
  MB: { bpa: 15780, lowestRate: 0.108, brackets: [{ limit: 47000, rate: 0.108 }, { limit: 100000, rate: 0.1275 }, { limit: Infinity, rate: 0.174 }] },
  SK: { bpa: 18491, lowestRate: 0.105, brackets: [{ limit: 52057, rate: 0.105 }, { limit: 148734, rate: 0.125 }, { limit: Infinity, rate: 0.145 }] },
  NS: { bpa: 11481, lowestRate: 0.0879, brackets: [{ limit: 29590, rate: 0.0879 }, { limit: 59180, rate: 0.1495 }, { limit: 93000, rate: 0.1667 }, { limit: 150000, rate: 0.175 }, { limit: Infinity, rate: 0.21 }] },
  NB: { bpa: 13044, lowestRate: 0.094, brackets: [{ limit: 49958, rate: 0.094 }, { limit: 99916, rate: 0.14 }, { limit: 185064, rate: 0.16 }, { limit: Infinity, rate: 0.195 }] },
  NL: { bpa: 10818, lowestRate: 0.087, brackets: [{ limit: 43198, rate: 0.087 }, { limit: 86395, rate: 0.145 }, { limit: 154244, rate: 0.158 }, { limit: 215943, rate: 0.178 }, { limit: 275870, rate: 0.198 }, { limit: 551739, rate: 0.208 }, { limit: Infinity, rate: 0.218 }] },
  PE: { bpa: 13500, lowestRate: 0.0965, brackets: [{ limit: 32759, rate: 0.0965 }, { limit: 64313, rate: 0.1363 }, { limit: 105000, rate: 0.1665 }, { limit: 140000, rate: 0.1875 }, { limit: Infinity, rate: 0.1875 }] }
};

export function calculateTax(income, provCode, inflFactor) {
  if (income <= 0) return 0;

  const fedBPA = 15705 * inflFactor;
  const fedBrackets = [
    { limit: 55867 * inflFactor, rate: 0.15 },
    { limit: 111733 * inflFactor, rate: 0.205 },
    { limit: 173205 * inflFactor, rate: 0.26 },
    { limit: 246752 * inflFactor, rate: 0.29 },
    { limit: Infinity, rate: 0.33 }
  ];

  // Compute progressive federal tax, then apply BPA credit at the lowest fed rate.
  let fedTax = 0;
  let prevLimit = 0;
  for (const b of fedBrackets) {
    if (income > prevLimit) fedTax += (Math.min(income, b.limit) - prevLimit) * b.rate;
    prevLimit = b.limit;
  }
  fedTax -= fedBPA * 0.15;
  if (fedTax < 0) fedTax = 0;

  // Province tax uses province-specific brackets and BPA/credit rate.
  const pData = provData[provCode];
  const provBPA = pData.bpa * inflFactor;
  let provTax = 0;
  prevLimit = 0;
  for (const b of pData.brackets) {
    const limit = b.limit * inflFactor;
    if (income > prevLimit) provTax += (Math.min(income, limit) - prevLimit) * b.rate;
    prevLimit = limit;
  }
  provTax -= provBPA * pData.lowestRate;
  if (provTax < 0) provTax = 0;

  // Ontario applies provincial surtax on top of basic ON provincial tax.
  // Thresholds are inflation-adjusted here to stay consistent with the rest of the model.
  if (provCode === "ON") {
    const s1 = 5315 * inflFactor;
    const s2 = 6802 * inflFactor;
    let surtax = 0;
    if (provTax > s1) surtax += (provTax - s1) * 0.2;
    if (provTax > s2) surtax += (provTax - s2) * 0.36;
    provTax += surtax;
  }

  return fedTax + provTax;
}

export function findGrossDraw(neededNet, maxGrossAvailable, currentTaxableInc, incRate, provCode, inflFactor) {
  if (neededNet <= 0) return { gross: 0, net: 0, tax: 0, taxableAdd: 0 };

  let low = 0;
  let high = Math.min(neededNet * 5, maxGrossAvailable);
  const maxTaxableAdd = maxGrossAvailable * incRate;
  const maxTax = calculateTax(currentTaxableInc + maxTaxableAdd, provCode, inflFactor) - calculateTax(currentTaxableInc, provCode, inflFactor);
  const maxNet = maxGrossAvailable - maxTax;

  if (maxNet <= neededNet) {
    return { gross: maxGrossAvailable, net: maxNet, tax: maxTax, taxableAdd: maxTaxableAdd };
  }

  // Binary-search gross draw so post-tax net is as close as possible to neededNet.
  for (let i = 0; i < 30; i++) {
    const mid = (low + high) / 2;
    const taxAdd = mid * incRate;
    const tax = calculateTax(currentTaxableInc + taxAdd, provCode, inflFactor) - calculateTax(currentTaxableInc, provCode, inflFactor);
    const net = mid - tax;
    if (net < neededNet) low = mid;
    else high = mid;
  }

  const finalGross = (low + high) / 2;
  const finalTaxAdd = finalGross * incRate;
  const finalTax = calculateTax(currentTaxableInc + finalTaxAdd, provCode, inflFactor) - calculateTax(currentTaxableInc, provCode, inflFactor);
  return { gross: finalGross, net: finalGross - finalTax, tax: finalTax, taxableAdd: finalTaxAdd };
}
