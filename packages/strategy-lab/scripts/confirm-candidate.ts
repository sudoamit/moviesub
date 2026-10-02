/**
 * Out-of-market confirmation: evaluates one pre-specified genome on several instruments over their FULL
 * history (no selection on them), with bull/bear split and a random-entry baseline.
 */
import * as fs from 'fs';
import * as path from 'path';
import { aggregateBars, backtestGenome, computeFeatures, computeMetrics, DEFAULT_CRITERIA, INSTRUMENT_PROFILES, randomEntryBaseline, StrategyGenome } from '../src';

const DIR = path.resolve(__dirname, '../../../data/strategy-lab');
const candidates: Array<{ name: string; tf: '1h' | '4h'; genome: StrategyGenome }> = [
  { name: 'BTC 4h: 20-bar breakout, both sides, trend + displacement, trailing 2.5 ATR', tf: '4h',
    genome: { trigger: 'BREAKOUT_20', sides: 'BOTH', filters: ['HTF_TREND', 'STRUCTURE_TREND', 'RECENT_DISPLACEMENT'], stop: { type: 'ATR', atrMult: 2.5 }, rewardRisk: 0, maxBarsInTrade: 160, entryMode: 'LIMIT', exit: 'TRAIL' } },
  { name: 'Same 4h trend breakout with MARKET entries (what the live engine can do today)', tf: '4h',
    genome: { trigger: 'BREAKOUT_20', sides: 'BOTH', filters: ['HTF_TREND', 'STRUCTURE_TREND', 'RECENT_DISPLACEMENT'], stop: { type: 'ATR', atrMult: 2.5 }, rewardRisk: 0, maxBarsInTrade: 160, entryMode: 'MARKET', exit: 'TRAIL' } },
  { name: 'BTC 1h: 20-bar breakout, long, trend + displacement, 3R target', tf: '1h',
    genome: { trigger: 'BREAKOUT_20', sides: 'LONG', filters: ['HTF_TREND', 'RECENT_DISPLACEMENT'], stop: { type: 'ATR', atrMult: 2.5 }, rewardRisk: 3, maxBarsInTrade: 32, entryMode: 'LIMIT', exit: 'FIXED' } },
];
for (const c of candidates) {
  console.log(`\n### ${c.name}`);
  for (const sym of ['BTCUSDT_PERP', 'ETHUSDT_PERP', 'XAUUSD']) {
    const raw = JSON.parse(fs.readFileSync(path.join(DIR, `${sym}_15m.json`), 'utf8'));
    const base = INSTRUMENT_PROFILES[sym];
    const factor = c.tf === '4h' ? 16 : 4;
    const bars = aggregateBars(raw, factor, base.barMs);
    const p = { ...base, barMs: base.barMs * factor };
    const f = computeFeatures(bars, p);
    const trades = backtestGenome(c.genome, bars, f, p);
    const m = computeMetrics(trades);
    const lookback = Math.round((90 * 86_400_000) / p.barMs);
    const reg = { bull: [] as number[], bear: [] as number[] };
    for (const t of trades) (t.signalIndex >= lookback && bars[t.signalIndex].c > bars[t.signalIndex - lookback].c ? reg.bull : reg.bear).push(t.netR);
    const ex = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
    const base95 = randomEntryBaseline(c.genome, bars, f, p, 0, { ...DEFAULT_CRITERIA, baselineRuns: 200 });
    const years = new Map<number, number>();
    for (const t of trades) { const y = new Date(bars[t.signalIndex].t).getUTCFullYear(); years.set(y, (years.get(y) ?? 0) + t.netR); }
    console.log(`  ${sym.padEnd(13)} ${m.trades} trades | ${m.expectancyR.toFixed(3)}R/trade | t ${m.tStat.toFixed(2)} | PF ${m.profitFactor.toFixed(2)} | maxDD ${m.maxDrawdownR.toFixed(1)}R | bull ${reg.bull.length}@${ex(reg.bull).toFixed(3)}R bear ${reg.bear.length}@${ex(reg.bear).toFixed(3)}R | random 95th ${base95.toFixed(3)}R ${m.expectancyR > base95 ? 'BEATS' : 'does not beat'}`);
    console.log(`    by year (R): ${[...years.entries()].map(([y, r]) => `${y}:${r.toFixed(1)}`).join('  ')}`);
  }
}
