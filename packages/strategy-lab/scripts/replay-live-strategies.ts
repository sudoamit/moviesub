/**
 * Replays the LIVE bot strategies (production SignalGenerator: SMC and SAIYAN_OCC) bar by bar over cached
 * history with the live bot rules, gates and exit ladder, and reports the result in R.
 * Usage: npx ts-node --transpile-only scripts/replay-live-strategies.ts <SYMBOL> <SMC|SAIYAN_OCC> [days=730] [stride=1]
 */
import * as fs from 'fs';
import * as path from 'path';
import { aggregateBars, computeMetrics, INSTRUMENT_PROFILES } from '../src';
import { Bar, SimulatedTrade } from '../src/types';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { SignalGenerator } = require('../../trading-engine/dist');

const [sym = 'BTCUSDT_PERP', strategy = 'SMC', daysArg = '730'] = process.argv.slice(2);
const MIN_SCORE = strategy === 'SMC' ? 80 : 75;
const LEVERAGE = 50;
const MMR = 0.004;
const profile = INSTRUMENT_PROFILES[sym];
const MARKET_SIDE = profile.takerFeeRate + profile.slippageRate;
const M15 = 15 * 60 * 1000;

const all: Bar[] = JSON.parse(fs.readFileSync(path.resolve(__dirname, `../../../data/strategy-lab/${sym}_15m.json`), 'utf8'));
const days = Number(daysArg);
const startT = all[all.length - 1].t - days * 86_400_000;
const firstIdx = Math.max(400 * 16, all.findIndex((b) => b.t >= startT));
const h1 = aggregateBars(all, 4, M15);
const h4 = aggregateBars(all, 16, M15);
const toCandle = (b: Bar, ms: number) => ({ timestamp: new Date(b.t), open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v, isClosed: true, _ms: ms });

// Index helpers: last HTF bar fully closed at decision time
let h1Ptr = 0, h4Ptr = 0;
const trades: (SimulatedTrade & { score: number })[] = [];
const rejections: Record<string, number> = {};
const reject = (k: string) => { rejections[k] = (rejections[k] ?? 0) + 1; };
let busyUntil = -1;
const usedSignals = new Set<string>();
const started = Date.now();

