import { signalAt, stopFor } from './genome';
import { Features } from './primitives';
import { Bar, InstrumentProfile, LIMIT_ENTRY_BARS, PerformanceMetrics, SimulatedTrade, StrategyGenome } from './types';

/** Trades whose round-trip cost exceeds this share of the risk are skipped (same rule as the live cost gate). */
export const MAX_COST_TO_RISK = 0.5;

/**
 * Bar-by-bar simulation of one genome. Conservative execution model:
 * - MARKET entries are decided on bar i's close and filled at bar i+1's OPEN (taker + slippage);
 * - LIMIT entries rest at bar i's close for LIMIT_ENTRY_BARS bars and fill only if price trades THROUGH the
 *   limit (maker); an unfilled limit is cancelled; on the fill bar only the stop is checked, never the target;
 * - stop and target are fixed from the fill price; if a bar touches both, the stop is assumed hit first;
 *   a gap through the stop fills at the open;
 * - exits: stop / timeout at market (taker + slippage); target at market for MARKET mode, as a resting
 *   limit (maker) for LIMIT mode;
 * - one position at a time; a trade still open at the end of data is closed at the last close;
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
  const marketSide = profile.takerFeeRate + profile.slippageRate;
  const entryRate = limitMode ? profile.makerFeeRate : marketSide;
  const targetExitRate = limitMode ? profile.makerFeeRate : marketSide;
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
    const worstCaseCost = entry * (entryRate + marketSide);
    if (!(risk > 0) || worstCaseCost / risk > MAX_COST_TO_RISK) { i++; continue; }
    const trailing = g.exit === 'TRAIL';
    const trailMult = g.stop.atrMult > 0 ? g.stop.atrMult : 2.5;
    const target = trailing ? NaN : isLong ? entry + g.rewardRisk * risk : entry - g.rewardRisk * risk;

    let exitIndex = -1, exit = 0;
    let exitReason: SimulatedTrade['exitReason'] = 'TIMEOUT';
    let curStop = stop;
    let extreme = entry;
    const lastAllowed = Math.min(entryIndex + g.maxBarsInTrade - 1, end - 1);
    for (let j = entryIndex; j <= lastAllowed; j++) {
      const b = bars[j];
      const stopHit = isLong ? b.l <= curStop : b.h >= curStop;
      if (stopHit) {
        // A gap through the stop fills at the open (not possible on a limit-fill bar: the fill was intrabar).
        const gapOpen = limitMode && j === entryIndex ? curStop : b.o;
        exit = isLong ? Math.min(curStop, gapOpen) : Math.max(curStop, gapOpen);
        exitIndex = j; exitReason = 'STOP';
        break;
      }
      if (trailing) {
        // Chandelier trail from the best CLOSE so far; updated after the bar, applies from the next bar.
        extreme = isLong ? Math.max(extreme, b.c) : Math.min(extreme, b.c);
        const trail = isLong ? extreme - trailMult * f.atr[j] : extreme + trailMult * f.atr[j];
        curStop = isLong ? Math.max(curStop, trail) : Math.min(curStop, trail);
        continue;
      }
      if (limitMode && j === entryIndex) continue; // target not counted on the fill bar (order unknown)
      const targetHit = isLong ? b.h >= target : b.l <= target;
      if (targetHit) { exit = target; exitIndex = j; exitReason = 'TARGET'; break; }
    }
    if (exitIndex === -1) {
      exitIndex = lastAllowed;
      exit = bars[exitIndex].c;
      exitReason = lastAllowed === end - 1 && lastAllowed < entryIndex + g.maxBarsInTrade - 1 ? 'END_OF_DATA' : 'TIMEOUT';
    }

    const exitRate = exitReason === 'TARGET' ? targetExitRate : marketSide;
    const grossR = (isLong ? exit - entry : entry - exit) / risk;
    const costR = (entry * entryRate + exit * exitRate) / risk;
    trades.push({
      side, signalIndex: i, entryIndex, exitIndex, entry, stop, target, exit, exitReason,
      netR: grossR - costR, costR,
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
