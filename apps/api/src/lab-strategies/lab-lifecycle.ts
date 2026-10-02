import { Bar, InstrumentProfile, StrategyGenome } from '@quant/strategy-lab';

/**
 * Pure lifecycle rules for lab strategies (no I/O), shared by the shadow and live runners.
 * They reproduce the backtester's semantics bar by bar so shadow results are comparable with the backtest.
 */

export interface OpenLabTrade {
  side: 'LONG' | 'SHORT';
  entryPrice: number;
  initialStop: number;
  currentStop: number;
  extremeClose: number;
  barsHeld: number;
}

export interface AdvanceResult {
  trade: OpenLabTrade;
  closed: null | { exitPrice: number; exitReason: 'STOP' | 'TARGET' | 'TIMEOUT'; exitTime: number };
}

/**
 * Advances an open trade over newly closed bars: stop first (a gap through the stop fills at the open), then the
 * chandelier trail is updated from the best close (applies from the next bar) or the fixed target is checked, then
 * the holding-time limit.
 */
export function advanceTrade(
  trade: OpenLabTrade,
  newBars: Array<{ bar: Bar; atr: number }>,
  genome: StrategyGenome,
): AdvanceResult {
  const t = { ...trade };
  const isLong = t.side === 'LONG';
  const trailMult = genome.stop.atrMult > 0 ? genome.stop.atrMult : 2.5;
  for (const { bar, atr } of newBars) {
    const stopHit = isLong ? bar.l <= t.currentStop : bar.h >= t.currentStop;
    if (stopHit) {
      const exitPrice = isLong ? Math.min(t.currentStop, bar.o) : Math.max(t.currentStop, bar.o);
      return { trade: t, closed: { exitPrice, exitReason: 'STOP', exitTime: bar.t } };
    }
    t.barsHeld += 1;
    if (genome.exit === 'TRAIL') {
      t.extremeClose = isLong ? Math.max(t.extremeClose, bar.c) : Math.min(t.extremeClose, bar.c);
      const trail = isLong ? t.extremeClose - trailMult * atr : t.extremeClose + trailMult * atr;
      t.currentStop = isLong ? Math.max(t.currentStop, trail) : Math.min(t.currentStop, trail);
    }
    // FIXED exits take profit at rewardRisk x the initial risk (as in the backtester: after the stop, before the timeout)
    if (genome.exit !== 'TRAIL' && genome.rewardRisk > 0) {
      const risk = Math.abs(t.entryPrice - t.initialStop);
      const target = isLong ? t.entryPrice + genome.rewardRisk * risk : t.entryPrice - genome.rewardRisk * risk;
      if (isLong ? bar.h >= target : bar.l <= target) {
        return { trade: t, closed: { exitPrice: target, exitReason: 'TARGET', exitTime: bar.t } };
      }
    }
    if (t.barsHeld >= genome.maxBarsInTrade) {
      return { trade: t, closed: { exitPrice: bar.c, exitReason: 'TIMEOUT', exitTime: bar.t } };
    }
  }
  return { trade: t, closed: null };
}

/** Net R of a closed trade with the lab cost model (market entry and exit: taker fee + slippage per side). */
export function netR(trade: OpenLabTrade, exitPrice: number, profile: InstrumentProfile): { netR: number; costR: number } {
  const isLong = trade.side === 'LONG';
  const risk = Math.abs(trade.entryPrice - trade.initialStop);
  const side = profile.takerFeeRate + profile.slippageRate;
  const gross = (isLong ? exitPrice - trade.entryPrice : trade.entryPrice - exitPrice) / risk;
  const costR = ((trade.entryPrice + exitPrice) * side) / risk;
  return { netR: gross - costR, costR };
}

export interface BacktestReference {
  expectancyR: number;
  sdR: number;
  trades: number;
  maxDrawdownR: number;
}

export interface LifecycleRules {
  /** Shadow trades needed before promotion is considered. */
  minShadowTrades: number;
  /** Promote when the shadow mean is not significantly below the backtest: z >= this. */
  promoteMinZ: number;
  /** Retire (shadow or live) once there are this many trades and z < retireZ. */
  minTradesForRetirement: number;
  retireZ: number;
  /** Retire when the live peak-to-trough drawdown exceeds this multiple of the backtest's worst drawdown. */
  maxDrawdownMultiple: number;
}