for (let i = firstIdx; i < all.length - 1; i++) {
  const decisionT = all[i].t + M15; // close of bar i
  while (h1Ptr < h1.length && h1[h1Ptr].t + 4 * M15 <= decisionT) h1Ptr++;
  while (h4Ptr < h4.length && h4[h4Ptr].t + 16 * M15 <= decisionT) h4Ptr++;
  if (i <= busyUntil) continue;

  const exec = all.slice(i - 199, i + 1).map((b) => toCandle(b, M15));
  const htf1 = h1.slice(Math.max(0, h1Ptr - 150), h1Ptr).map((b) => toCandle(b, 4 * M15));
  const htf2 = h4.slice(Math.max(0, h4Ptr - 100), h4Ptr).map((b) => toCandle(b, 16 * M15));
  let sig: any;
  try {
    sig = SignalGenerator.generateSignal({
      symbol: sym, executionCandles: exec, executionTimeframe: '15m',
      htf1Candles: htf1, htf1Timeframe: '1h', htf2Candles: htf2, htf2Timeframe: '4h',
      strategyMode: strategy, asOfTimestamp: new Date(decisionT),
    });
  } catch { reject('generator_error'); continue; }

  if (!sig || sig.direction === 'NEUTRAL' || sig.grade === 'NO_TRADE' || sig.state !== 'ACTIVE') continue;
  if (sig.score < MIN_SCORE) { reject('score'); continue; }
  const sigT = typeof sig.canonicalCandleTime === 'number' ? sig.canonicalCandleTime : new Date(sig.canonicalDecisionTime).getTime();
  if (decisionT - sigT > M15) { reject('stale'); continue; }
  const key = `${sig.direction}|${sigT}`;
  if (usedSignals.has(key)) continue;
  if (strategy === 'SMC') {
    const ev = sig.triggerEvidence || {};
    if (!['orderBlock', 'fvg', 'liquiditySweep', 'structureBreak'].some((k) => ev[k]?.matched)) { reject('no_confluence'); continue; }
  }
  usedSignals.add(key);

  const isLong = sig.direction === 'BULLISH';
  const plannedEntry = sig.entryZone.optimal, stop = sig.stopLoss;
  const tp1 = sig.takeProfits.tp1, tp2 = sig.takeProfits.tp2, tp3 = sig.takeProfits.tp3;
  const entryIndex = i + 1;
  const entry = all[entryIndex].o; // market fill at next open
  const risk = isLong ? entry - stop : stop - entry;
  if (!(risk > 0)) { reject('beyond_stop'); continue; }
  // Chase rule: TP1 must keep half the planned R unless still inside the entry zone
  const plannedRr = Math.abs(tp1 - plannedEntry) / Math.abs(plannedEntry - stop);
  const reward = isLong ? tp1 - entry : entry - tp1;
  const inZone = entry >= sig.entryZone.min && entry <= sig.entryZone.max;
  if (reward <= 0 || (!inZone && reward / risk < plannedRr * 0.5)) { reject('entry_missed'); continue; }
  if ((entry * 2 * MARKET_SIDE) / risk > 0.5) { reject('cost_exceeds_edge'); continue; }
  const liq = isLong ? entry * (1 - 1 / LEVERAGE + MMR) : entry * (1 + 1 / LEVERAGE - MMR);
  if (isLong ? stop <= liq : stop >= liq) { reject('stop_beyond_liquidation'); continue; }

  // Live exit ladder: 30% TP1 (+stop to fee-adjusted breakeven), 30% TP2, 40% TP3; stop first on ambiguous bars.
  const feeBe = entry * 2 * MARKET_SIDE;
  let curStop = stop, remaining = 1, pnlR = 0, costR = entry * MARKET_SIDE / risk, stage = 0;
  let exitIndex = all.length - 1, exitReason: SimulatedTrade['exitReason'] = 'END_OF_DATA', lastExit = all[all.length - 1].c;
  const leg = (frac: number, px: number) => {
    pnlR += frac * ((isLong ? px - entry : entry - px) / risk);
    costR += frac * (px * MARKET_SIDE) / risk;
    remaining -= frac;
  };
  for (let j = entryIndex; j < all.length; j++) {
    const b = all[j];
    if (isLong ? b.l <= curStop : b.h >= curStop) {
      const px = isLong ? Math.min(curStop, j === entryIndex ? curStop : b.o) : Math.max(curStop, j === entryIndex ? curStop : b.o);
      leg(remaining, px); exitIndex = j; exitReason = 'STOP'; lastExit = px; break;
    }
    const hit = (lvl: number) => (isLong ? b.h >= lvl : b.l <= lvl);
    if (stage === 0 && hit(tp1)) { leg(0.3, tp1); stage = 1; curStop = isLong ? entry + feeBe : entry - feeBe; }
    if (stage === 1 && hit(tp2)) { leg(0.3, tp2); stage = 2; }
    if (stage === 2 && hit(tp3)) { leg(remaining, tp3); exitIndex = j; exitReason = 'TARGET'; lastExit = tp3; break; }
  }
  if (remaining > 1e-9) leg(remaining, lastExit);
  trades.push({ side: isLong ? 'LONG' : 'SHORT', signalIndex: i, entryIndex, exitIndex, entry, stop, target: tp1, exit: lastExit, exitReason, netR: pnlR - costR, costR, score: sig.score });
  busyUntil = exitIndex;
}

const m = computeMetrics(trades);
const d = (t: number) => new Date(t).toISOString().slice(0, 10);
const half = Math.floor(trades.length / 2);
const h1R = trades.slice(0, half).reduce((a, t) => a + t.netR, 0), h2R = trades.slice(half).reduce((a, t) => a + t.netR, 0);
const avgCost = trades.length ? trades.reduce((a, t) => a + t.costR, 0) / trades.length : 0;
console.log(`${sym} ${strategy} live replay ${d(all[firstIdx].t)}..${d(all[all.length - 1].t)} (${((Date.now() - started) / 1000).toFixed(0)}s)`);
console.log(`  trades ${m.trades} | win ${(m.winRate * 100).toFixed(0)}% | net ${m.expectancyR.toFixed(3)}R/trade (gross ${(m.expectancyR + avgCost).toFixed(3)}R, costs ${avgCost.toFixed(3)}R) | total ${m.totalR.toFixed(1)}R | PF ${m.profitFactor.toFixed(2)} | t ${m.tStat.toFixed(2)} | maxDD ${m.maxDrawdownR.toFixed(1)}R`);
console.log(`  first half ${h1R.toFixed(1)}R, second half ${h2R.toFixed(1)}R | longs ${trades.filter((t) => t.side === 'LONG').length}, shorts ${trades.filter((t) => t.side === 'SHORT').length}`);
console.log(`  skipped by live rules: ${JSON.stringify(rejections)}`);
fs.writeFileSync(path.resolve(__dirname, `../../../data/strategy-lab/replay-${sym}-${strategy}-${days}d.json`), JSON.stringify({ metrics: m, trades, rejections }, null, 2));
