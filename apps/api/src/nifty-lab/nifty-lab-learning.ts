/**
 * Learning from live (watch) NIFTY intraday trades:
 * 1. option-cost calibration: real option P&L ~ delta x index points - theta x hours - cost (least squares);
 * 2. per-strategy verdicts on real results (CONFIRMED / RETIRE / keep watching);
 * 3. which entry conditions (option chain, gap, time, expiry) go with better trades.
 */
import { spearman } from '../market-observer/observer-learning';

export interface ClosedWatchTrade {
  strategyId: string;
  strategyVersion?: string | null;
  side: number;
  indexPoints: number;
  hours: number;
  /** Real option P&L (premium points), when live option prices were available at entry and exit */
  optionPoints: number | null;
  modelPoints: number | null;
  features: Record<string, number> | null;
}

export interface OptionModelFit {
  trades: number;
  delta: number;
  thetaPerHour: number;
  cost: number;
  /** Typical error of the fitted model, premium points */
  residualSd: number;
  /** Mean real minus mean modelled P&L with the study's assumed model */
  modelBias: number | null;
}

export const MIN_CALIBRATION_TRADES = 20;

/** Least-squares fit of optionPoints = delta*indexPoints - theta*hours - cost (null until enough real trades). */
export function calibrateOptionModel(trades: ClosedWatchTrade[]): OptionModelFit | null {
  const rows = trades.filter((t) => t.optionPoints !== null && Number.isFinite(t.optionPoints));
  if (rows.length < MIN_CALIBRATION_TRADES) return null;
  // Normal equations for y = a*x1 + b*x2 + c*1 with x1 = indexPoints, x2 = -hours, constant = -cost
  const X = rows.map((t) => [t.indexPoints, -t.hours, -1]);
  const y = rows.map((t) => t.optionPoints as number);
  const XtX = [0, 1, 2].map((i) => [0, 1, 2].map((j) => X.reduce((s, r) => s + r[i] * r[j], 0)));
  const Xty = [0, 1, 2].map((i) => X.reduce((s, r, k) => s + r[i] * y[k], 0));
  const sol = solve3(XtX, Xty);
  if (!sol) return null;
  const [delta, thetaPerHour, cost] = sol;
  const resid = rows.map((r, k) => y[k] - (delta * r.indexPoints - thetaPerHour * r.hours - cost));
  const residualSd = Math.sqrt(resid.reduce((s, e) => s + e * e, 0) / Math.max(1, rows.length - 3));
  const withModel = rows.filter((r) => r.modelPoints !== null);
  const modelBias = withModel.length
    ? withModel.reduce((s, r) => s + (r.optionPoints as number) - (r.modelPoints as number), 0) / withModel.length
    : null;
  return { trades: rows.length, delta, thetaPerHour, cost, residualSd, modelBias };
}

function solve3(A: number[][], b: number[]): number[] | null {
  const M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < 3; c++) {
    let p = c;
    for (let r = c + 1; r < 3; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-9) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < 3; r++) {
      if (r === c) continue;
      const k = M[r][c] / M[c][c];
      for (let q = c; q <= 3; q++) M[r][q] -= k * M[c][q];
    }
  }
  return M.map((r, i) => r[3] / r[i]);
}

export type WatchVerdict = 'WATCHING' | 'CONFIRMED' | 'RETIRE';

/**
 * Where a P&L number comes from. These are NEVER mixed:
 * - REAL_OPTION: live option premium at entry and exit (the only basis that counts as a trading result);
 * - MODELLED_OPTION: option P&L estimated from index points with an option model (research only);
 * - INDEX_PROXY: index points (research only; not what an option trade earns).
 */
export type PnlBasis = 'REAL_OPTION' | 'MODELLED_OPTION' | 'INDEX_PROXY';

export interface PointsSummary {
  basis: PnlBasis;
  trades: number;
  meanPoints: number;
  totalPoints: number;
  tStat: number;
  winRate: number;
}

export interface StrategyLiveStats {
  /** All closed watch trades */
  trades: number;
  /** Trades with a real option price at entry and exit (the verdict uses only these) */
  realPriced: number;
  /** Closed trades without a real option result (excluded from the verdict, never filled in with the model) */
  missingRealPrice: number;
  /** REAL_OPTION figures (kept at the top level for existing consumers) */
  basis: 'REAL_OPTION';
  meanPoints: number;
  totalPoints: number;
  tStat: number;
  winRate: number;
  real: PointsSummary;
  modelled: PointsSummary;
  indexProxy: PointsSummary;
  verdict: WatchVerdict;
  reason: string;
}

export const MIN_VERDICT_TRADES = 20;

/** Real option P&L only (null when the trade has no real option price). Never substitutes the model. */
export const realOptionPoints = (t: ClosedWatchTrade): number | null =>
  t.optionPoints !== null && Number.isFinite(t.optionPoints) ? t.optionPoints : null;

export function summarizePoints(basis: PnlBasis, values: number[]): PointsSummary {
  const n = values.length;
  const mean = n ? values.reduce((a, b) => a + b, 0) / n : 0;
  const sd = n > 1 ? Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0;
  return {
    basis,
    trades: n,
    meanPoints: mean,
    totalPoints: mean * n,
    tStat: sd > 0 ? (mean / sd) * Math.sqrt(n) : 0,
    winRate: n ? values.filter((x) => x > 0).length / n : 0,
  };
}

