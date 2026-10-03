import { InstrumentProfile, StrategyGenome } from './types';

/**
 * CANONICAL TRADE LIFECYCLE (single implementation of every exit rule).
 *
 * Used by the backtester (packages/strategy-lab/src/backtest.ts) and by the shadow / live lab runner
 * (apps/api/src/lab-strategies/lab-lifecycle.ts). Nothing else may implement stop / target / trail / timeout
 * semantics for lab strategies.
 *
 * Per completed bar of an open position, in this exact order:
 *  1. STOP. If the bar's range reaches the current stop (long: low <= stop, short: high >= stop) the position
 *     exits at the stop. A bar that OPENS beyond the stop (gap through) exits at the open, which is worse than
 *     the stop. Exception: on the fill bar of a LIMIT entry the fill happened inside the bar, so there is no gap:
 *     exit at the stop.
 *  2. The bar counts as held (barsHeld += 1).
 *  3. TRAIL exits: the best close so far moves a chandelier stop (best close -/+ trailAtrMult x ATR of this bar).
 *     The new stop applies from the NEXT bar. TRAIL exits have no profit target.
 *     FIXED exits: if the bar reaches the target the position exits at the target price (never better: no
 *     gap improvement). On the fill bar of a LIMIT entry the target is not checked (intrabar order unknown).
 *  4. TIMEOUT. Once barsHeld reaches maxBarsInTrade the position exits at the bar's close.
 *
 * OHLC AMBIGUITY RULE: a bar whose range contains both the stop and the target is treated as a STOP (the worst
 * case). Bars carry no intrabar order, so the conservative assumption is the only defensible one.
 *
 * END OF DATA (backtests only): a position still open after the last bar exits at the last close
 * (reason END_OF_DATA). Live runners keep the position open instead.
 */
export const TRADE_ENGINE_VERSION = 'trade-engine/v1';

export type TradeSide = 'LONG' | 'SHORT';
export type ExitReason = 'STOP' | 'TARGET' | 'TIMEOUT' | 'END_OF_DATA';
export type Liquidity = 'MAKER' | 'TAKER';

export interface ExitRules {
  exit: 'FIXED' | 'TRAIL';
  rewardRisk: number;
  trailAtrMult: number;
  maxBarsInTrade: number;
}

export interface PositionState {
  side: TradeSide;
  entryPrice: number;
  initialStop: number;
  currentStop: number;
  /** null for TRAIL exits */
  target: number | null;
  extremeClose: number;
  barsHeld: number;
}

export interface OhlcBar { o: number; h: number; l: number; c: number }

export interface StepResult {
  state: PositionState;
  exit: null | { price: number; reason: Exclude<ExitReason, 'END_OF_DATA'> };
}

export function exitRulesOf(g: StrategyGenome): ExitRules {
  return {
    exit: g.exit === 'TRAIL' ? 'TRAIL' : 'FIXED',
    rewardRisk: g.rewardRisk,
    trailAtrMult: g.stop.atrMult > 0 ? g.stop.atrMult : 2.5,
    maxBarsInTrade: g.maxBarsInTrade,
  };
}

/** Opens a position; the target is rewardRisk x the initial risk from the fill price (FIXED exits only). */
export function openPosition(side: TradeSide, entryPrice: number, stop: number, rules: ExitRules): PositionState {
  const risk = Math.abs(entryPrice - stop);
  const target = rules.exit === 'TRAIL' || !(rules.rewardRisk > 0) ? null : side === 'LONG' ? entryPrice + rules.rewardRisk * risk : entryPrice - rules.rewardRisk * risk;
  return { side, entryPrice, initialStop: stop, currentStop: stop, target, extremeClose: entryPrice, barsHeld: 0 };
}

/** Advances an open position over one completed bar (see the module documentation for the exact order). */
export function stepBar(
  state: PositionState,
  bar: OhlcBar,
  atr: number,
  rules: ExitRules,
  opts: { limitFillBar?: boolean } = {},
): StepResult {
  const s = { ...state };
  const long = s.side === 'LONG';
  if (long ? bar.l <= s.currentStop : bar.h >= s.currentStop) {
    const ref = opts.limitFillBar ? s.currentStop : bar.o;
    return { state: s, exit: { price: long ? Math.min(s.currentStop, ref) : Math.max(s.currentStop, ref), reason: 'STOP' } };
  }
  s.barsHeld += 1;
  if (rules.exit === 'TRAIL') {
    s.extremeClose = long ? Math.max(s.extremeClose, bar.c) : Math.min(s.extremeClose, bar.c);
    const trail = long ? s.extremeClose - rules.trailAtrMult * atr : s.extremeClose + rules.trailAtrMult * atr;
    s.currentStop = long ? Math.max(s.currentStop, trail) : Math.min(s.currentStop, trail);
  } else if (s.target !== null && !opts.limitFillBar && (long ? bar.h >= s.target : bar.l <= s.target)) {
    return { state: s, exit: { price: s.target, reason: 'TARGET' } };
  }
  if (s.barsHeld >= rules.maxBarsInTrade) return { state: s, exit: { price: bar.c, reason: 'TIMEOUT' } };
  return { state: s, exit: null };
}

/**
 * CANONICAL LAB COST MODEL. Each side of a trade pays, as a fraction of price:
 *   MAKER (resting limit order filled):          makerFeeRate
 *   TAKER (market order / stop / timeout exit):  takerFeeRate + slippageRate
 * The rates come from the instrument profile, which is derived from the shared fee schedules (profiles.ts).
 */
export function sideCostRate(profile: InstrumentProfile, liquidity: Liquidity): number {
  return liquidity === 'MAKER' ? profile.makerFeeRate : profile.takerFeeRate + profile.slippageRate;
}

export interface TradeCostBreakdown {
  entryCostPerUnit: number;
  exitCostPerUnit: number;
  roundTripCostPerUnit: number;
  grossR: number;
  costR: number;
  netR: number;
}

/** Gross R, cost R and net R of a closed trade (risk = |entry - initial stop|), per unit of quantity. */
export function tradeResult(
  side: TradeSide,
  entryPrice: number,
  initialStop: number,
  exitPrice: number,
  profile: InstrumentProfile,
  entryLiquidity: Liquidity,
  exitLiquidity: Liquidity,
): TradeCostBreakdown {
  const risk = Math.abs(entryPrice - initialStop);
  if (!(risk > 0)) throw new Error('tradeResult: risk must be positive');
  const entryCostPerUnit = entryPrice * sideCostRate(profile, entryLiquidity);
  const exitCostPerUnit = exitPrice * sideCostRate(profile, exitLiquidity);
  const grossR = (side === 'LONG' ? exitPrice - entryPrice : entryPrice - exitPrice) / risk;
  const costR = (entryCostPerUnit + exitCostPerUnit) / risk;
  return { entryCostPerUnit, exitCostPerUnit, roundTripCostPerUnit: entryCostPerUnit + exitCostPerUnit, grossR, costR, netR: grossR - costR };
}

/** Liquidity of each side for a genome: LIMIT entries rest (maker) and their targets rest (maker); everything else is taker. */
export function liquidityOf(entryMode: 'MARKET' | 'LIMIT', exitReason: ExitReason): { entry: Liquidity; exit: Liquidity } {
  const limit = entryMode === 'LIMIT';
  return { entry: limit ? 'MAKER' : 'TAKER', exit: limit && exitReason === 'TARGET' ? 'MAKER' : 'TAKER' };
}
