import { Bar, InstrumentProfile, SessionWindow } from './types';

/**
 * SMC / ICT building blocks, computed once per bar series.
 *
 * Every value at index i depends only on bars 0..i (no look-ahead). Swing points are fractals that need
 * SWING_LAG bars on the right, so a swing at index p only becomes known at p + SWING_LAG.
 */
export const SWING_LAG = 3;
const ATR_PERIOD = 14;
const HTF_EMA_PERIOD = 200; // ~50 hourly bars on a 15m series
const HTF_SLOPE_LOOKBACK = 20;
const ZONE_EXPIRY_BARS = 48;
const RECENT_BARS = 10;

export interface Features {
  n: number;
  atr: Float64Array;
  /** Latest confirmed swing high / low as of bar i (NaN until one exists). */
  swingHigh: Float64Array;
  swingLow: Float64Array;
  /** +1 after a bullish break of structure, -1 after a bearish one, 0 before any. */
  structureTrend: Int8Array;
  /** Higher-timeframe trend from a long EMA and its slope: +1 / -1 / 0. */
  htfTrend: Int8Array;
  /** Close in the lower (discount, +1) or upper (premium, -1) half of the current dealing range. */
  rangePosition: Int8Array;
  inKillzone: Uint8Array;
  inSilverBullet: Uint8Array;
  recentDisplacementUp: Uint8Array;
  recentDisplacementDown: Uint8Array;
  recentSweepLong: Uint8Array;
  recentSweepShort: Uint8Array;
  // Entry triggers
  fvgRetestLong: Uint8Array;
  fvgRetestShort: Uint8Array;
  obRetestLong: Uint8Array;
  obRetestShort: Uint8Array;
  sweepLong: Uint8Array;
  sweepShort: Uint8Array;
  bosPullbackLong: Uint8Array;
  bosPullbackShort: Uint8Array;
  oteLong: Uint8Array;
  oteShort: Uint8Array;
  // Trend / momentum / breakout triggers
  breakout20Long: Uint8Array;
  breakout20Short: Uint8Array;
  breakout55Long: Uint8Array;
  breakout55Short: Uint8Array;
  emaCrossLong: Uint8Array;
  emaCrossShort: Uint8Array;
  squeezeBreakoutLong: Uint8Array;
  squeezeBreakoutShort: Uint8Array;
  trendPullbackLong: Uint8Array;
  trendPullbackShort: Uint8Array;
  /** Structural stop candidates: lowest low / highest high of the last 5 bars. */
  recentLow: Float64Array;
  recentHigh: Float64Array;
}

function inWindows(t: number, windows: SessionWindow[]): boolean {
  const d = new Date(t);
  const h = d.getUTCHours() + d.getUTCMinutes() / 60;
  return windows.some((w) =>
    w.startHourUtc <= w.endHourUtc
      ? h >= w.startHourUtc && h < w.endHourUtc
      : h >= w.startHourUtc || h < w.endHourUtc,
  );
}

