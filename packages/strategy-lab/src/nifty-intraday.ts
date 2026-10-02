import { Bar } from './types';

/**
 * NIFTY intraday strategy study: session-based setups traded through options and closed the same day.
 *
 * Every rule is point in time: a signal at a bar uses only that bar's close and earlier data, entries fill at the
 * signal bar's close, stops are checked first on ambiguous bars, and positions are closed at 15:15 IST.
 * Option P&L is modelled from the index move (no historical option prices are available):
 *   ITM option: 0.8 x index points - 1.5 pts/hour time decay - 4 pts costs (spread, brokerage, taxes)
 *   ATM option: 0.5 x index points - 3 pts/hour time decay - 3 pts costs
 *   Futures:    1.0 x index points - 1.5 pts costs
 */

const IST = 5.5 * 3_600_000;
const DAY = 86_400_000;

export type IntradayTrigger = 'ORB' | 'ORB2' | 'PDHL' | 'CPR' | 'ST_FLIP' | 'EMA_X' | 'EMA_PULLBACK';
export type IntradayDirFilter = 'NONE' | 'DAILY_TREND' | 'ST_ALIGN' | 'GAP_ALIGN';
export type IntradayDayFilter = 'ALL' | 'NARROW_CPR' | 'NO_EXPIRY' | 'EXPIRY_ONLY';
export type IntradayExit = 'EOD' | 'R1_5' | 'R2' | 'R3' | 'ST_FLIP';
/** PTSnn: fixed nn NIFTY points; ATR_40_80: 1.5 x ATR kept between 40 and 80 points */
export type IntradayStop = 'SIGNAL_BAR' | 'ATR1' | 'ATR2' | 'PTS30' | 'PTS40' | 'PTS60' | 'PTS80' | 'ATR_40_80';
export type IntradayInstrument = 'ITM_OPTION' | 'ATM_OPTION' | 'FUTURES';

export interface IntradayGenome {
  trigger: IntradayTrigger;
  dirFilter: IntradayDirFilter;
  dayFilter: IntradayDayFilter;
  /** Latest entry time, minutes after midnight IST */
  lastEntryMin: number;
  exit: IntradayExit;
  stop: IntradayStop;
}

export const INSTRUMENT_MODELS: Record<IntradayInstrument, { delta: number; thetaPerHour: number; cost: number }> = {
  ITM_OPTION: { delta: 0.8, thetaPerHour: 1.5, cost: 4 },
  ATM_OPTION: { delta: 0.5, thetaPerHour: 3, cost: 3 },
  FUTURES: { delta: 1, thetaPerHour: 0, cost: 1.5 },
};

export type IntradayExitReason = 'STOP' | 'TARGET' | 'EOD' | 'ST_FLIP' | 'OPEN';

export interface IntradayTrade {
  date: string;
  side: 1 | -1;
  /** Close time of the signal bar (entry time) and of the exit bar */
  entryTime: number;
  exitTime: number;
  entry: number;
  stop: number;
  target: number | null;
  exit: number;
  /** OPEN: the session has not reached an exit yet (live data); exit = latest close */
  exitReason: IntradayExitReason;
  indexPoints: number;
  hours: number;
  /** Premium points for each instrument model */
  pnl: Record<IntradayInstrument, number>;
}

export interface Session {
  date: string;
  bars: Bar[];
  /** Index of the session's first bar in the continuous series */
  offset: number;
  prevHigh: number;
  prevLow: number;
  prevClose: number;
  cprTop: number;
  cprBottom: number;
  pivot: number;
  narrowCpr: boolean;
  dailyTrend: number;
  gap: number;
  isExpiry: boolean;
}

export interface PreparedSeries {
  barMs: number;
  bars: Bar[];
  sessions: Session[];
  atr: number[];
  stDir: number[];
  ema9: number[];
  ema21: number[];
}

const istDate = (t: number) => new Date(t + IST).toISOString().slice(0, 10);
export const istMinutes = (t: number) => {
  const d = new Date(t + IST);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
};

/** NIFTY weekly expiry: Thursday until 31 Aug 2025, Tuesday from 1 Sep 2025 (holiday shifts not modelled). */
export function isNiftyExpiryDay(date: string): boolean {
  const wd = new Date(`${date}T00:00:00Z`).getUTCDay();
  return date < '2025-09-01' ? wd === 4 : wd === 2;
}

