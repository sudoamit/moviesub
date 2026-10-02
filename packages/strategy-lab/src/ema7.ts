import { Bar, InstrumentProfile, SimulatedTrade } from './types';

/**
 * "7 EMA" strategy (TradeLikeBerlin, "7 EMA | The final boss of all the EMA strategies"):
 * - Bias from the 1h chart: last closed 1h candle above its 7 EMA -> longs only; below -> shorts only.
 * - Trade only a trending 15m market: few crosses of the 15m 7 EMA over the recent window (chop filter).
 * - Entry on 15m: price has closed on the bias side of the 7 EMA, then a candle retests the EMA (wick touches it)
 *   and closes back on the bias side (rejection) -> enter at the next candle's open.
 * - Stop: beyond the recent swing (lowest low / highest high of the last `swingLookback` candles).
 *   Optionally exit only on a candle CLOSE beyond the stop (the video's "wait for closing").
 * - Target: fixed R multiple, or adaptive: tight stop -> 4R, normal -> 3R, wide -> 2R (stop size vs ATR).
 */
export interface Ema7Params {
  emaPeriod: number;
  /** Chop filter: at most this many 15m EMA crosses in the last `chopWindow` candles. */
  maxCrosses: number;
  chopWindow: number;
  swingLookback: number;
  stopMode: 'TOUCH' | 'CLOSE';
  target: 'ADAPTIVE' | 2 | 3 | 4;
  /** Exit at the close of this many execution candles if neither stop nor target was hit. */
  maxBars: number;
  /** Execution and bias bar durations (default 15m execution with 1h bias, as in the video). */
  execBarMs?: number;
  biasBarMs?: number;
}

export const EMA7_DEFAULTS: Ema7Params = {
  emaPeriod: 7, maxCrosses: 2, chopWindow: 20, swingLookback: 5, stopMode: 'TOUCH', target: 'ADAPTIVE', maxBars: 96,
};

function ema(values: number[], period: number): number[] {
  const out: number[] = new Array(values.length);
  const k = 2 / (period + 1);
  values.forEach((v, i) => (out[i] = i === 0 ? v : v * k + out[i - 1] * (1 - k)));
  return out;
}

/**
 * Simulates the strategy on 15m bars with the 1h bias taken from `h1Bars` (each 1h bar is used only once it has
 * fully closed). Fills: next-bar open (taker + slippage), stop first on ambiguous bars, gap through the stop at
 * the open; close-based stops exit at the close of the breaching candle.
 */
export function simulateEma7(
  m15: Bar[],
  h1Bars: Bar[],
  profile: InstrumentProfile,
  params: Partial<Ema7Params> = {},
  range: { from: number; to: number } = { from: 0, to: m15.length },
): SimulatedTrade[] {
  const p = { ...EMA7_DEFAULTS, ...params };
  const M15 = p.execBarMs ?? 15 * 60 * 1000, H1 = p.biasBarMs ?? 60 * 60 * 1000;
  const ema15 = ema(m15.map((b) => b.c), p.emaPeriod);
  const ema1h = ema(h1Bars.map((b) => b.c), p.emaPeriod);
  // ATR(14) on 15m for adaptive targets
  const atr: number[] = new Array(m15.length).fill(0);
  let a = 0;
  for (let i = 0; i < m15.length; i++) {
    const b = m15[i];
    const tr = i === 0 ? b.h - b.l : Math.max(b.h - b.l, Math.abs(b.h - m15[i - 1].c), Math.abs(b.l - m15[i - 1].c));
    a = i < 14 ? (a * i + tr) / (i + 1) : (a * 13 + tr) / 14;
    atr[i] = a;
  }
  const side = profile.takerFeeRate + profile.slippageRate;
  const trades: SimulatedTrade[] = [];
  let h1Ptr = -1;
  const end = Math.min(range.to, m15.length);
  let i = Math.max(range.from, 60);
  while (i < end - 1) {
    const closeT = m15[i].t + M15;
    while (h1Ptr + 1 < h1Bars.length && h1Bars[h1Ptr + 1].t + H1 <= closeT) h1Ptr++;
    if (h1Ptr < p.emaPeriod) { i++; continue; }
    const bias = h1Bars[h1Ptr].c > ema1h[h1Ptr] ? 1 : h1Bars[h1Ptr].c < ema1h[h1Ptr] ? -1 : 0;
    if (bias === 0) { i++; continue; }

    // Chop filter: count EMA crosses in the recent window
    let crosses = 0;
    for (let j = i - p.chopWindow + 1; j <= i; j++) {
      if (j < 1) continue;
      if (Math.sign(m15[j].c - ema15[j]) !== Math.sign(m15[j - 1].c - ema15[j - 1])) crosses++;
    }
    if (crosses > p.maxCrosses) { i++; continue; }

    // Retest: previous candle closed on the bias side; this candle's wick touches the EMA and closes back on the bias side
    const b = m15[i], prev = m15[i - 1];
    const prevOnSide = bias === 1 ? prev.c > ema15[i - 1] : prev.c < ema15[i - 1];
    const retest = bias === 1 ? b.l <= ema15[i] && b.c > ema15[i] : b.h >= ema15[i] && b.c < ema15[i];
    if (!prevOnSide || !retest) { i++; continue; }

    const entryIndex = i + 1;
    const entry = m15[entryIndex].o;
    let swing = bias === 1 ? Infinity : -Infinity;
    for (let j = i - p.swingLookback + 1; j <= i; j++) swing = bias === 1 ? Math.min(swing, m15[j].l) : Math.max(swing, m15[j].h);
    const stop = swing;
    const risk = bias === 1 ? entry - stop : stop - entry;
    if (!(risk > 0) || (entry * 2 * side) / risk > 0.5) { i++; continue; } // cost gate, as live
    const rr = p.target === 'ADAPTIVE' ? (risk < 1 * atr[i] ? 4 : risk < 2 * atr[i] ? 3 : 2) : p.target;
    const target = bias === 1 ? entry + rr * risk : entry - rr * risk;

    let exitIndex = Math.min(entryIndex + p.maxBars - 1, end - 1), exit = m15[exitIndex].c;
    let reason: SimulatedTrade['exitReason'] = 'TIMEOUT';
    for (let j = entryIndex; j <= Math.min(entryIndex + p.maxBars - 1, end - 1); j++) {
      const c = m15[j];
      const stopTouched = bias === 1 ? c.l <= stop : c.h >= stop;
      const stopClosed = bias === 1 ? c.c <= stop : c.c >= stop;
      if (p.stopMode === 'TOUCH' && stopTouched) {
        exit = bias === 1 ? Math.min(stop, c.o) : Math.max(stop, c.o); exitIndex = j; reason = 'STOP'; break;
      }
      const targetHit = bias === 1 ? c.h >= target : c.l <= target;
      // Close-based stop; if the same candle also touched the target the order is unknown -> assume the stop.
      if (p.stopMode === 'CLOSE' && stopClosed) { exit = c.c; exitIndex = j; reason = 'STOP'; break; }
      if (targetHit) { exit = target; exitIndex = j; reason = 'TARGET'; break; }
    }
    const gross = (bias === 1 ? exit - entry : entry - exit) / risk;
    const costR = ((entry + exit) * side) / risk;
    trades.push({
      side: bias === 1 ? 'LONG' : 'SHORT', signalIndex: i, entryIndex, exitIndex, entry, stop, target, exit,
      exitReason: reason, netR: gross - costR, costR,
    });
    i = exitIndex + 1;
  }
  return trades;
}
