/**
 * Learning from live (watch) NIFTY intraday trades:
 * 1. option-cost calibration: real option P&L ~ delta x index points - theta x hours - cost (least squares);
 * 2. per-strategy verdicts on real results (CONFIRMED / RETIRE / keep watching);
 * 3. which entry conditions (option chain, gap, time, expiry) go with better trades.
 */
import { spearman } from '../market-observer/observer-learning';

export interface ClosedWatchTrade {
  strategyId: string;
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

export interface StrategyLiveStats {
  trades: number;
  /** Trades whose P&L is the real option price (rest use the model) */
  realPriced: number;
  meanPoints: number;
  totalPoints: number;
  tStat: number;
  winRate: number;
  verdict: WatchVerdict;
  reason: string;
}

export const MIN_VERDICT_TRADES = 20;

/** Real option P&L when available, otherwise the modelled P&L. */
export const tradePoints = (t: ClosedWatchTrade) => (t.optionPoints ?? t.modelPoints ?? 0);

export function strategyVerdict(trades: ClosedWatchTrade[]): StrategyLiveStats {
  const v = trades.map(tradePoints);
  const n = v.length;
  const mean = n ? v.reduce((a, b) => a + b, 0) / n : 0;
  const sd = n > 1 ? Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0;
  const tStat = sd > 0 ? (mean / sd) * Math.sqrt(n) : 0;
  let verdict: WatchVerdict = 'WATCHING';
  let reason = `${n}/${MIN_VERDICT_TRADES} live trades before a verdict`;
  if (n >= MIN_VERDICT_TRADES) {
    if (mean > 0 && tStat >= 2) { verdict = 'CONFIRMED'; reason = `profitable live: ${mean.toFixed(1)} pts/trade over ${n} trades (t ${tStat.toFixed(2)})`; }
    else if (tStat <= -2 || (n >= 2 * MIN_VERDICT_TRADES && mean < 0)) { verdict = 'RETIRE'; reason = `losing live: ${mean.toFixed(1)} pts/trade over ${n} trades (t ${tStat.toFixed(2)})`; }
    else reason = `not proven yet: ${mean.toFixed(1)} pts/trade over ${n} trades (t ${tStat.toFixed(2)})`;
  }
  return {
    trades: n,
    realPriced: trades.filter((t) => t.optionPoints !== null).length,
    meanPoints: mean,
    totalPoints: mean * n,
    tStat,
    winRate: n ? v.filter((x) => x > 0).length / n : 0,
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
    const rows = trades.filter((t) => Number.isFinite(t.features?.[feature]));
    const n = rows.length;
    const ic = spearman(rows.map((t) => t.features![feature]), rows.map(tradePoints));
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