function emaSeries(x: number[], p: number): number[] {
  const k = 2 / (p + 1);
  const o: number[] = [];
  x.forEach((v, i) => (o[i] = i ? v * k + o[i - 1] * (1 - k) : v));
  return o;
}

export function prepareSeries(bars: Bar[], barMs: number): PreparedSeries {
  const n = bars.length;
  // ATR(14) and Supertrend(10, 3) over the continuous series
  const tr = bars.map((b, i) => (i ? Math.max(b.h - b.l, Math.abs(b.h - bars[i - 1].c), Math.abs(b.l - bars[i - 1].c)) : b.h - b.l));
  const atr: number[] = [];
  let a14 = 0, a10 = 0, up = 0, dn = 0, trend = 1;
  const stDir: number[] = [];
  for (let i = 0; i < n; i++) {
    a14 = i < 14 ? (a14 * i + tr[i]) / (i + 1) : (a14 * 13 + tr[i]) / 14;
    atr.push(a14);
    a10 = i < 10 ? (a10 * i + tr[i]) / (i + 1) : (a10 * 9 + tr[i]) / 10;
    const hl2 = (bars[i].h + bars[i].l) / 2;
    const u = hl2 - 3 * a10, d = hl2 + 3 * a10;
    const pu = up, pd = dn;
    up = i && bars[i - 1].c > pu ? Math.max(u, pu) : u;
    dn = i && bars[i - 1].c < pd ? Math.min(d, pd) : d;
    trend = trend === -1 && bars[i].c > pd ? 1 : trend === 1 && bars[i].c < pu ? -1 : trend;
    stDir.push(trend);
  }
  const closes = bars.map((b) => b.c);
  const ema9 = emaSeries(closes, 9), ema21 = emaSeries(closes, 21);

  // Sessions
  const groups: Array<{ date: string; offset: number; bars: Bar[] }> = [];
  bars.forEach((b, i) => {
    const d = istDate(b.t);
    if (!groups.length || groups[groups.length - 1].date !== d) groups.push({ date: d, offset: i, bars: [] });
    groups[groups.length - 1].bars.push(b);
  });
  const sessions: Session[] = [];
  const widths: number[] = [];
  const dailyCloses: number[] = [];
  for (let k = 0; k < groups.length; k++) {
    const g = groups[k];
    if (k > 0) {
      const p = groups[k - 1].bars;
      const H = Math.max(...p.map((b) => b.h)), L = Math.min(...p.map((b) => b.l)), C = p[p.length - 1].c;
      const P = (H + L + C) / 3, BC = (H + L) / 2, TC = 2 * P - BC;
      const width = Math.abs(TC - BC) / P;
      const recent = widths.slice(-50);
      const narrowCpr = recent.length >= 20 && width <= [...recent].sort((x, y) => x - y)[Math.floor(recent.length * 0.3)];
      const last20 = dailyCloses.slice(-20);
      const sma = last20.reduce((s, x) => s + x, 0) / Math.max(1, last20.length);
      sessions.push({
        date: g.date,
        bars: g.bars,
        offset: g.offset,
        prevHigh: H,
        prevLow: L,
        prevClose: C,
        cprTop: Math.max(TC, BC),
        cprBottom: Math.min(TC, BC),
        pivot: P,
        narrowCpr,
        dailyTrend: last20.length >= 20 ? (C > sma ? 1 : C < sma ? -1 : 0) : 0,
        gap: (g.bars[0].o - C) / C,
        isExpiry: isNiftyExpiryDay(g.date),
      });
      widths.push(width);
    }
    dailyCloses.push(g.bars[g.bars.length - 1].c);
  }
  return { barMs, bars, sessions, atr, stDir, ema9, ema21 };
}

const EXIT_MIN = 15 * 60 + 15;

