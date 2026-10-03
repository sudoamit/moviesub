import { signalAt, stopFor } from './genome';
import { Features } from './primitives';
import { Bar, InstrumentProfile, LIMIT_ENTRY_BARS, PerformanceMetrics, SimulatedTrade, StrategyGenome } from './types';
import { exitRulesOf, liquidityOf, openPosition, sideCostRate, stepBar, tradeResult } from './trade-engine';
import { MAX_COST_TO_RISK as SHARED_MAX_COST_TO_RISK, plannedCostToRisk } from '@quant/shared';

/** Trades whose planned round-trip cost exceeds this share of the risk are skipped (shared with the live gate). */
export const MAX_COST_TO_RISK = SHARED_MAX_COST_TO_RISK;

/**
 * Bar-by-bar simulation of one genome. Conservative execution model:
 * - MARKET entries are decided on bar i's close and filled at bar i+1's OPEN (taker + slippage);
 * - LIMIT entries rest at bar i's close for LIMIT_ENTRY_BARS bars and fill only if price trades THROUGH the
 *   limit (maker); an unfilled limit is cancelled; on the fill bar only the stop is checked, never the target;
 * - exits (stop, gap-through-stop, target, trail, timeout, OHLC ambiguity) follow the canonical trade engine
 *   (trade-engine.ts), the same code the shadow / live runner uses;
 * - costs follow the canonical cost model (trade-engine.ts tradeResult): stop / timeout at market (taker +
 *   slippage); target at market for MARKET mode, as a resting limit (maker) for LIMIT mode;
 * - one position at a time; a trade still open at the end of data is closed at the last close (END_OF_DATA);
 * - trades whose worst-case round-trip cost exceeds MAX_COST_TO_RISK of the risk are skipped.
 */
export function backtestGenome(
  g: StrategyGenome,
  bars: Bar[],
  f: Features,
  profile: InstrumentProfile,
  range: { from: number; to: number } = { from: 0, to: bars.length },
): SimulatedTrade[] {
  const trades: SimulatedTrade[] = [];
  const end = Math.min(range.to, bars.length);
  const limitMode = g.entryMode === 'LIMIT';
  const rules = exitRulesOf(g);
  let i = Math.max(range.from, 210); // warm-up for ATR / HTF EMA

  while (i < end - 1) {
    const side = signalAt(g, f, i);
    if (!side) { i++; continue; }
    const isLong = side === 'LONG';

    // Entry
    let entryIndex = -1, entry = 0;
    if (limitMode) {
      const limit = bars[i].c;
      for (let j = i + 1; j <= Math.min(i + LIMIT_ENTRY_BARS, end - 1); j++) {
        if (isLong ? bars[j].l < limit : bars[j].h > limit) { entryIndex = j; entry = limit; break; }
      }
      if (entryIndex === -1) { i++; continue; } // limit never traded through: cancelled
    } else {
      entryIndex = i + 1;
      entry = bars[entryIndex].o;
    }

    const stop = stopFor(g, f, i, side, entry);
    const risk = isLong ? entry - stop : stop - entry;
    // Cost vs risk: the shared canonical definition (entry + exit at the STOP, fees + estimated slippage),
    // identical to the pre-trade execution gate (packages/shared cost-model.ts plannedCostToRisk)
    if (!(risk > 0)) { i++; continue; }
    const costInR = plannedCostToRisk({
      entry, stop, quantity: 1, entryFeeRate: limitMode ? profile.makerFeeRate : profile.takerFeeRate,
      exitFeeRate: profile.takerFeeRate, slippageRate: profile.slippageRate,
    }).costInR - (limitMode ? (entry * profile.slippageRate) / risk : 0); // a resting limit entry has no slippage
    if (costInR > MAX_COST_TO_RISK) { i++; continue; }

    // Exits: the canonical trade engine (shared with the shadow / live runner)
    let pos = openPosition(side, entry, stop, rules);
    let exitIndex = -1, exit = 0;
    let exitReason: SimulatedTrade['exitReason'] = 'TIMEOUT';
    const lastAllowed = Math.min(entryIndex + g.maxBarsInTrade - 1, end - 1);
    for (let j = entryIndex; j <= lastAllowed; j++) {
      const step = stepBar(pos, bars[j], f.atr[j], rules, { limitFillBar: limitMode && j === entryIndex });
      pos = step.state;
      if (step.exit) { exit = step.exit.price; exitIndex = j; exitReason = step.exit.reason; break; }
    }
    if (exitIndex === -1) {
      // Data ended before the position closed
      exitIndex = lastAllowed;
      exit = bars[exitIndex].c;
      exitReason = 'END_OF_DATA';
    }

    const liq = liquidityOf(limitMode ? 'LIMIT' : 'MARKET', exitReason);
    const res = tradeResult(side, entry, stop, exit, profile, liq.entry, liq.exit);
    trades.push({
      side, signalIndex: i, entryIndex, exitIndex, entry, stop, target: pos.target ?? NaN, exit, exitReason,
      netR: res.netR, costR: res.costR,
    });
    i = exitIndex + 1;
  }
  return trades;
}

export function computeMetrics(trades: SimulatedTrade[]): PerformanceMetrics {
  const n = trades.length;
  if (n === 0) {
    return { trades: 0, winRate: 0, expectancyR: 0, totalR: 0, profitFactor: 0, maxDrawdownR: 0, tStat: 0 };
  }
  let sum = 0, sumSq = 0, wins = 0, grossWin = 0, grossLoss = 0, equity = 0, peak = 0, maxDd = 0;
  for (const t of trades) {
    sum += t.netR;
    sumSq += t.netR * t.netR;
    if (t.netR > 0) { wins++; grossWin += t.netR; } else grossLoss -= t.netR;
    equity += t.netR;
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, peak - equity);
  }
  const mean = sum / n;
  const variance = n > 1 ? (sumSq - n * mean * mean) / (n - 1) : 0;
  const sd = Math.sqrt(Math.max(variance, 0));
  return {
    trades: n,
    winRate: wins / n,
    expectancyR: mean,
    totalR: sum,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0,
    maxDrawdownR: maxDd,
    tStat: sd > 0 ? (mean / sd) * Math.sqrt(n) : 0,
  };
}
