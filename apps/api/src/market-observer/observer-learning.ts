/**
 * What the observer has learned: for each observed input (option-chain metric, implied volatility, news sentiment)
 * and horizon, does its value predict the asset's forward return?
 *
 * Samples are non-overlapping (one per horizon) so the t-statistic is not inflated by reusing the same move, and an
 * input only counts as LEARNED with enough samples and a strong rank correlation (|t| >= LEARN_T, strict because
 * many inputs x horizons are tested). Nothing here trades; a LEARNED input is a candidate for the strategies.
 */

export interface PricePoint { t: number; price: number }
export interface FeaturePoint { t: number; x: number }

export type InsightStatus = 'COLLECTING' | 'NO_RELATIONSHIP' | 'LEARNED';

export interface Insight {
  asset: string;
  feature: string;
  horizon: '1h' | '1d';
  samples: number;
  needed: number;
  /** Spearman rank correlation between the input and the forward return */
  ic: number;
  tStat: number;
  status: InsightStatus;
  /** For LEARNED inputs: what a high value has meant for the price */
  meaning: string | null;
}

export const MIN_SAMPLES = 60;
export const LEARN_T = 3;
export const HORIZONS: Record<'1h' | '1d', { ms: number; toleranceMs: number }> = {
  '1h': { ms: 3_600_000, toleranceMs: 30 * 60_000 },
  // 1 day ahead; NSE weekends / holidays can push the next print up to a few days later
  '1d': { ms: 86_400_000, toleranceMs: 4 * 86_400_000 },
};

export function spearman(a: number[], b: number[]): number {
  const n = a.length;
  if (n < 3) return 0;
  const rank = (v: number[]) => {
    const idx = v.map((x, i) => [x, i] as const).sort((p, q) => p[0] - q[0]);
    const r = new Array(n);
    let k = 0;
    while (k < n) {
      let e = k;
      while (e + 1 < n && idx[e + 1][0] === idx[k][0]) e++;
      for (let q = k; q <= e; q++) r[idx[q][1]] = (k + e) / 2; // average rank for ties
      k = e + 1;
    }
    return r;
  };
  const ra = rank(a), rb = rank(b);
  const ma = ra.reduce((s, x) => s + x, 0) / n, mb = rb.reduce((s, x) => s + x, 0) / n;
  let cov = 0, va = 0, vb = 0;
  for (let i = 0; i < n; i++) { cov += (ra[i] - ma) * (rb[i] - mb); va += (ra[i] - ma) ** 2; vb += (rb[i] - mb) ** 2; }
  return va > 0 && vb > 0 ? cov / Math.sqrt(va * vb) : 0;
}

/** First price at or after t within the tolerance window (prices sorted by time). */
function priceAtOrAfter(prices: PricePoint[], t: number, toleranceMs: number): number | null {
  let lo = 0, hi = prices.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (prices[mid].t < t) lo = mid + 1; else hi = mid; }
  return lo < prices.length && prices[lo].t - t <= toleranceMs ? prices[lo].price : null;
}

/** Latest price at or before t (within 15 minutes). */
function priceAt(prices: PricePoint[], t: number): number | null {
  let lo = 0, hi = prices.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (prices[mid].t <= t) lo = mid + 1; else hi = mid; }
  const p = prices[lo - 1];
  return p && t - p.t <= 15 * 60_000 ? p.price : null;
}

export function evaluateInput(
  asset: string,
  feature: string,
  horizon: '1h' | '1d',
  points: FeaturePoint[],
  prices: PricePoint[],
): Insight {
  const { ms, toleranceMs } = HORIZONS[horizon];
  const xs: number[] = [], ys: number[] = [];
  let nextAllowed = -Infinity;
  for (const p of [...points].sort((a, b) => a.t - b.t)) {
    if (p.t < nextAllowed || !Number.isFinite(p.x)) continue;
    const p0 = priceAt(prices, p.t);
    const p1 = priceAtOrAfter(prices, p.t + ms, toleranceMs);
    if (!p0 || !p1) continue;
    xs.push(p.x);
    ys.push(p1 / p0 - 1);
    nextAllowed = p.t + ms; // non-overlapping forward windows
  }
  const n = xs.length;
  const ic = spearman(xs, ys);
  const tStat = n > 2 && Math.abs(ic) < 1 ? ic * Math.sqrt((n - 2) / (1 - ic * ic)) : 0;
  const status: InsightStatus = n < MIN_SAMPLES ? 'COLLECTING' : Math.abs(tStat) >= LEARN_T ? 'LEARNED' : 'NO_RELATIONSHIP';
  return {
    asset,
    feature,
    horizon,
    samples: n,
    needed: MIN_SAMPLES,
    ic,
    tStat,
    status,
    meaning: status === 'LEARNED' ? `higher ${feature} has been followed by ${ic > 0 ? 'higher' : 'lower'} ${asset} over ${horizon}` : null,
  };
}

/** Importance-weighted news sentiment for an asset over the trailing window, sampled at the given times. */
export function newsSentimentSeries(
  news: Array<{ t: number; scores: Record<string, { sentiment: number; importance: number }> | null }>,
  asset: string,
  sampleTimes: number[],
  windowMs = 6 * 3_600_000,
): FeaturePoint[] {
  const items = news
    .map((n) => ({ t: n.t, s: n.scores?.[asset] }))
    .filter((n): n is { t: number; s: { sentiment: number; importance: number } } => !!n.s)
    .sort((a, b) => a.t - b.t);
  const out: FeaturePoint[] = [];
  for (const t of sampleTimes) {
    let w = 0, sw = 0;
    for (const it of items) {
      if (it.t > t) break;
      if (it.t >= t - windowMs) { w += it.s.importance; sw += it.s.importance * it.s.sentiment; }
    }
    if (w > 0) out.push({ t, x: sw / w });
  }
  return out;
}