export function computeFeatures(bars: Bar[], profile: InstrumentProfile): Features {
  const n = bars.length;
  const f: Features = {
    n,
    atr: new Float64Array(n),
    swingHigh: new Float64Array(n).fill(NaN),
    swingLow: new Float64Array(n).fill(NaN),
    structureTrend: new Int8Array(n),
    htfTrend: new Int8Array(n),
    rangePosition: new Int8Array(n),
    inKillzone: new Uint8Array(n),
    inSilverBullet: new Uint8Array(n),
    recentDisplacementUp: new Uint8Array(n),
    recentDisplacementDown: new Uint8Array(n),
    recentSweepLong: new Uint8Array(n),
    recentSweepShort: new Uint8Array(n),
    fvgRetestLong: new Uint8Array(n),
    fvgRetestShort: new Uint8Array(n),
    obRetestLong: new Uint8Array(n),
    obRetestShort: new Uint8Array(n),
    sweepLong: new Uint8Array(n),
    sweepShort: new Uint8Array(n),
    bosPullbackLong: new Uint8Array(n),
    bosPullbackShort: new Uint8Array(n),
    oteLong: new Uint8Array(n),
    oteShort: new Uint8Array(n),
    breakout20Long: new Uint8Array(n),
    breakout20Short: new Uint8Array(n),
    breakout55Long: new Uint8Array(n),
    breakout55Short: new Uint8Array(n),
    emaCrossLong: new Uint8Array(n),
    emaCrossShort: new Uint8Array(n),
    squeezeBreakoutLong: new Uint8Array(n),
    squeezeBreakoutShort: new Uint8Array(n),
    trendPullbackLong: new Uint8Array(n),
    trendPullbackShort: new Uint8Array(n),
    recentLow: new Float64Array(n),
    recentHigh: new Float64Array(n),
  };
  if (n === 0) return f;
  computeTrendFeatures(bars, f);

  // ATR (Wilder)
  let atr = bars[0].h - bars[0].l;
  for (let i = 0; i < n; i++) {
    const b = bars[i];
    const tr = i === 0 ? b.h - b.l : Math.max(b.h - b.l, Math.abs(b.h - bars[i - 1].c), Math.abs(b.l - bars[i - 1].c));
    atr = i < ATR_PERIOD ? (atr * i + tr) / (i + 1) : (atr * (ATR_PERIOD - 1) + tr) / ATR_PERIOD;
    f.atr[i] = atr;
  }

  // HTF trend: EMA(200) and its slope
  const k = 2 / (HTF_EMA_PERIOD + 1);
  const ema = new Float64Array(n);
  ema[0] = bars[0].c;
  for (let i = 1; i < n; i++) ema[i] = bars[i].c * k + ema[i - 1] * (1 - k);
  for (let i = HTF_EMA_PERIOD; i < n; i++) {
    const slope = ema[i] - ema[i - HTF_SLOPE_LOOKBACK];
    if (bars[i].c > ema[i] && slope > 0) f.htfTrend[i] = 1;
    else if (bars[i].c < ema[i] && slope < 0) f.htfTrend[i] = -1;
  }

  // Swing points (fractals), known SWING_LAG bars after the pivot. Track the last two of each for impulse legs.
  let lastSH = NaN, lastSHIdx = -1, lastSL = NaN, lastSLIdx = -1;
  let trend = 0;
  let lastDispUp = -1e9, lastDispDown = -1e9, lastSweepL = -1e9, lastSweepS = -1e9;

  // Active zones
  let bullFvg: { top: number; bottom: number; idx: number } | null = null;
  let bearFvg: { top: number; bottom: number; idx: number } | null = null;
  let bullOb: { top: number; bottom: number; idx: number } | null = null;
  let bearOb: { top: number; bottom: number; idx: number } | null = null;
  let bosUp: { level: number; idx: number } | null = null;
  let brokenHigh = NaN, brokenLow = NaN;
  let bosDown: { level: number; idx: number } | null = null;

  for (let i = 0; i < n; i++) {
    const b = bars[i];
    const a = f.atr[i];

    // Confirm the pivot at p = i - SWING_LAG
    const p = i - SWING_LAG;
    if (p >= SWING_LAG) {
      let isHigh = true, isLow = true;
      for (let j = p - SWING_LAG; j <= p + SWING_LAG; j++) {
        if (j === p) continue;
        if (bars[j].h >= bars[p].h) isHigh = false;
        if (bars[j].l <= bars[p].l) isLow = false;
      }
      if (isHigh) { lastSH = bars[p].h; lastSHIdx = p; }
      if (isLow) { lastSL = bars[p].l; lastSLIdx = p; }
    }

    // Sweeps (wick through the prior swing, close back inside) - evaluated against swings known before this bar
    const prevSH = i > 0 ? f.swingHigh[i - 1] : NaN;
    const prevSL = i > 0 ? f.swingLow[i - 1] : NaN;
    if (!Number.isNaN(prevSL) && b.l < prevSL && b.c > prevSL) { f.sweepLong[i] = 1; lastSweepL = i; }
    if (!Number.isNaN(prevSH) && b.h > prevSH && b.c < prevSH) { f.sweepShort[i] = 1; lastSweepS = i; }

    // Break of structure: registered once per broken swing level (not on every bar that stays beyond it)
    if (!Number.isNaN(prevSH) && b.c > prevSH && prevSH !== brokenHigh) {
      trend = 1; brokenHigh = prevSH; bosUp = { level: prevSH, idx: i };
    }
    if (!Number.isNaN(prevSL) && b.c < prevSL && prevSL !== brokenLow) {
      trend = -1; brokenLow = prevSL; bosDown = { level: prevSL, idx: i };
    }

    f.swingHigh[i] = lastSH;
    f.swingLow[i] = lastSL;
    f.structureTrend[i] = trend;

    // Displacement
    const body = Math.abs(b.c - b.o);
    const range = Math.max(b.h - b.l, 1e-12);
    if (i > ATR_PERIOD && body >= 1.2 * a && body / range >= 0.6) {
      if (b.c > b.o) lastDispUp = i;
      else lastDispDown = i;
    }
    f.recentDisplacementUp[i] = i - lastDispUp <= RECENT_BARS ? 1 : 0;
    f.recentDisplacementDown[i] = i - lastDispDown <= RECENT_BARS ? 1 : 0;
    f.recentSweepLong[i] = i - lastSweepL <= RECENT_BARS ? 1 : 0;
    f.recentSweepShort[i] = i - lastSweepS <= RECENT_BARS ? 1 : 0;

    // Dealing range position
    if (!Number.isNaN(lastSH) && !Number.isNaN(lastSL) && lastSH > lastSL) {
      const mid = (lastSH + lastSL) / 2;
      f.rangePosition[i] = b.c < mid ? 1 : -1;
    }

    // Sessions
    f.inKillzone[i] = inWindows(b.t, profile.killzones) ? 1 : 0;
    f.inSilverBullet[i] = profile.silverBullet && inWindows(b.t, [profile.silverBullet]) ? 1 : 0;

    // Recent extremes for structural stops
    let lo = b.l, hi = b.h;
    for (let j = Math.max(0, i - 4); j < i; j++) { lo = Math.min(lo, bars[j].l); hi = Math.max(hi, bars[j].h); }
    f.recentLow[i] = lo;
    f.recentHigh[i] = hi;

    // --- FVG retests (zone formed on an earlier bar, retested now) ---
    if (bullFvg && (b.c < bullFvg.bottom || i - bullFvg.idx > ZONE_EXPIRY_BARS)) bullFvg = null;
    if (bearFvg && (b.c > bearFvg.top || i - bearFvg.idx > ZONE_EXPIRY_BARS)) bearFvg = null;
    if (bullFvg && i > bullFvg.idx && b.l <= bullFvg.top && b.c > bullFvg.bottom) { f.fvgRetestLong[i] = 1; bullFvg = null; }
    if (bearFvg && i > bearFvg.idx && b.h >= bearFvg.bottom && b.c < bearFvg.top) { f.fvgRetestShort[i] = 1; bearFvg = null; }
    if (i >= 2) {
      if (b.l > bars[i - 2].h) bullFvg = { top: b.l, bottom: bars[i - 2].h, idx: i };
      if (b.h < bars[i - 2].l) bearFvg = { top: bars[i - 2].l, bottom: b.h, idx: i };
    }

    // --- Order block retests: last opposite candle before a displacement ---
    if (bullOb && (b.c < bullOb.bottom || i - bullOb.idx > ZONE_EXPIRY_BARS)) bullOb = null;
    if (bearOb && (b.c > bearOb.top || i - bearOb.idx > ZONE_EXPIRY_BARS)) bearOb = null;
    if (bullOb && i > bullOb.idx && b.l <= bullOb.top && b.c > bullOb.bottom) { f.obRetestLong[i] = 1; bullOb = null; }
    if (bearOb && i > bearOb.idx && b.h >= bearOb.bottom && b.c < bearOb.top) { f.obRetestShort[i] = 1; bearOb = null; }
    if (lastDispUp === i) {
      for (let j = i - 1; j >= Math.max(0, i - 5); j--) {
        if (bars[j].c < bars[j].o) { bullOb = { top: bars[j].h, bottom: bars[j].l, idx: i }; break; }
      }
    }
    if (lastDispDown === i) {
      for (let j = i - 1; j >= Math.max(0, i - 5); j--) {
        if (bars[j].c > bars[j].o) { bearOb = { top: bars[j].h, bottom: bars[j].l, idx: i }; break; }
      }
    }

    // --- BOS pullback: first retest of the broken level within 12 bars ---
    if (bosUp && i > bosUp.idx && i - bosUp.idx <= 12 && trend === 1 && b.l <= bosUp.level + 0.2 * a && b.c > bosUp.level) {
      f.bosPullbackLong[i] = 1; bosUp = null;
    }
    if (bosDown && i > bosDown.idx && i - bosDown.idx <= 12 && trend === -1 && b.h >= bosDown.level - 0.2 * a && b.c < bosDown.level) {
      f.bosPullbackShort[i] = 1; bosDown = null;
    }

    // --- OTE: 62-79% retracement of the latest impulse leg, with a rejection close ---
    if (!Number.isNaN(lastSH) && !Number.isNaN(lastSL) && lastSH > lastSL) {
      const leg = lastSH - lastSL;
      if (lastSHIdx > lastSLIdx) {
        const r = (lastSH - b.c) / leg;
        if (r >= 0.62 && r <= 0.79 && b.c > b.o) f.oteLong[i] = 1;
      } else if (lastSLIdx > lastSHIdx) {
        const r = (b.c - lastSL) / leg;
        if (r >= 0.62 && r <= 0.79 && b.c < b.o) f.oteShort[i] = 1;
      }
    }
  }
  return f;
}

