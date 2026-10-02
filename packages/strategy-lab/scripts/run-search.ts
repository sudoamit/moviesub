/**
 * Runs the strategy search on the cached history and writes data/strategy-lab/search-<SYMBOL>.json.
 * Usage: npx ts-node --transpile-only scripts/run-search.ts [SYMBOL ...]
 */
import * as fs from 'fs';
import * as path from 'path';
import { aggregateBars, enumerateGenomes, INSTRUMENT_PROFILES, searchStrategies } from '../src';
import { Bar } from '../src/types';

const DIR = path.resolve(__dirname, '../../../data/strategy-lab');
const fmt = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : String(x));

// Optional --tf=15m|1h|4h (aggregated from the 15m history)
const tfArg = process.argv.find((a) => a.startsWith('--tf='))?.slice(5) ?? '15m';
const factor = tfArg === '4h' ? 16 : tfArg === '1h' ? 4 : 1;
const symbols = process.argv.slice(2).filter((a) => !a.startsWith('--')).length
  ? process.argv.slice(2).filter((a) => !a.startsWith('--'))
  : Object.keys(INSTRUMENT_PROFILES);
// Optional --modes=market|limit|both (default both)
const modesArg = process.argv.find((a) => a.startsWith('--modes='))?.slice(8) ?? 'both';
const entryModes: Array<'MARKET' | 'LIMIT'> = modesArg === 'market' ? ['MARKET'] : modesArg === 'limit' ? ['LIMIT'] : ['MARKET', 'LIMIT'];
const genomes = enumerateGenomes({ entryModes });
for (const sym of symbols) {
  const file = path.join(DIR, `${sym}_15m.json`);
  if (!fs.existsSync(file)) { console.log(`${sym}: no history file`); continue; }
  const raw: Bar[] = JSON.parse(fs.readFileSync(file, 'utf8'));
  const base = INSTRUMENT_PROFILES[sym];
  const bars = factor > 1 ? aggregateBars(raw, factor, base.barMs) : raw;
  const profile = { ...base, barMs: base.barMs * factor };
  const started = Date.now();
  const res = searchStrategies(bars, profile, { genomes });
  fs.writeFileSync(path.join(DIR, `search-${sym}-${tfArg}.json`), JSON.stringify(res, null, 2));
  const d = (t: number) => new Date(t).toISOString().slice(0, 10);
  console.log(`\n=== ${sym} ${tfArg}: ${res.bars} bars ${d(res.fromTime)}..${d(res.toTime)} (hold-out from ${d(res.splitTime)}), ` +
    `${res.genomesTested} strategies, ${res.screenSurvivors} survived screen, ${res.passed.length} PASSED (${((Date.now() - started) / 1000).toFixed(0)}s)`);
  for (const s of res.passed.slice(0, 10)) {
    const o = s.outOfSample!;
    console.log(`  PASS ${s.description}\n       hold-out: ${o.trades} trades, win ${fmt(o.winRate * 100, 0)}%, ${fmt(o.expectancyR, 3)}R/trade, PF ${fmt(o.profitFactor)}, t ${fmt(o.tStat)} (need ${fmt(s.requiredOutOfSampleTStat ?? 0)}), maxDD ${fmt(o.maxDrawdownR, 1)}R | in-sample ${s.inSample.trades} trades ${fmt(s.inSample.expectancyR, 3)}R`);
  }
  for (const s of res.passed.slice(0, 10)) {
    if (s.regimeExpectancy) console.log(`       bull ${s.regimeExpectancy.bull.trades} trades ${fmt(s.regimeExpectancy.bull.expectancyR, 3)}R | bear ${s.regimeExpectancy.bear.trades} trades ${fmt(s.regimeExpectancy.bear.expectancyR, 3)}R | random-entry 95th pct ${fmt(s.baselineThresholdR ?? NaN, 3)}R`);
  }
  const reasons: Record<string, number> = {};
  for (const s of res.nearMisses) { const k = (s.rejectionReason || '').replace(/[-0-9.]+R?/g, '#'); reasons[k] = (reasons[k] ?? 0) + 1; }
  for (const s of res.nearMisses.slice(0, 3)) {
    const o = s.outOfSample!;
    console.log(`  near-miss ${s.description}: ${s.rejectionReason} (hold-out ${o.trades} trades, ${fmt(o.expectancyR, 3)}R)`);
  }
}
