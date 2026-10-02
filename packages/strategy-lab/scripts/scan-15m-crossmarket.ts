/**
 * Cross-market 15m scan: a strategy must be profitable on most crypto markets in-sample (first 60% of each
 * market) and then again out of sample (last 40%), pooled and per market, with a Bonferroni-adjusted bar.
 */
import * as fs from 'fs';
import { backtestGenome, computeFeatures, computeMetrics, describeGenome, enumerateGenomes, Features, INSTRUMENT_PROFILES, loadHistory, normalQuantile, StrategyGenome } from '../src';
import { Bar, InstrumentProfile } from '../src/types';

const DIR = '../../data/strategy-lab';
const MARKETS = ['BTCUSDT_PERP', 'ETHUSDT_PERP', 'SOLUSDT_PERP', 'BNBUSDT_PERP', 'ADAUSDT_PERP', 'LINKUSDT_PERP', 'XRPUSDT_PERP', 'DOGEUSDT_PERP', 'AVAXUSDT_PERP'];
const MIN_MARKETS = 6;
const genomes = enumerateGenomes({ entryModes: ['MARKET', 'LIMIT'], maxBars: [32], trailMaxBars: 192 });
const data: Array<{ sym: string; bars: Bar[]; f: Features; p: InstrumentProfile; split: number }> = MARKETS.map((sym) => {
  const bars = loadHistory(DIR, sym); const p = INSTRUMENT_PROFILES[sym];
  return { sym, bars, f: computeFeatures(bars, p), p, split: Math.floor(bars.length * 0.6) };
});
const started = Date.now();
type Eval = { g: StrategyGenome; isPos: number; isT: number; isTrades: number; isMean: number };
const survivors: Eval[] = [];
genomes.forEach((g, k) => {
  let pos = 0; const rs: number[] = [];
  for (const d of data) {
    const tr = backtestGenome(g, d.bars, d.f, d.p, { from: 0, to: d.split });
    const m = computeMetrics(tr);
    if (m.trades >= 30 && m.expectancyR > 0) pos++;
    for (const t of tr) rs.push(t.netR);
  }
  const m = computeMetrics(rs.map((r) => ({ netR: r })) as any);
  if (pos >= MIN_MARKETS && m.tStat >= 3) survivors.push({ g, isPos: pos, isT: m.tStat, isTrades: m.trades, isMean: m.expectancyR });
  if (k % 4000 === 0) console.log(`  screened ${k}/${genomes.length} (${((Date.now() - started) / 1000).toFixed(0)}s), survivors ${survivors.length}`);
});
const reqT = survivors.length ? normalQuantile(1 - 0.05 / survivors.length) : Infinity;
console.log(`\n${genomes.length} strategies x ${MARKETS.length} markets: ${survivors.length} survived the in-sample cross-market screen; hold-out bar t >= ${reqT.toFixed(2)}`);
const results = survivors.map((s) => {
  let pos = 0; const rs: number[] = []; const per: string[] = [];
  for (const d of data) {
    const tr = backtestGenome(s.g, d.bars, d.f, d.p, { from: d.split, to: d.bars.length });
    const m = computeMetrics(tr);
    if (m.expectancyR > 0) pos++;
    per.push(`${d.sym.replace('USDT_PERP', '')}:${m.expectancyR.toFixed(2)}`);
    for (const t of tr) rs.push(t.netR);
  }
  const m = computeMetrics(rs.map((r) => ({ netR: r })) as any);
  const years = (data[0].bars[data[0].bars.length - 1].t - data[0].bars[data[0].split].t) / (365.25 * 86400000);
  return { s, m, pos, per, passed: pos >= MIN_MARKETS && m.tStat >= reqT && m.expectancyR > 0.05, tradesPerYear: m.trades / years };
}).sort((a, b) => b.m.tStat - a.m.tStat);
for (const r of results.slice(0, 12)) {
  console.log(`${r.passed ? 'PASS ' : 'fail '} ${describeGenome(r.s.g)}\n       in-sample ${r.s.isTrades} trades ${r.s.isMean.toFixed(3)}R t ${r.s.isT.toFixed(2)} (+ on ${r.s.isPos}/9) | HOLD-OUT ${r.m.trades} trades (${r.tradesPerYear.toFixed(0)}/yr across markets) ${r.m.expectancyR.toFixed(3)}R/trade t ${r.m.tStat.toFixed(2)} (+ on ${r.pos}/9) | ${r.per.join(' ')}`);
}
fs.writeFileSync(`${DIR}/scan-15m-crossmarket.json`, JSON.stringify(results.map((r) => ({ genome: r.s.g, description: describeGenome(r.s.g), passed: r.passed, holdOut: r.m, positiveMarkets: r.pos, perMarket: r.per, inSample: { trades: r.s.isTrades, expectancyR: r.s.isMean, tStat: r.s.isT, positiveMarkets: r.s.isPos } })), null, 2));
console.log(`\nPASSED: ${results.filter((r) => r.passed).length} (${((Date.now() - started) / 60000).toFixed(1)} min)`);
