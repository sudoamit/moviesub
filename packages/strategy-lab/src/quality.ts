import { backtestGenome } from './backtest';
import { aggregateBars, computeFeatures, Features } from './primitives';
import { INSTRUMENT_PROFILES } from './profiles';
import { Bar, InstrumentProfile, Side, StrategyGenome } from './types';

/**
 * Trade-quality model ("meta-labelling"): predicts the expected net R of a strategy's signal from the market
 * context at the signal bar. It is only allowed to influence trading after it proves, out of sample, that its
 * high-scored trades beat its low-scored trades (see validateQualityModel).
 */

export const QUALITY_FEATURES = [
  'htfTrendAligned',
  'structureAligned',
  'rangePositionAligned',
  'inKillzone',
  'recentDisplacementAligned',
  'recentSweepAligned',
  'atrPct',
  'volatilityPercentile',
  'distEma200Atr',
  'momentum20Atr',
  'signalBodyAtr',
  'hourSin',
  'hourCos',
  'isLong',
  'oppositeLiquidityZoneAhead',
  'liquidityCandleAligned',
  'bias',
] as const;

export interface QualityExample {
  t: number;
  market: string;
  x: number[];
  /** Net R, clipped to limit the pull of rare outliers. */
  y: number;
}

export interface QualityModel {
  featureNames: string[];
  means: number[];
  sds: number[];
  weights: number[];
  lambda: number;
  trainedOn: number;
}

export interface QualityValidation {
  oosPredictions: number;
  /** Mean net R of the top / bottom half of out-of-sample trades by predicted R. */
  topHalfR: number;
  bottomHalfR: number;
  liftR: number;
  liftTStat: number;
  spearman: number;
  /** Mean net R of out-of-sample trades with a negative prediction (the ones a skip rule would drop; must be <= -0.1R). */
  negativePredictionR: number | null;
  negativePredictionCount: number;
  active: boolean;
  skipRuleValidated: boolean;
  reason: string;
}

const Y_CLIP: [number, number] = [-1.5, 5];

function emaOf(bars: Bar[], period: number): Float64Array {
  const out = new Float64Array(bars.length);
  if (!bars.length) return out;
  const k = 2 / (period + 1);
  out[0] = bars[0].c;
  for (let i = 1; i < bars.length; i++) out[i] = bars[i].c * k + out[i - 1] * (1 - k);
  return out;
}

/** PVSRA (Traders Reality) 200% vector candle at bar j: +1 bullish, -1 bearish, 0 none. Needs bars j-9..j. */
function vectorCandle(bars: Bar[], j: number): number {
  if (j < 9) return 0;
  let sumV = 0, maxVs = 0;
  for (let k = j - 9; k <= j; k++) {
    sumV += bars[k].v;
    maxVs = Math.max(maxVs, bars[k].v * (bars[k].h - bars[k].l));
  }
  const b = bars[j];
  if (!(b.v > 0)) return 0;
  const isVector = b.v >= (sumV / 10) * 2 || b.v * (b.h - b.l) >= maxVs;
  return isVector ? (b.c > b.o ? 1 : b.c < b.o ? -1 : 0) : 0;
}

/** Bars of history scanned for liquidity zones (the live runner supplies 500 bars; the window fits inside them). */
const LIQUIDITY_LOOKBACK = 480;

/**
 * Liquidity context at bar i (point in time). Zones are vector candle bodies; a bearish zone is cleared once price
 * trades up through its top, a bullish zone once price trades down through its bottom.
 * oppositeZoneAhead: an uncleared opposite zone lies within 3 ATR in the trade's direction (would stall the move).
 * vectorAligned: the signal candle is a vector candle with (+1) / against (-1) the trade.
 */