/** Direction of the trigger at session bar j (0 = none). */
function triggerAt(g: IntradayGenome, s: PreparedSeries, ses: Session, j: number): number {
  const i = ses.offset + j;
  const b = ses.bars[j];
  const barsPer30 = Math.max(1, Math.round(1_800_000 / s.barMs));
  switch (g.trigger) {
    case 'ORB':
    case 'ORB2': {
      const n = g.trigger === 'ORB' ? 1 : Math.max(2, barsPer30);
      if (j < n) return 0;
      const hi = Math.max(...ses.bars.slice(0, n).map((x) => x.h)), lo = Math.min(...ses.bars.slice(0, n).map((x) => x.l));
      return b.c > hi ? 1 : b.c < lo ? -1 : 0;
    }
    case 'PDHL':
      return b.c > ses.prevHigh ? 1 : b.c < ses.prevLow ? -1 : 0;
    case 'CPR':
      return b.c > ses.cprTop ? 1 : b.c < ses.cprBottom ? -1 : 0;
    case 'ST_FLIP':
      return s.stDir[i] !== s.stDir[i - 1] ? s.stDir[i] : 0;
    case 'EMA_X':
      return s.ema9[i] > s.ema21[i] && s.ema9[i - 1] <= s.ema21[i - 1] ? 1 : s.ema9[i] < s.ema21[i] && s.ema9[i - 1] >= s.ema21[i - 1] ? -1 : 0;
    case 'EMA_PULLBACK': {
      // In a supertrend, a bar dips to the 21 EMA and closes back on the trend side
      const d = s.stDir[i];
      if (d > 0 && b.l <= s.ema21[i] && b.c > s.ema21[i] && b.c > b.o) return 1;
      if (d < 0 && b.h >= s.ema21[i] && b.c < s.ema21[i] && b.c < b.o) return -1;
      return 0;
    }
  }
}

function passesDirFilter(g: IntradayGenome, s: PreparedSeries, ses: Session, i: number, dir: number): boolean {
  switch (g.dirFilter) {
    case 'NONE': return true;
    case 'DAILY_TREND': return ses.dailyTrend === dir;
    case 'ST_ALIGN': return s.stDir[i] === dir;
    case 'GAP_ALIGN': return Math.sign(ses.gap) === dir && Math.abs(ses.gap) >= 0.001;
  }
}

function passesDayFilter(g: IntradayGenome, ses: Session): boolean {
  switch (g.dayFilter) {
    case 'ALL': return true;
    case 'NARROW_CPR': return ses.narrowCpr;
    case 'NO_EXPIRY': return !ses.isExpiry;
    case 'EXPIRY_ONLY': return ses.isExpiry;
  }
}

/** One trade per session at most (the first qualifying signal). */
export function simulateIntraday(g: IntradayGenome, s: PreparedSeries, fromDate = '0000', toDate = '9999'): IntradayTrade[] {
  const out: IntradayTrade[] = [];
  const hoursPerBar = s.barMs / 3_600_000;
  for (const ses of s.sessions) {
    if (ses.date < fromDate || ses.date >= toDate || !passesDayFilter(g, ses)) continue;
    // The latest bar can be a signal too (live: the bar that just closed); later bars decide the exit or leave it OPEN
    for (let j = 0; j < ses.bars.length; j++) {
      const i = ses.offset + j;
      if (i < 30 || istMinutes(ses.bars[j].t + s.barMs) > g.lastEntryMin) break;
      const dir = triggerAt(g, s, ses, j);
      if (!dir || !passesDirFilter(g, s, ses, i, dir)) continue;
      const b = ses.bars[j];
      const entry = b.c;
      const stop =
        g.stop === 'SIGNAL_BAR' ? (dir > 0 ? Math.min(b.l, entry - 0.25 * s.atr[i]) : Math.max(b.h, entry + 0.25 * s.atr[i]))
        : g.stop === 'ATR1' ? entry - dir * s.atr[i]
        : g.stop.startsWith('PTS') ? entry - dir * Number(g.stop.slice(3))
        : g.stop === 'ATR_40_80' ? entry - dir * Math.min(80, Math.max(40, 1.5 * s.atr[i]))
        : entry - dir * 2 * s.atr[i];
      const risk = Math.abs(entry - stop);
      if (!(risk > 0)) break;
      const rr = g.exit === 'R1_5' ? 1.5 : g.exit === 'R2' ? 2 : g.exit === 'R3' ? 3 : 0;
      const target = rr ? entry + dir * rr * risk : null;
      let exit = entry, k = j + 1;
      let reason: IntradayExitReason = 'OPEN';
      let exitTime = b.t + s.barMs;
      for (; k < ses.bars.length; k++) {
        const x = ses.bars[k];
        if (istMinutes(x.t) >= EXIT_MIN) { exit = x.o; reason = 'EOD'; exitTime = x.t; break; }
        exitTime = x.t + s.barMs;
        if (dir > 0 ? x.l <= stop : x.h >= stop) { exit = k > j + 1 ? (dir > 0 ? Math.min(stop, x.o) : Math.max(stop, x.o)) : stop; reason = 'STOP'; break; }
        if (target !== null && (dir > 0 ? x.h >= target : x.l <= target)) { exit = target; reason = 'TARGET'; break; }
        if (g.exit === 'ST_FLIP' && s.stDir[ses.offset + k] !== dir) { exit = x.c; reason = 'ST_FLIP'; break; }
        exit = x.c;
      }
      const pts = dir * (exit - entry);
      const hours = Math.max(hoursPerBar, (Math.min(k, ses.bars.length - 1) - j) * hoursPerBar);
      const pnl = {} as Record<IntradayInstrument, number>;
      for (const [name, m] of Object.entries(INSTRUMENT_MODELS)) pnl[name as IntradayInstrument] = m.delta * pts - m.thetaPerHour * hours - m.cost;
      out.push({
        date: ses.date, side: dir as 1 | -1, entryTime: b.t + s.barMs, exitTime, entry, stop, target, exit, exitReason: reason,
        indexPoints: pts, hours, pnl,
      });
      break;
    }
  }
  return out;
}