/** Aggregates bars into a higher timeframe of `factor` source bars each (e.g. 4 x 15m = 1h). Incomplete groups are dropped. */
export function aggregateBars(bars: Bar[], factor: number, barMs: number): Bar[] {
  const out: Bar[] = [];
  const span = barMs * factor;
  let cur: Bar | null = null;
  let count = 0;
  for (const b of bars) {
    const bucket = Math.floor(b.t / span) * span;
    if (!cur || cur.t !== bucket) {
      if (cur && count === factor) out.push(cur);
      cur = { t: bucket, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v };
      count = 1;
    } else {
      cur.h = Math.max(cur.h, b.h);
      cur.l = Math.min(cur.l, b.l);
      cur.c = b.c;
      cur.v += b.v;
      count++;
    }
  }
  if (cur && count === factor) out.push(cur);
  return out;
}

/** Exponential moving average of closes. */
function emaOf(bars: Bar[], period: number): Float64Array {
  const out = new Float64Array(bars.length);
  if (bars.length === 0) return out;
  const k = 2 / (period + 1);
  out[0] = bars[0].c;
  for (let i = 1; i < bars.length; i++) out[i] = bars[i].c * k + out[i - 1] * (1 - k);
  return out;
}

/**
 * Trend / momentum / breakout triggers (no look-ahead: the channel / band at i uses bars before i or up to i).
 * - BREAKOUT_N: first close beyond the highest high / lowest low of the previous N bars (Donchian).
 * - EMA_CROSS: EMA20 crosses EMA50.
 * - SQUEEZE_BREAKOUT: Bollinger(20, 2) bandwidth of the previous bar in the lowest 20% of the last 120 bars,
 *   and this bar closes outside the band.
 * - TREND_PULLBACK: EMA50 above (below) EMA200 and RSI(14) crosses back above 40 (below 60).
 */
