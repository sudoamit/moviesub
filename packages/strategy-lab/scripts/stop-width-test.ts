/** Effect of tighter stops on the portfolio strategies (S1 4h trend trailing, S2 1h breakout 3R) across 9 markets. */
import { aggregateBars, backtestGenome, computeFeatures, computeMetrics, INSTRUMENT_PROFILES, loadHistory, StrategyGenome } from '../src';
const DIR = '../../data/strategy-lab';
const MARKETS = ['BTCUSDT_PERP', 'ETHUSDT_PERP', 'SOLUSDT_PERP', 'BNBUSDT_PERP', 'ADAUSDT_PERP', 'LINKUSDT_PERP', 'XRPUSDT_PERP', 'DOGEUSDT_PERP', 'AVAXUSDT_PERP'];
const S1 = (m: number): StrategyGenome => ({ trigger: 'BREAKOUT_20', sides: 'BOTH', filters: ['HTF_TREND', 'STRUCTURE_TREND', 'RECENT_DISPLACEMENT'], stop: { type: 'ATR', atrMult: m }, rewardRisk: 0, maxBarsInTrade: 160, entryMode: 'MARKET', exit: 'TRAIL' });
const S2 = (m: number): StrategyGenome => ({ trigger: 'BREAKOUT_20', sides: 'LONG', filters: ['HTF_TREND', 'RECENT_DISPLACEMENT'], stop: { type: 'ATR', atrMult: m }, rewardRisk: 3, maxBarsInTrade: 32, entryMode: 'MARKET', exit: 'FIXED' });
const prepared = new Map<string, any>();
const prep = (sym: string, factor: number) => {
  const k = `${sym}:${factor}`;
  if (!prepared.has(k)) { const base = INSTRUMENT_PROFILES[sym]; const bars = aggregateBars(loadHistory(DIR, sym), factor, base.barMs); const p = { ...base, barMs: base.barMs * factor }; prepared.set(k, { bars, p, f: computeFeatures(bars, p) }); }
  return prepared.get(k);
};
for (const [name, make, factor] of [['S1 4h trend (long/short, trailing)', S1, 16], ['S2 1h breakout (long, 3R)', S2, 4]] as const) {
  console.log(`\n${name}`);
  for (const mult of [1, 1.5, 2, 2.5]) {
    const all: number[] = []; const oos: number[] = []; const stops: number[] = []; let pos = 0, posOos = 0;
    for (const sym of MARKETS) {
      const { bars, p, f } = prep(sym, factor);
      const tr = backtestGenome(make(mult), bars, f, p);
      const split = Math.floor(bars.length * 0.6);
      const sum = tr.reduce((a, t) => a + t.netR, 0); if (sum > 0) pos++;
      const o = tr.filter((t) => t.signalIndex >= split); if (o.reduce((a, t) => a + t.netR, 0) > 0) posOos++;
      all.push(...tr.map((t) => t.netR)); oos.push(...o.map((t) => t.netR));
      stops.push(...tr.map((t) => Math.abs(t.entry - t.stop) / t.entry));
    }
    stops.sort((a, b) => a - b);
    const m = computeMetrics(all.map((netR) => ({ netR })) as any), mo = computeMetrics(oos.map((netR) => ({ netR })) as any);
    console.log(`  stop ${String(mult).padEnd(3)}x ATR (median ${(stops[Math.floor(stops.length / 2)] * 100).toFixed(1)}% of price) | ${m.trades} trades | win ${(m.winRate * 100).toFixed(0)}% | ${m.expectancyR.toFixed(3)}R/trade t ${m.tStat.toFixed(2)} (+ on ${pos}/9) | hold-out ${mo.expectancyR.toFixed(3)}R t ${mo.tStat.toFixed(2)} (+ on ${posOos}/9)`);
  }
}