const finite = (v: Array<number | null>) => v.filter((x): x is number => x !== null && Number.isFinite(x));

export function strategyVerdict(trades: ClosedWatchTrade[]): StrategyLiveStats {
  const real = summarizePoints('REAL_OPTION', finite(trades.map(realOptionPoints)));
  const modelled = summarizePoints('MODELLED_OPTION', finite(trades.map((t) => t.modelPoints)));
  const indexProxy = summarizePoints('INDEX_PROXY', finite(trades.map((t) => t.indexPoints)));
  const n = real.trades;
  const missing = trades.length - n;
  const note = missing ? `; ${missing} trade(s) without a real option price excluded` : '';
  let verdict: WatchVerdict = 'WATCHING';
  let reason = `${n}/${MIN_VERDICT_TRADES} real-priced live trades before a verdict${note}`;
  if (n >= MIN_VERDICT_TRADES) {
    const m = real.meanPoints, t = real.tStat;
    if (m > 0 && t >= 2) { verdict = 'CONFIRMED'; reason = `profitable live (real option prices): ${m.toFixed(1)} pts/trade over ${n} trades (t ${t.toFixed(2)})${note}`; }
    else if (t <= -2 || (n >= 2 * MIN_VERDICT_TRADES && m < 0)) { verdict = 'RETIRE'; reason = `losing live (real option prices): ${m.toFixed(1)} pts/trade over ${n} trades (t ${t.toFixed(2)})${note}`; }
    else reason = `not proven yet (real option prices): ${m.toFixed(1)} pts/trade over ${n} trades (t ${t.toFixed(2)})${note}`;
  }
  return {
    trades: trades.length,
    realPriced: n,
    missingRealPrice: missing,
    basis: 'REAL_OPTION',
    meanPoints: real.meanPoints,
    totalPoints: real.totalPoints,
    tStat: real.tStat,
    winRate: real.winRate,
    real,
    modelled,
    indexProxy,
    verdict,
    reason,
  };
}

export interface ConditionInsight {
  feature: string;
  trades: number;
  ic: number;
  tStat: number;
  status: 'COLLECTING' | 'NO_RELATIONSHIP' | 'LEARNED';
  meaning: string | null;
}

export const MIN_CONDITION_TRADES = 60;

/** Which entry conditions have gone with better trades (rank correlation with the trade's P&L). */
export function conditionInsights(trades: ClosedWatchTrade[]): ConditionInsight[] {
  const names = [...new Set(trades.flatMap((t) => Object.keys(t.features ?? {})))].sort();
  return names.map((feature) => {
    // learned from REAL option results only (modelled P&L would teach the model its own assumptions)
    const rows = trades.filter((t) => Number.isFinite(t.features?.[feature]) && realOptionPoints(t) !== null);
    const n = rows.length;
    const ic = spearman(rows.map((t) => t.features![feature]), rows.map((t) => realOptionPoints(t) as number));
    const tStat = n > 2 && Math.abs(ic) < 1 ? ic * Math.sqrt((n - 2) / (1 - ic * ic)) : 0;
    const status = n < MIN_CONDITION_TRADES ? 'COLLECTING' : Math.abs(tStat) >= 3 ? 'LEARNED' : 'NO_RELATIONSHIP';
    return {
      feature,
      trades: n,
      ic,
      tStat,
      status,
      meaning: status === 'LEARNED' ? `trades did ${ic > 0 ? 'better' : 'worse'} when ${feature} was higher` : null,
    };
  });
}

/**
 * Entry-context features for learning, oriented to the trade side where it matters (positive = favourable reading
 * for the trade's direction under the usual interpretation; the learner decides whether that holds).
 */
export function entryFeatures(params: {
  side: number;
  minutesFromOpen: number;
  gapPct: number;
  isExpiry: boolean;
  chain: Record<string, any> | null;
}): Record<string, number> {
  const { side, chain } = params;
  const f: Record<string, number> = {
    minutesFromOpen: params.minutesFromOpen,
    gapWithTradePct: params.gapPct * 100 * side,
    isExpiry: params.isExpiry ? 1 : 0,
  };
  const num = (k: string) => (chain && Number.isFinite(Number(chain[k])) ? Number(chain[k]) : null);
  const put = (k: string, v: number | null) => { if (v !== null) f[k] = v; };
  put('pcrOi', num('pcrOi'));
  put('pcrWithTrade', num('pcrOi') !== null ? (num('pcrOi')! - 1) * side : null);
  put('oiChangeTiltWithTrade', num('oiChangeTilt') !== null ? num('oiChangeTilt')! * side : null);
  put('maxPainPullWithTradePct', num('maxPainDistPct') !== null ? num('maxPainDistPct')! * side : null);
  put('roomToWallPct', side > 0 ? num('callWallDistPct') : num('putWallDistPct') !== null ? -num('putWallDistPct')! : null);
  put('atmIv', num('atmIv'));
  put('ivSkew', num('ivSkew'));
  return f;
}
