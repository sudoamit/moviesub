import { backtestGenome } from '../backtest';
import { computeFeatures } from '../primitives';
import { exitRulesOf, ExitRules, openPosition, stepBar, tradeResult, PositionState, liquidityOf } from '../trade-engine';
import { Bar, InstrumentProfile, StrategyGenome } from '../types';

const FIXED: ExitRules = { exit: 'FIXED', rewardRisk: 2, trailAtrMult: 2, maxBarsInTrade: 10 };
const TRAIL: ExitRules = { exit: 'TRAIL', rewardRisk: 0, trailAtrMult: 2, maxBarsInTrade: 10 };
const bar = (o: number, h: number, l: number, c: number) => ({ o, h, l, c });
const profile: InstrumentProfile = { symbol: 'TEST', makerFeeRate: 0.0002, takerFeeRate: 0.0005, slippageRate: 0.0001, barMs: 3_600_000, killzones: [] };

/** Runs bars through the engine until an exit (the way the shadow runner does, one bar at a time). */
function run(p: PositionState, bars: Array<{ o: number; h: number; l: number; c: number }>, rules: ExitRules, atr = 1, limitFill = false) {
  let s = p;
  for (let k = 0; k < bars.length; k++) {
    const r = stepBar(s, bars[k], atr, rules, { limitFillBar: limitFill && k === 0 });
    s = r.state;
    if (r.exit) return { ...r.exit, bar: k, state: s };
  }
  return { price: NaN, reason: 'OPEN', bar: -1, state: s };
}

describe('canonical trade engine', () => {
  it('long stop: exits at the stop', () => {
    const r = run(openPosition('LONG', 100, 95, FIXED), [bar(100, 102, 98, 101), bar(101, 101, 94, 96)], FIXED);
    expect(r).toMatchObject({ reason: 'STOP', price: 95, bar: 1 });
  });

  it('short stop: exits at the stop', () => {
    const r = run(openPosition('SHORT', 100, 105, FIXED), [bar(100, 106, 99, 104)], FIXED);
    expect(r).toMatchObject({ reason: 'STOP', price: 105, bar: 0 });
  });

  it('gap through the stop fills at the (worse) open, long and short', () => {
    expect(run(openPosition('LONG', 100, 95, FIXED), [bar(100, 101, 99, 100), bar(92, 93, 90, 91)], FIXED)).toMatchObject({ reason: 'STOP', price: 92 });
    expect(run(openPosition('SHORT', 100, 105, FIXED), [bar(108, 110, 107, 109)], FIXED)).toMatchObject({ reason: 'STOP', price: 108 });
  });

  it('target: exits at the target price (never better, even on a gap)', () => {
    const p = openPosition('LONG', 100, 95, FIXED);
    expect(p.target).toBe(110);
    expect(run(p, [bar(100, 104, 99, 103), bar(115, 116, 114, 115)], FIXED)).toMatchObject({ reason: 'TARGET', price: 110, bar: 1 });
    expect(openPosition('SHORT', 100, 105, FIXED).target).toBe(90);
  });

  it('timeout: exits at the close of the bar that reaches maxBarsInTrade', () => {
    const rules = { ...FIXED, maxBarsInTrade: 3 };
    const r = run(openPosition('LONG', 100, 95, rules), [bar(100, 101, 99, 100), bar(100, 101, 99, 100.5), bar(100, 102, 99, 101.5), bar(101, 103, 100, 102)], rules);
    expect(r).toMatchObject({ reason: 'TIMEOUT', price: 101.5, bar: 2 });
    expect(r.state.barsHeld).toBe(3);
  });

  it('trailing stop follows the best close and applies from the NEXT bar; no target', () => {
    const p = openPosition('LONG', 100, 95, TRAIL);
    expect(p.target).toBeNull();
    // bar 0 closes at 110 -> trail 108 (ATR 1 x 2) applies from bar 1; bar 1 low 107.5 hits it
    const r = run(p, [bar(100, 111, 99, 110), bar(110, 112, 107.5, 108)], TRAIL);
    expect(r).toMatchObject({ reason: 'STOP', price: 108, bar: 1 });
    // a bar that dips to 107 only on the bar that set the new high does not stop it out (stop was still 95)
    const same = stepBar(p, bar(100, 111, 96, 110), 1, TRAIL);
    expect(same.exit).toBeNull();
    expect(same.state.currentStop).toBe(108);
  });

  it('OHLC ambiguity: a bar touching both stop and target is a STOP (worst case)', () => {
    expect(run(openPosition('LONG', 100, 95, FIXED), [bar(100, 111, 94, 105)], FIXED)).toMatchObject({ reason: 'STOP', price: 95 });
    expect(run(openPosition('SHORT', 100, 105, FIXED), [bar(100, 106, 89, 95)], FIXED)).toMatchObject({ reason: 'STOP', price: 105 });
  });

  it('entry bar: MARKET fill bar checks stop and target; LIMIT fill bar has no gap and never takes the target', () => {
    // market fill at the open: a target reached in the same bar counts
    expect(run(openPosition('LONG', 100, 95, FIXED), [bar(100, 111, 99, 108)], FIXED)).toMatchObject({ reason: 'TARGET', bar: 0 });
    // limit fill inside the bar: target ignored on that bar
    expect(run(openPosition('LONG', 100, 95, FIXED), [bar(101, 111, 99, 108)], FIXED, 1, true).reason).toBe('OPEN');
    // limit fill bar that also falls through the stop exits at the stop, not at a "gap" open
    expect(run(openPosition('LONG', 100, 95, FIXED), [bar(90, 101, 89, 92)], FIXED, 1, true)).toMatchObject({ reason: 'STOP', price: 95 });
  });

  it('canonical costs: taker = fee + slippage per side, maker = fee; R uses the initial risk', () => {
    const r = tradeResult('LONG', 100, 95, 110, profile, 'TAKER', 'TAKER');
    expect(r.entryCostPerUnit).toBeCloseTo(100 * 0.0006, 12);
    expect(r.exitCostPerUnit).toBeCloseTo(110 * 0.0006, 12);
    expect(r.grossR).toBeCloseTo(2, 12);
    expect(r.costR).toBeCloseTo((0.06 + 0.066) / 5, 12);
    expect(r.netR).toBeCloseTo(2 - 0.0252, 12);
    expect(tradeResult('SHORT', 100, 105, 90, profile, 'MAKER', 'MAKER').costR).toBeCloseTo((0.02 + 0.018) / 5, 12);
    expect(liquidityOf('LIMIT', 'TARGET')).toEqual({ entry: 'MAKER', exit: 'MAKER' });
    expect(liquidityOf('LIMIT', 'STOP')).toEqual({ entry: 'MAKER', exit: 'TAKER' });
    expect(liquidityOf('MARKET', 'TARGET')).toEqual({ entry: 'TAKER', exit: 'TAKER' });
    expect(() => tradeResult('LONG', 100, 100, 101, profile, 'TAKER', 'TAKER')).toThrow(/risk must be positive/);
  });
});

