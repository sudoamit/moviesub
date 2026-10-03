import { computeFeatures } from '../primitives';
import { qualityFeaturesAt, QUALITY_FEATURES } from '../quality';
import { prepareSeries, simulateIntraday, IntradayGenome } from '../nifty-intraday';
import { Bar, InstrumentProfile } from '../types';

/**
 * FEATURE TIME vs LABEL TIME.
 * A feature at bar i may use only bars 0..i (information available at bar i's close). These tests recompute
 * every feature on the history TRUNCATED right after bar i and require the same value: any dependence on a later
 * bar (future close, future ATR / EMA, future swing, future volume, future liquidity zone) changes the value.
 */

const profile: InstrumentProfile = { symbol: 'TEST', makerFeeRate: 0.0002, takerFeeRate: 0.0005, slippageRate: 0.0001, barMs: 3_600_000, killzones: [] };

function walk(n: number, seed: number, start = 0, barMs = 3_600_000): Bar[] {
  let s = seed >>> 0;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const out: Bar[] = [];
  let p = 30_000;
  for (let i = 0; i < n; i++) {
    const o = p, c = o * (1 + (rnd() - 0.5) * 0.02);
    out.push({ t: start + i * barMs, o, h: Math.max(o, c) * (1 + rnd() * 0.008), l: Math.min(o, c) * (1 - rnd() * 0.008), c, v: 1 + rnd() * (rnd() < 0.05 ? 20 : 2) });
    p = c;
  }
  return out;
}

/** Returns the first index (< cut) whose value differs between the full and truncated computation, or -1. */
function firstLeak(full: ArrayLike<number>, truncated: ArrayLike<number>, cut: number): number {
  for (let i = 0; i < cut; i++) {
    const a = full[i], b = truncated[i];
    if (!(a === b || (Number.isNaN(a) && Number.isNaN(b)) || Math.abs(a - b) < 1e-9)) return i;
  }
  return -1;
}

const CUTS = [400, 777, 1234, 1999];

describe('no look-ahead in research features', () => {
  const bars = walk(2400, 11);
  const full = computeFeatures(bars, profile) as unknown as Record<string, unknown>;
  const arrays = Object.keys(full).filter((k) => ArrayBuffer.isView(full[k]) || Array.isArray(full[k]));

  it('the checker catches a deliberately leaky feature (canary)', () => {
    const leaky = (b: Bar[]) => b.map((_, i) => (i + 1 < b.length ? b[i + 1].c : NaN)); // uses the NEXT close
    expect(firstLeak(leaky(bars), leaky(bars.slice(0, 1000)), 1000)).toBe(999);
    const centred = (b: Bar[]) => b.map((_, i) => b.slice(Math.max(0, i - 3), i + 4).reduce((a, x) => a + x.c, 0)); // centred window
    expect(firstLeak(centred(bars), centred(bars.slice(0, 1000)), 1000)).toBeGreaterThanOrEqual(996);
  });

  it('covers every feature array the strategy search uses', () => {
    expect(arrays.length).toBeGreaterThanOrEqual(30);
  });

  it.each(CUTS)('every feature array is unchanged when history is cut after bar %i', (cut) => {
    const part = computeFeatures(bars.slice(0, cut), profile) as unknown as Record<string, ArrayLike<number>>;
    const leaks = arrays.map((k) => [k, firstLeak(full[k] as ArrayLike<number>, part[k], cut)] as const).filter(([, i]) => i >= 0);
    expect(leaks).toEqual([]);
  });

  it.each(CUTS)('quality-model inputs at the signal bar are unchanged when history is cut after bar %i', (cut) => {
    const part = computeFeatures(bars.slice(0, cut), profile);
    for (const i of [cut - 1, cut - 7, cut - 120]) {
      for (const side of ['LONG', 'SHORT'] as const) {
        const a = qualityFeaturesAt(bars, full as any, i, side);
        const b = qualityFeaturesAt(bars.slice(0, cut), part, i, side);
        const diff = a.map((v, j) => (Math.abs(v - b[j]) > 1e-9 ? QUALITY_FEATURES[j] : null)).filter(Boolean);
        expect(diff).toEqual([]);
      }
    }
  });
});

describe('no look-ahead in the NIFTY intraday study', () => {
  // 60 sessions of 25 x 15m bars from 09:15 IST
  const M15 = 900_000, IST = 5.5 * 3_600_000;
  const bars: Bar[] = [];
  for (let d = 0; d < 60; d++) {
    const open = Date.UTC(2026, 0, 5) + d * 86_400_000 + (9 * 60 + 15) * 60_000 - IST;
    for (const b of walk(25, 100 + d, open, M15)) bars.push({ ...b, o: b.o * 0.8, h: b.h * 0.8, l: b.l * 0.8, c: b.c * 0.8 });
  }
  const full = prepareSeries(bars, M15);

  it.each([300, 777, 1111, 1480])('series indicators and session context are unchanged when history is cut after bar %i', (cut) => {
    const part = prepareSeries(bars.slice(0, cut), M15);
    for (const k of ['atr', 'stDir', 'ema9', 'ema21'] as const) expect(firstLeak(full[k], part[k], cut)).toBe(-1);
    for (const ps of part.sessions) {
      const fs = full.sessions.find((x) => x.date === ps.date)!;
      // context known at the session open (previous day levels, CPR, daily trend, gap, expiry)
      for (const k of ['prevHigh', 'prevLow', 'prevClose', 'cprTop', 'cprBottom', 'pivot', 'narrowCpr', 'dailyTrend', 'gap', 'isExpiry'] as const) {
        expect(ps[k]).toEqual(fs[k]);
      }
    }
  });

  it('a trade decision (entry bar, side, entry price, stop, target) never changes when later bars are removed', () => {
    const genomes: IntradayGenome[] = [
      { trigger: 'ORB', dirFilter: 'NONE', dayFilter: 'ALL', lastEntryMin: 14 * 60, exit: 'EOD', stop: 'ATR1' },
      { trigger: 'EMA_X', dirFilter: 'DAILY_TREND', dayFilter: 'NARROW_CPR', lastEntryMin: 14 * 60, exit: 'R2', stop: 'PTS40' },
      { trigger: 'ST_FLIP', dirFilter: 'GAP_ALIGN', dayFilter: 'ALL', lastEntryMin: 14 * 60, exit: 'ST_FLIP', stop: 'ATR2' },
    ];
    for (const g of genomes) {
      const all = simulateIntraday(g, full);
      for (const t of all) {
        // cut the data right after the signal bar: the same entry must be decided
        const cutIndex = bars.findIndex((b) => b.t + M15 === t.entryTime) + 1;
        const part = simulateIntraday(g, prepareSeries(bars.slice(0, cutIndex), M15), t.date, `${t.date}~`)[0];
        expect(part).toBeDefined();
        expect([part.side, part.entry, part.stop, part.target, part.entryTime]).toEqual([t.side, t.entry, t.stop, t.target, t.entryTime]);
        expect(part.exitReason).toBe('OPEN'); // the outcome (label) is not known yet at decision time
      }
    }
  });
});