export function enumerateIntradayGenomes(
  barMs: number,
  stops: IntradayStop[] = ['SIGNAL_BAR', 'ATR1', 'ATR2'],
  exits: IntradayExit[] = ['EOD', 'R1_5', 'R2', 'ST_FLIP'],
): IntradayGenome[] {
  const triggers: IntradayTrigger[] = ['ORB', 'PDHL', 'CPR', 'ST_FLIP', 'EMA_X', 'EMA_PULLBACK'];
  if (barMs <= 15 * 60_000) triggers.push('ORB2'); // 30-minute opening range only exists on finer bars
  const out: IntradayGenome[] = [];
  for (const trigger of triggers)
    for (const dirFilter of ['NONE', 'DAILY_TREND', 'ST_ALIGN', 'GAP_ALIGN'] as IntradayDirFilter[])
      for (const dayFilter of ['ALL', 'NARROW_CPR', 'NO_EXPIRY', 'EXPIRY_ONLY'] as IntradayDayFilter[])
        for (const lastEntryMin of [11 * 60 + 30, 14 * 60])
          for (const exit of exits)
            for (const stop of stops) {
              if (trigger === 'ST_FLIP' && dirFilter === 'ST_ALIGN') continue; // always true
              out.push({ trigger, dirFilter, dayFilter, lastEntryMin, exit, stop });
            }
  return out;
}

export function describeIntraday(g: IntradayGenome): string {
  const t = `${Math.floor(g.lastEntryMin / 60)}:${String(g.lastEntryMin % 60).padStart(2, '0')}`;
  return `${g.trigger}${g.dirFilter !== 'NONE' ? ` + ${g.dirFilter}` : ''}${g.dayFilter !== 'ALL' ? ` [${g.dayFilter}]` : ''}, entries until ${t}, stop ${g.stop}, exit ${g.exit}`;
}

export interface IntradayStats { trades: number; mean: number; total: number; tStat: number; winRate: number }

export function intradayStats(tr: IntradayTrade[], inst: IntradayInstrument): IntradayStats {
  const v = tr.map((t) => t.pnl[inst]);
  const n = v.length;
  const mean = n ? v.reduce((a, b) => a + b, 0) / n : 0;
  const sd = n > 1 ? Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0;
  return { trades: n, mean, total: mean * n, tStat: sd > 0 ? (mean / sd) * Math.sqrt(n) : 0, winRate: n ? v.filter((x) => x > 0).length / n : 0 };
}

export const DAY_MS = DAY;

/** NIFTY strike ~`depth` points in the money for the trade side (calls below spot, puts above), on the 50-point grid. */
export function itmStrike(spot: number, side: 1 | -1, depth = 150, step = 50): number {
  return side > 0 ? Math.floor((spot - depth) / step) * step : Math.ceil((spot + depth) / step) * step;
}

/** Stable id for a genome (used to register / dedupe watch strategies). */
export function intradayGenomeId(g: IntradayGenome): string {
  return `NIFTY_ID:${g.trigger}|${g.dirFilter}|${g.dayFilter}|${g.lastEntryMin}|${g.stop}|${g.exit}`;
}