function liquidityContext(bars: Bar[], atr: number, i: number, side: Side): { oppositeZoneAhead: number; vectorAligned: number } {
  const dir = side === 'LONG' ? 1 : -1;
  const close = bars[i].c;
  const lo = Math.max(0, i - LIQUIDITY_LOOKBACK);
  const zones: Array<{ side: number; top: number; bot: number }> = [];
  for (let j = lo; j < i; j++) {
    const b = bars[j];
    for (let k = zones.length - 1; k >= 0; k--) {
      const z = zones[k];
      if ((z.side < 0 && b.h >= z.top) || (z.side > 0 && b.l <= z.bot)) zones.splice(k, 1);
    }
    const v = vectorCandle(bars, j);
    if (v) zones.push({ side: v, top: Math.max(b.o, b.c), bot: Math.min(b.o, b.c) });
  }
  const ahead = zones.some((z) =>
    dir > 0
      ? z.side < 0 && z.bot > close && z.bot - close <= 3 * atr
      : z.side > 0 && z.top < close && close - z.top <= 3 * atr,
  );
  return { oppositeZoneAhead: ahead ? 1 : 0, vectorAligned: vectorCandle(bars, i) * dir };
}

/** Context features at bar i for a signal on `side` (direction-aware features are positive when "with" the trade). */
export function extractQualityFeatures(bars: Bar[], f: Features, ema200: Float64Array, i: number, side: Side): number[] {
  const dir = side === 'LONG' ? 1 : -1;
  const b = bars[i];
  const atr = f.atr[i] || 1e-9;
  let rank = 0;
  const lo = Math.max(0, i - 100);
  for (let j = lo; j < i; j++) if (f.atr[j] / bars[j].c < atr / b.c) rank++;
  const h = new Date(b.t).getUTCHours() + new Date(b.t).getUTCMinutes() / 60;
  const liq = liquidityContext(bars, atr, i, side);
  return [
    f.htfTrend[i] * dir,
    f.structureTrend[i] * dir,
    f.rangePosition[i] * dir,
    f.inKillzone[i],
    side === 'LONG' ? f.recentDisplacementUp[i] : f.recentDisplacementDown[i],
    side === 'LONG' ? f.recentSweepLong[i] : f.recentSweepShort[i],
    atr / b.c,
    i > lo ? rank / (i - lo) : 0.5,
    ((b.c - ema200[i]) / atr) * dir,
    i >= 20 ? ((b.c - bars[i - 20].c) / atr) * dir : 0,
    ((b.c - b.o) / atr) * dir,
    Math.sin((2 * Math.PI * h) / 24),
    Math.cos((2 * Math.PI * h) / 24),
    side === 'LONG' ? 1 : 0,
    liq.oppositeZoneAhead,
    liq.vectorAligned,
    1,
  ];
}

/** Features at bar i of a bar series (computes the 200 EMA over the series; give it >= 500 bars for convergence). */
export function qualityFeaturesAt(bars: Bar[], f: Features, i: number, side: Side): number[] {
  return extractQualityFeatures(bars, f, emaOf(bars, 200), i, side);
}

/** Markets whose trades are pooled with a strategy's own market when training (unseen-in-search siblings). */
export const QUALITY_SIBLINGS: Record<string, string[]> = { BTCUSDT_PERP: ['ETHUSDT_PERP'], ETHUSDT_PERP: ['BTCUSDT_PERP'] };

const FACTOR: Record<string, number> = { '15m': 1, '1h': 4, '4h': 16 };

/** Labelled examples: every backtest trade of the genome on each market's full history. */
export function buildQualityDataset(genome: StrategyGenome, timeframe: string, markets: Record<string, Bar[]>): QualityExample[] {
  const out: QualityExample[] = [];
  for (const [symbol, bars15] of Object.entries(markets)) {
    const base = INSTRUMENT_PROFILES[symbol];
    if (!base || !bars15?.length) continue;
    const factor = FACTOR[timeframe] ?? 1;
    const bars = factor > 1 ? aggregateBars(bars15, factor, base.barMs) : bars15;
    const profile: InstrumentProfile = { ...base, barMs: base.barMs * factor };
    const f = computeFeatures(bars, profile);
    const ema200 = emaOf(bars, 200);
    for (const t of backtestGenome(genome, bars, f, profile)) {
      out.push({
        t: bars[t.signalIndex].t,
        market: symbol,
        x: extractQualityFeatures(bars, f, ema200, t.signalIndex, t.side),
        y: Math.max(Y_CLIP[0], Math.min(Y_CLIP[1], t.netR)),
      });
    }
  }
  return out.sort((a, b) => a.t - b.t);
}

