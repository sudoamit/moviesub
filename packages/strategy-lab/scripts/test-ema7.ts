/** Backtests the 7 EMA strategy (video rules + variants) on Gold, NIFTY and 9 crypto markets. */
import * as fs from 'fs';
import { aggregateBars, computeMetrics, Ema7Params, INSTRUMENT_PROFILES, loadHistory, simulateEma7 } from '../src';
import { Bar } from '../src/types';

const DIR = '../../data/strategy-lab';
const markets: Array<{ sym: string; m15: Bar[]; h1: Bar[] }> = [];
for (const sym of ['XAUUSD', 'BTCUSDT_PERP', 'ETHUSDT_PERP', 'SOLUSDT_PERP', 'BNBUSDT_PERP', 'ADAUSDT_PERP', 'LINKUSDT_PERP', 'XRPUSDT_PERP', 'DOGEUSDT_PERP', 'AVAXUSDT_PERP']) {
  const m15 = loadHistory(DIR, sym);
  markets.push({ sym, m15, h1: aggregateBars(m15, 4, 15 * 60 * 1000) });
}
// NIFTY: 15m from Groww/Yahoo, session-aligned 1h from Yahoo
markets.push({ sym: 'NIFTY', m15: loadHistory(DIR, 'NIFTY'), h1: JSON.parse(fs.readFileSync(`${DIR}/NIFTY_1h.json`, 'utf8')) });

const VIDEO: Partial<Ema7Params> = { maxCrosses: 2, swingLookback: 5, stopMode: 'CLOSE', target: 'ADAPTIVE' };
const variants: Array<Partial<Ema7Params>> = [];
for (const maxCrosses of [2, 4]) for (const swingLookback of [3, 5, 10]) for (const stopMode of ['TOUCH', 'CLOSE'] as const)
  for (const target of ['ADAPTIVE', 2, 3, 4] as const) variants.push({ maxCrosses, swingLookback, stopMode, target });
const label = (v: Partial<Ema7Params>) => `crosses<=${v.maxCrosses} swing${v.swingLookback} ${v.stopMode} stop target ${v.target}`;

console.log('=== Video rules (chop <=2 crosses/20 bars, stop beyond 5-candle swing, close-based stop, adaptive 2-4R) ===');
for (const m of markets) {
  const tr = simulateEma7(m.m15, m.h1, INSTRUMENT_PROFILES[m.sym], VIDEO);
  const r = computeMetrics(tr);
  const years = (m.m15[m.m15.length - 1].t - m.m15[0].t) / (365.25 * 86400000);
  const cost = tr.reduce((a, t) => a + t.costR, 0) / Math.max(1, tr.length);
  console.log(`  ${m.sym.padEnd(14)} ${String(r.trades).padStart(5)} trades (${(r.trades / years).toFixed(0)}/yr) | win ${(r.winRate * 100).toFixed(0)}% | net ${r.expectancyR.toFixed(3)}R (gross ${(r.expectancyR + cost).toFixed(3)}R, cost ${cost.toFixed(3)}R) | total ${r.totalR.toFixed(0)}R | t ${r.tStat.toFixed(2)} | maxDD ${r.maxDrawdownR.toFixed(0)}R`);
}

// Best variant chosen on the first 60% of every market, checked on the last 40%
const score = (v: Partial<Ema7Params>, part: 'is' | 'oos') => {
  const rs: number[] = []; let pos = 0;
  for (const m of markets) {
    const split = Math.floor(m.m15.length * 0.6);
    const tr = simulateEma7(m.m15, m.h1, INSTRUMENT_PROFILES[m.sym], v, part === 'is' ? { from: 0, to: split } : { from: split, to: m.m15.length });
    const sum = tr.reduce((a, t) => a + t.netR, 0);
    if (sum > 0) pos++;
    rs.push(...tr.map((t) => t.netR));
  }
  return { m: computeMetrics(rs.map((netR) => ({ netR })) as any), pos };
};
const ranked = variants.map((v) => ({ v, is: score(v, 'is') })).sort((a, b) => b.is.m.expectancyR - a.is.m.expectancyR);
console.log(`\n=== ${variants.length} variants, ranked on IN-SAMPLE (first 60%, all ${markets.length} markets pooled) ===`);
for (const r of ranked.slice(0, 5)) console.log(`  ${label(r.v).padEnd(52)} IS ${r.is.m.trades} trades ${r.is.m.expectancyR.toFixed(3)}R t ${r.is.m.tStat.toFixed(2)} (+ on ${r.is.pos}/${markets.length})`);
const best = ranked[0];
const oos = score(best.v, 'oos');
console.log(`\nBest in-sample variant on the HOLD-OUT (last 40%): ${oos.m.trades} trades | ${oos.m.expectancyR.toFixed(3)}R/trade | t ${oos.m.tStat.toFixed(2)} | profitable on ${oos.pos}/${markets.length} markets`);
console.log(`Worst in-sample variant: ${label(ranked[ranked.length - 1].v)} ${ranked[ranked.length - 1].is.m.expectancyR.toFixed(3)}R`);