function computeTrendFeatures(bars: Bar[], f: Features): void {
  const n = bars.length;
  const ema20 = emaOf(bars, 20), ema50 = emaOf(bars, 50), ema200 = emaOf(bars, 200);

  // RSI(14), Wilder
  const rsi = new Float64Array(n).fill(50);
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i < n; i++) {
    const ch = bars[i].c - bars[i - 1].c;
    const gain = Math.max(ch, 0), loss = Math.max(-ch, 0);
    if (i <= 14) { avgGain += gain / 14; avgLoss += loss / 14; }
    else { avgGain = (avgGain * 13 + gain) / 14; avgLoss = (avgLoss * 13 + loss) / 14; }
    if (i >= 14) rsi[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }

  // Bollinger bandwidth (20, 2)
  const bw = new Float64Array(n).fill(NaN), upper = new Float64Array(n).fill(NaN), lower = new Float64Array(n).fill(NaN);
  let sum = 0, sumSq = 0;
  for (let i = 0; i < n; i++) {
    sum += bars[i].c; sumSq += bars[i].c * bars[i].c;
    if (i >= 20) { sum -= bars[i - 20].c; sumSq -= bars[i - 20].c * bars[i - 20].c; }
    if (i >= 19) {
      const mean = sum / 20;
      const sd = Math.sqrt(Math.max(sumSq / 20 - mean * mean, 0));
      upper[i] = mean + 2 * sd; lower[i] = mean - 2 * sd;
      bw[i] = mean > 0 ? (upper[i] - lower[i]) / mean : NaN;
    }
  }

  const donchian = (len: number, longOut: Uint8Array, shortOut: Uint8Array) => {
    for (let i = len + 1; i < n; i++) {
      let hi = -Infinity, lo = Infinity, prevHi = -Infinity, prevLo = Infinity;
      for (let j = i - len; j < i; j++) { hi = Math.max(hi, bars[j].h); lo = Math.min(lo, bars[j].l); }
      for (let j = i - 1 - len; j < i - 1; j++) { prevHi = Math.max(prevHi, bars[j].h); prevLo = Math.min(prevLo, bars[j].l); }
      if (bars[i].c > hi && bars[i - 1].c <= prevHi) longOut[i] = 1;
      if (bars[i].c < lo && bars[i - 1].c >= prevLo) shortOut[i] = 1;
    }
  };
  donchian(20, f.breakout20Long, f.breakout20Short);
  donchian(55, f.breakout55Long, f.breakout55Short);

  for (let i = 201; i < n; i++) {
    if (ema20[i] > ema50[i] && ema20[i - 1] <= ema50[i - 1]) f.emaCrossLong[i] = 1;
    if (ema20[i] < ema50[i] && ema20[i - 1] >= ema50[i - 1]) f.emaCrossShort[i] = 1;
    if (ema50[i] > ema200[i] && rsi[i - 1] < 40 && rsi[i] >= 40) f.trendPullbackLong[i] = 1;
    if (ema50[i] < ema200[i] && rsi[i - 1] > 60 && rsi[i] <= 60) f.trendPullbackShort[i] = 1;
    if (i >= 121 && !Number.isNaN(bw[i - 1])) {
      let below = 0, count = 0;
      for (let j = i - 120; j < i; j++) { if (!Number.isNaN(bw[j])) { count++; if (bw[j] < bw[i - 1]) below++; } }
      const isSqueeze = count > 0 && below / count <= 0.2;
      if (isSqueeze && bars[i].c > upper[i]) f.squeezeBreakoutLong[i] = 1;
      if (isSqueeze && bars[i].c < lower[i]) f.squeezeBreakoutShort[i] = 1;
    }
  }
}
