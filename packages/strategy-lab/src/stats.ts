/**
 * Performance statistics for strategy evidence.
 *
 * NOTE ON INTERPRETATION. Statistical significance is not economic significance: a mean of +0.01R per trade can
 * be "significant" over enough trades and still be worthless after real-world frictions, while a genuinely good
 * strategy can fail a significance test over a short sample. None of these numbers proves a strategy works.
 * Promotion therefore combines a conservative statistical criterion (the LOWER confidence bound of expectancy
 * after costs must clear a minimum) with economic checks (drawdown, losing streak, degradation versus the
 * out-of-sample validation period) - see apps/api/src/lab-strategies/lab-lifecycle.ts.
 */

export interface PerformanceSummary {
  trades: number;
  meanR: number;
  medianR: number;
  sdR: number;
  /** Standard error of the mean */
  seR: number;
  /** Bootstrap confidence interval for the mean (expectancy), at `confidence` */
  ciLowR: number;
  ciHighR: number;
  confidence: number;
  totalR: number;
  maxDrawdownR: number;
  /** Gross wins / gross losses (Infinity when there is no losing trade) */
  profitFactor: number;
  winRate: number;
  longestLosingStreak: number;
}

/** Deterministic PRNG (so the same results always give the same confidence interval). */
function lcg(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * Percentile bootstrap of the mean: `runs` resamples (with replacement) of the results, deterministic for a given
 * seed. Returns [low, high] at the given two-sided confidence.
 */
export function bootstrapMeanCI(results: number[], confidence = 0.95, runs = 2000, seed = 12345): [number, number] {
  const n = results.length;
  if (n === 0) return [NaN, NaN];
  if (n === 1) return [results[0], results[0]];
  const rnd = lcg(seed);
  const means = new Float64Array(runs);
  for (let r = 0; r < runs; r++) {
    let sum = 0;
    for (let k = 0; k < n; k++) sum += results[Math.floor(rnd() * n)];
    means[r] = sum / n;
  }
  means.sort();
  const alpha = (1 - confidence) / 2;
  const at = (q: number) => means[Math.min(runs - 1, Math.max(0, Math.floor(q * runs)))];
  return [at(alpha), at(1 - alpha)];
}

export function maxDrawdown(results: number[]): number {
  let eq = 0, peak = 0, dd = 0;
  for (const r of results) {
    eq += r;
    peak = Math.max(peak, eq);
    dd = Math.max(dd, peak - eq);
  }
  return dd;
}

export function longestLosingStreak(results: number[]): number {
  let best = 0, cur = 0;
  for (const r of results) {
    cur = r < 0 ? cur + 1 : 0;
    best = Math.max(best, cur);
  }
  return best;
}

export function summarizePerformance(results: number[], opts: { confidence?: number; bootstrapRuns?: number; seed?: number } = {}): PerformanceSummary {
  const n = results.length;
  const confidence = opts.confidence ?? 0.95;
  if (n === 0) {
    return { trades: 0, meanR: 0, medianR: 0, sdR: 0, seR: 0, ciLowR: NaN, ciHighR: NaN, confidence, totalR: 0, maxDrawdownR: 0, profitFactor: 0, winRate: 0, longestLosingStreak: 0 };
  }
  const total = results.reduce((a, b) => a + b, 0);
  const mean = total / n;
  const sorted = [...results].sort((a, b) => a - b);
  const median = n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
  const sd = n > 1 ? Math.sqrt(results.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0;
  const wins = results.filter((r) => r > 0);
  const grossWin = wins.reduce((a, b) => a + b, 0);
  const grossLoss = -results.filter((r) => r < 0).reduce((a, b) => a + b, 0);
  const [lo, hi] = bootstrapMeanCI(results, confidence, opts.bootstrapRuns ?? 2000, opts.seed ?? 12345);
  return {
    trades: n,
    meanR: mean,
    medianR: median,
    sdR: sd,
    seR: n > 1 ? sd / Math.sqrt(n) : 0,
    ciLowR: lo,
    ciHighR: hi,
    confidence,
    totalR: total,
    maxDrawdownR: maxDrawdown(results),
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0,
    winRate: wins.length / n,
    longestLosingStreak: longestLosingStreak(results),
  };
}