/** Solves A x = b (Gaussian elimination with partial pivoting). */
function solve(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    const piv = M[c][c] || 1e-12;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const k = M[r][c] / piv;
      for (let k2 = c; k2 <= n; k2++) M[r][k2] -= k * M[c][k2];
    }
  }
  return M.map((row, i) => row[n] / (row[i] || 1e-12));
}

/** Ridge regression on standardized features (the bias column is not standardized or penalized). */
export function fitQualityModel(examples: QualityExample[], lambda = 10): QualityModel {
  const d = QUALITY_FEATURES.length;
  const biasIdx = d - 1;
  const means = new Array(d).fill(0), sds = new Array(d).fill(1);
  for (let j = 0; j < d; j++) {
    if (j === biasIdx) continue;
    const col = examples.map((e) => e.x[j]);
    const m = col.reduce((a, v) => a + v, 0) / Math.max(1, col.length);
    const sd = Math.sqrt(col.reduce((a, v) => a + (v - m) ** 2, 0) / Math.max(1, col.length - 1));
    means[j] = m;
    sds[j] = sd > 1e-9 ? sd : 1;
  }
  const Z = examples.map((e) => e.x.map((v, j) => (j === biasIdx ? 1 : (v - means[j]) / sds[j])));
  const XtX = Array.from({ length: d }, () => new Array(d).fill(0));
  const Xty = new Array(d).fill(0);
  Z.forEach((z, r) => {
    for (let a = 0; a < d; a++) {
      Xty[a] += z[a] * examples[r].y;
      for (let c = 0; c < d; c++) XtX[a][c] += z[a] * z[c];
    }
  });
  for (let a = 0; a < d; a++) if (a !== biasIdx) XtX[a][a] += lambda;
  return { featureNames: [...QUALITY_FEATURES], means, sds, weights: solve(XtX, Xty), lambda, trainedOn: examples.length };
}

export function predictQuality(model: QualityModel, x: number[]): number {
  // x follows QUALITY_FEATURES; the model may have been trained on an older feature list, so match by name.
  return model.featureNames.reduce((acc, name, j) => {
    if (name === 'bias') return acc + model.weights[j];
    const idx = (QUALITY_FEATURES as readonly string[]).indexOf(name);
    if (idx < 0) return acc;
    return acc + ((x[idx] - model.means[j]) / model.sds[j]) * model.weights[j];
  }, 0);
}

function spearman(a: number[], b: number[]): number {
  const rank = (v: number[]) => {
    const idx = v.map((x, i) => [x, i] as const).sort((p, q) => p[0] - q[0]);
    const r = new Array(v.length);
    idx.forEach(([, i], k) => (r[i] = k));
    return r;
  };
  const ra = rank(a), rb = rank(b), n = a.length;
  if (n < 3) return 0;
  const d2 = ra.reduce((s, x, i) => s + (x - rb[i]) ** 2, 0);
  return 1 - (6 * d2) / (n * (n * n - 1));
}

/**
 * Walk-forward validation: examples are split chronologically into `folds`; for each fold after the first the
 * model is trained only on earlier folds and predicts that fold. The model is ACTIVE only if, out of sample,
 * the top half by prediction beats the bottom half by >= minLiftR with a Welch t >= minLiftT.
 */
