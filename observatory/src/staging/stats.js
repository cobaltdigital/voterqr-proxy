'use strict';

/** Small statistics helpers for the trends worker. Kept separate so they are easy to test. */

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

function stdev(xs) {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((acc, x) => acc + (x - m) ** 2, 0) / (xs.length - 1));
}

/** How many standard deviations `value` sits from the baseline. */
function zScore(value, baseline) {
  const sd = stdev(baseline);
  if (!sd) return 0;
  return (value - mean(baseline)) / sd;
}

/** Ordinary least squares on index vs value; r2 says how much of the movement the line explains. */
function linearRegression(ys) {
  const n = ys.length;
  if (n < 3) return { slope: 0, intercept: ys[0] || 0, r2: 0 };
  const xs = ys.map((_, i) => i);
  const mx = mean(xs);
  const my = mean(ys);
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i += 1) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) ** 2;
  }
  const slope = den ? num / den : 0;
  const intercept = my - slope * mx;
  const ssTot = ys.reduce((acc, y) => acc + (y - my) ** 2, 0);
  const ssRes = ys.reduce((acc, y, i) => acc + (y - (slope * i + intercept)) ** 2, 0);
  return { slope, intercept, r2: ssTot ? 1 - ssRes / ssTot : 0 };
}

function pearson(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 3) return 0;
  const xa = a.slice(0, n);
  const xb = b.slice(0, n);
  const ma = mean(xa);
  const mb = mean(xb);
  let num = 0;
  let da = 0;
  let dbb = 0;
  for (let i = 0; i < n; i += 1) {
    num += (xa[i] - ma) * (xb[i] - mb);
    da += (xa[i] - ma) ** 2;
    dbb += (xb[i] - mb) ** 2;
  }
  const den = Math.sqrt(da * dbb);
  return den ? num / den : 0;
}

module.exports = { mean, stdev, zScore, linearRegression, pearson };