describe('backtest and shadow stepping are the same lifecycle', () => {
  // Deterministic random walk with occasional gaps
  const walk = (n: number, seed: number): Bar[] => {
    let s = seed >>> 0;
    const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
    const out: Bar[] = [];
    let p = 50_000;
    for (let i = 0; i < n; i++) {
      const o = rnd() < 0.03 ? p * (1 + (rnd() - 0.5) * 0.03) : p;
      const c = o * (1 + (rnd() - 0.48) * 0.02);
      out.push({ t: i * 3_600_000, o, h: Math.max(o, c) * (1 + rnd() * 0.006), l: Math.min(o, c) * (1 - rnd() * 0.006), c, v: 1 });
      p = c;
    }
    return out;
  };
  const genomes: StrategyGenome[] = [
    { trigger: 'BREAKOUT_20', sides: 'BOTH', filters: [], stop: { type: 'ATR', atrMult: 2 }, rewardRisk: 2, maxBarsInTrade: 24, entryMode: 'MARKET', exit: 'FIXED' },
    { trigger: 'BREAKOUT_20', sides: 'BOTH', filters: [], stop: { type: 'ATR', atrMult: 2.5 }, rewardRisk: 0, maxBarsInTrade: 160, entryMode: 'MARKET', exit: 'TRAIL' },
    { trigger: 'EMA_CROSS', sides: 'BOTH', filters: [], stop: { type: 'ATR', atrMult: 1.5 }, rewardRisk: 3, maxBarsInTrade: 32, entryMode: 'LIMIT', exit: 'FIXED' },
  ];

  it.each(genomes.map((g) => [`${g.trigger} ${g.exit} ${g.entryMode}`, g] as const))('%s: identical exits, prices and net R', (_name, g) => {
    const bars = walk(4000, 17);
    const f = computeFeatures(bars, profile);
    const trades = backtestGenome(g, bars, f, profile);
    expect(trades.length).toBeGreaterThan(20);
    expect(new Set(trades.map((t) => t.side)).size).toBe(2); // longs and shorts
    const rules = exitRulesOf(g);
    for (const bt of trades) {
      let s = openPosition(bt.side, bt.entry, bt.stop, rules);
      let exit: { price: number; reason: string } | null = null, k = bt.entryIndex;
      for (; k < bars.length && !exit; k++) {
        const r = stepBar(s, bars[k], f.atr[k], rules, { limitFillBar: g.entryMode === 'LIMIT' && k === bt.entryIndex });
        s = r.state;
        exit = r.exit;
      }
      if (bt.exitReason === 'END_OF_DATA') { expect(exit).toBeNull(); continue; }
      expect(exit!.reason).toBe(bt.exitReason);
      expect(exit!.price).toBeCloseTo(bt.exit, 9);
      expect(k - 1).toBe(bt.exitIndex);
      const liq = liquidityOf(g.entryMode ?? 'MARKET', bt.exitReason);
      expect(tradeResult(bt.side, bt.entry, bt.stop, exit!.price, profile, liq.entry, liq.exit).netR).toBeCloseTo(bt.netR, 9);
    }
  });

  it('end of data: a position still open after the last bar exits at the last close (END_OF_DATA)', () => {
    const bars = walk(600, 3);
    const g = { ...genomes[1], maxBarsInTrade: 100_000 };
    const f = computeFeatures(bars, profile);
    const trades = backtestGenome(g, bars, f, profile);
    const last = trades[trades.length - 1];
    if (last.exitReason === 'END_OF_DATA') {
      expect(last.exitIndex).toBe(bars.length - 1);
      expect(last.exit).toBe(bars[bars.length - 1].c);
    } else {
      // force the case: cut the data inside the last trade
      const cut = bars.slice(0, last.exitIndex);
      const t2 = backtestGenome(g, cut, computeFeatures(cut, profile), profile);
      const l2 = t2[t2.length - 1];
      expect(l2.exitReason).toBe('END_OF_DATA');
      expect(l2.exit).toBe(cut[cut.length - 1].c);
    }
  });
});