export function validateQualityModel(
  examples: QualityExample[],
  options: { folds?: number; lambda?: number; minLiftR?: number; minLiftT?: number; minExamples?: number } = {},
): QualityValidation {
  const folds = options.folds ?? 5, minLiftR = options.minLiftR ?? 0.15, minLiftT = options.minLiftT ?? 2, minExamples = options.minExamples ?? 100;
  const inactive = (reason: string, extra: Partial<QualityValidation> = {}): QualityValidation => ({
    oosPredictions: 0, topHalfR: 0, bottomHalfR: 0, liftR: 0, liftTStat: 0, spearman: 0, negativePredictionR: null,
    negativePredictionCount: 0, active: false, skipRuleValidated: false, reason, ...extra,
  });
  if (examples.length < minExamples) return inactive(`only ${examples.length} examples (need ${minExamples})`);

  const size = Math.floor(examples.length / folds);
  const preds: number[] = [], actual: number[] = [];
  for (let k = 1; k < folds; k++) {
    const train = examples.slice(0, k * size);
    const test = examples.slice(k * size, k === folds - 1 ? examples.length : (k + 1) * size);
    const m = fitQualityModel(train, options.lambda ?? 10);
    for (const e of test) { preds.push(predictQuality(m, e.x)); actual.push(e.y); }
  }
  const order = preds.map((p, i) => i).sort((a, b) => preds[b] - preds[a]);
  const half = Math.floor(order.length / 2);
  const top = order.slice(0, half).map((i) => actual[i]);
  const bottom = order.slice(half).map((i) => actual[i]);
  const mean = (v: number[]) => v.reduce((a, x) => a + x, 0) / Math.max(1, v.length);
  const varOf = (v: number[]) => { const m = mean(v); return v.reduce((a, x) => a + (x - m) ** 2, 0) / Math.max(1, v.length - 1); };
  const liftR = mean(top) - mean(bottom);
  const se = Math.sqrt(varOf(top) / Math.max(1, top.length) + varOf(bottom) / Math.max(1, bottom.length));
  const liftTStat = se > 0 ? liftR / se : 0;
  const negIdx = preds.map((p, i) => (p < 0 ? i : -1)).filter((i) => i >= 0);
  const negativePredictionR = negIdx.length ? mean(negIdx.map((i) => actual[i])) : null;
  const active = liftR >= minLiftR && liftTStat >= minLiftT;
  // Skipping needs clear evidence: the trades it would drop must have lost at least 0.1R on average out of sample.
  const skipRuleValidated = active && negIdx.length >= 20 && negativePredictionR !== null && negativePredictionR <= -0.1;
  return {
    oosPredictions: preds.length, topHalfR: mean(top), bottomHalfR: mean(bottom), liftR, liftTStat,
    spearman: spearman(preds, actual), negativePredictionR, negativePredictionCount: negIdx.length,
    active, skipRuleValidated,
    reason: active
      ? `out-of-sample lift ${liftR.toFixed(2)}R (t ${liftTStat.toFixed(2)}) over ${preds.length} trades`
      : `no proven lift: ${liftR.toFixed(2)}R (t ${liftTStat.toFixed(2)}) over ${preds.length} out-of-sample trades; needs >= ${minLiftR}R and t >= ${minLiftT}`,
  };
}

/** Position-size multiplier and skip decision from a prediction (only used when the model is active). */
export function qualityDecision(
  predictedR: number,
  strategyMeanR: number,
  validation: Pick<QualityValidation, 'active' | 'skipRuleValidated'>,
): { skip: boolean; sizeMultiplier: number } {
  if (!validation.active) return { skip: false, sizeMultiplier: 1 };
  if (validation.skipRuleValidated && predictedR < 0) return { skip: true, sizeMultiplier: 0 };
  const ratio = strategyMeanR > 0 ? predictedR / strategyMeanR : 1;
  return { skip: false, sizeMultiplier: Math.max(0.5, Math.min(1.5, ratio)) };
}
