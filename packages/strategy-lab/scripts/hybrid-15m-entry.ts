/**
 * Hybrid test: 1h breakout signals (S2), entries timed on 15m bars.
 * Baseline = market entry right after the 1h signal. Pullback = market entry when price touches
 * signalClose - k x ATR(1h) within N 15m bars (else the signal is skipped).
 * Exits on 15m bars: stop first, then target; time limit 32 hours; all fills taker + slippage (live engine).
 */
import { aggregateBars, backtestGenome, computeFeatures, computeMetrics, INSTRUMENT_PROFILES, loadHistory, StrategyGenome } from '../src';

const DIR = '../../data/strategy-lab';
const MARKETS = ['BTCUSDT_PERP', 'ETHUSDT_PERP', 'SOLUSDT_PERP', 'BNBUSDT_PERP', 'ADAUSDT_PERP', 'LINKUSDT_PERP', 'XRPUSDT_PERP', 'DOGEUSDT_PERP', 'AVAXUSDT_PERP'];
const S2: StrategyGenome = { trigger: 'BREAKOUT_20', sides: 'LONG', filters: ['HTF_TREND', 'RECENT_DISPLACEMENT'], stop: { type: 'ATR', atrMult: 2.5 }, rewardRisk: 3, maxBarsInTrade: 32, entryMode: 'MARKET', exit: 'FIXED' };
type Variant = { name: string; k: number; n: number; rebase: boolean };
const VARIANTS: Variant[] = [{ name: 'baseline (market at signal)', k: 0, n: 1, rebase: false }];
for (const k of [0.25, 0.5, 0.75]) for (const n of [4, 8]) for (const rebase of [false, true]) VARIANTS.push({ name: `pullback ${k}xATR within ${n} bars, ${rebase ? 're-based 3R' : 'same levels'}`, k, n, rebase });
const M15 = 900_000, H1 = 3_600_000;

type Res = Record<string, { is: number[]; oos: number[]; signals: { is: number; oos: number } }>;
const perMarket: Record<string, Res> = {};
for (const sym of MARKETS) {
  const m15 = loadHistory(DIR, sym);
  const base = INSTRUMENT_PROFILES[sym];
  const side = base.takerFeeRate + base.slippageRate;
  const h1 = aggregateBars(m15, 4, base.barMs);
  const p1 = { ...base, barMs: H1 };
  const f1 = computeFeatures(h1, p1);
  const idx15 = new Map(m15.map((b, i) => [b.t, i]));
  const splitT = h1[Math.floor(h1.length * 0.6)].t;
  // Signals from the unchanged 1h strategy (each trade's signal bar; one position at a time as in the backtest)
  const signals = backtestGenome(S2, h1, f1, p1).map((t) => ({ i: t.signalIndex, stop: t.stop }));
  const res: Res = {};
  for (const v of VARIANTS) res[v.name] = { is: [], oos: [], signals: { is: 0, oos: 0 } };
  for (const s of signals) {
    const sigBar = h1[s.i];
    const T = sigBar.t + H1; // signal decided at the 1h close
    const j0 = idx15.get(T);
    if (j0 === undefined) continue;
    const atr = f1.atr[s.i];
    const baseEntry = m15[j0].o;
    const baseRisk = baseEntry - s.stop;
    if (!(baseRisk > 0)) continue;
    const baseTarget = baseEntry + 3 * baseRisk;
    const bucket = sigBar.t < splitT ? 'is' : 'oos';
    for (const v of VARIANTS) {
      res[v.name].signals[bucket]++;
      let entryIdx = -1, entry = 0;
      if (v.k === 0) { entryIdx = j0; entry = baseEntry; }
      else {
        const level = sigBar.c - v.k * atr;
        for (let j = j0; j < Math.min(j0 + v.n, m15.length); j++) {
          if (m15[j].l <= level) { entryIdx = j; entry = Math.min(level, m15[j].o); break; }
        }
        if (entryIdx === -1 || entry <= s.stop) continue; // no pullback (skipped) or already through the stop
      }
      const risk = entry - s.stop;
      const target = v.rebase || v.k === 0 ? entry + 3 * risk : baseTarget;
      let exit = m15[Math.min(entryIdx + 128, m15.length) - 1].c;
      for (let j = entryIdx; j < Math.min(entryIdx + 128, m15.length); j++) {
        const b = m15[j];
        if (b.l <= s.stop) { exit = j === entryIdx && v.k > 0 ? s.stop : Math.min(s.stop, b.o); break; }
        if (j > entryIdx || v.k === 0) { if (b.h >= target) { exit = target; break; } }
      }
      // R measured against the BASELINE risk so variants are comparable in money terms per signal
      const netR = ((exit - entry) - (entry + exit) * side) / baseRisk;
      res[v.name][bucket].push(netR);
    }
  }
  perMarket[sym] = res;
}

const summarize = (bucket: 'is' | 'oos') => {
  console.log(`\n=== ${bucket === 'is' ? 'IN-SAMPLE (first 60%) - used to choose' : 'HOLD-OUT (last 40%) - confirmation'} ===`);
  const rows = VARIANTS.map((v) => {
    const all: number[] = []; let pos = 0, signals = 0, fills = 0;
    for (const sym of MARKETS) {
      const r = perMarket[sym][v.name];
      all.push(...r[bucket]); signals += r.signals[bucket]; fills += r[bucket].length;
      if (r[bucket].reduce((a, x) => a + x, 0) > 0) pos++;
    }
    const m = computeMetrics(all.map((netR) => ({ netR })) as any);
    // R per SIGNAL (skipped signals count as 0) = what the strategy earns per opportunity
    return { v, perSignal: m.totalR / Math.max(1, signals), m, pos, fillRate: fills / Math.max(1, signals) };
  });
  rows.sort((a, b) => b.perSignal - a.perSignal);
  for (const r of rows) console.log(`  ${r.v.name.padEnd(46)} | fill ${(r.fillRate * 100).toFixed(0).padStart(3)}% | ${r.m.expectancyR.toFixed(3)}R/trade | ${r.perSignal.toFixed(3)}R/signal | total ${r.m.totalR.toFixed(0)}R | t ${r.m.tStat.toFixed(2)} | + on ${r.pos}/9 | maxDD ${r.m.maxDrawdownR.toFixed(0)}R`);
  return rows;
};
const isRows = summarize('is');
const oosRows = summarize('oos');
const chosen = isRows[0].v.name;
const base = oosRows.find((r) => r.v.k === 0)!;
const pick = oosRows.find((r) => r.v.name === chosen)!;
console.log(`\nChosen on in-sample: "${chosen}". Hold-out: ${pick.perSignal.toFixed(3)}R/signal vs baseline ${base.perSignal.toFixed(3)}R/signal (${pick.pos}/9 vs ${base.pos}/9 markets positive).`);