export const DEFAULT_LIFECYCLE_RULES: LifecycleRules = {
  minShadowTrades: 8,
  promoteMinZ: -1.5,
  minTradesForRetirement: 10,
  retireZ: -2,
  maxDrawdownMultiple: 2,
};

/** z-score of the observed mean R against the backtest mean, using the backtest's per-trade standard deviation. */
export function zVsBacktest(ref: BacktestReference, results: number[]): number {
  if (results.length === 0 || !(ref.sdR > 0)) return 0;
  const mean = results.reduce((a, b) => a + b, 0) / results.length;
  return (mean - ref.expectancyR) / (ref.sdR / Math.sqrt(results.length));
}

export function drawdownR(results: number[]): number {
  let eq = 0, peak = 0, dd = 0;
  for (const r of results) { eq += r; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq); }
  return dd;
}

export type LifecycleDecision = { action: 'NONE' | 'PROMOTE' | 'RETIRE'; reason: string };

/** Decides automatic promotion (SHADOW -> LIVE) and retirement (-> RETIRED) from closed-trade results. */
export function decideLifecycle(
  status: 'SHADOW' | 'LIVE',
  ref: BacktestReference,
  results: number[],
  rules: LifecycleRules = DEFAULT_LIFECYCLE_RULES,
): LifecycleDecision {
  const n = results.length;
  const z = zVsBacktest(ref, results);
  const dd = drawdownR(results);
  if (n >= rules.minTradesForRetirement && z < rules.retireZ) {
    return { action: 'RETIRE', reason: `${status.toLowerCase()} results significantly below backtest (z ${z.toFixed(2)} over ${n} trades)` };
  }
  if (status === 'LIVE' && dd > rules.maxDrawdownMultiple * ref.maxDrawdownR) {
    return { action: 'RETIRE', reason: `drawdown ${dd.toFixed(1)}R exceeds ${rules.maxDrawdownMultiple}x backtest worst ${ref.maxDrawdownR.toFixed(1)}R` };
  }
  if (status === 'SHADOW' && n >= rules.minShadowTrades && z >= rules.promoteMinZ) {
    return { action: 'PROMOTE', reason: `shadow consistent with backtest (z ${z.toFixed(2)} over ${n} trades, total ${results.reduce((a, b) => a + b, 0).toFixed(2)}R)` };
  }
  return { action: 'NONE', reason: `${n} closed ${status.toLowerCase()} trades, z ${z.toFixed(2)}` };
}

/** Starting capital allocated to each instrument (LAB_CAPITAL_PER_INSTRUMENT, INR). */
export const CAPITAL_PER_INSTRUMENT = Number(process.env.LAB_CAPITAL_PER_INSTRUMENT || 50_000);

/**
 * Position size from the instrument's own (compounding) balance:
 * risk = balance x riskPct x sizeMultiplier; quantity = risk / stop distance (in INR per unit), rounded down to
 * the lot; the margin (notional / leverage) may never exceed the balance - the size is reduced to fit.
 */
export function sizeFromCoinBalance(a: {
  balance: number; riskPct: number; sizeMultiplier: number; entry: number; stopDistance: number;
  fx: number; leverage: number; lot: number; precision: number;
}): { qty: number; riskInr: number; marginInr: number } {
  if (!(a.balance > 0) || !(a.stopDistance > 0) || !(a.entry > 0)) return { qty: 0, riskInr: 0, marginInr: 0 };
  const floorLot = (q: number) => Number((Math.floor(q / a.lot + 1e-9) * a.lot).toFixed(a.precision));
  const riskBudget = (a.balance * a.riskPct * a.sizeMultiplier) / 100;
  let qty = floorLot(riskBudget / (a.stopDistance * a.fx));
  const maxQtyByMargin = floorLot((a.balance * a.leverage) / (a.entry * a.fx));
  if (qty > maxQtyByMargin) qty = maxQtyByMargin;
  return {
    qty,
    riskInr: Number((qty * a.stopDistance * a.fx).toFixed(2)),
    marginInr: Number(((qty * a.entry * a.fx) / a.leverage).toFixed(2)),
  };
}

/** Shadow balance: the starting capital compounded by each closed shadow trade's R at the given risk. */
export function compoundedBalance(start: number, riskPct: number, results: Array<{ netR: number; sizeMultiplier?: number | null }>): number {
  return results.reduce((bal, r) => bal * (1 + (riskPct / 100) * r.netR * (r.sizeMultiplier ?? 1)), start);
}
