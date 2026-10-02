/**
 * Registers a validated lab strategy for the live runner (status SHADOW) with its full-history reference
 * statistics, used by automatic promotion / retirement. Re-running updates the reference, never the status.
 * Usage (repo root .env loaded): npx ts-node --transpile-only scripts/register-strategy.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { aggregateBars, backtestGenome, computeFeatures, computeMetrics, genomeId, INSTRUMENT_PROFILES, StrategyGenome } from '../src';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { PrismaClient } = require('@prisma/client');

const symbol = 'BTCUSDT_PERP';
const timeframe = '4h';
const genome: StrategyGenome = {
  trigger: 'BREAKOUT_20', sides: 'BOTH', filters: ['HTF_TREND', 'STRUCTURE_TREND', 'RECENT_DISPLACEMENT'],
  stop: { type: 'ATR', atrMult: 2.5 }, rewardRisk: 0, maxBarsInTrade: 160, entryMode: 'MARKET', exit: 'TRAIL',
};

async function main() {
  const raw = JSON.parse(fs.readFileSync(path.resolve(__dirname, `../../../data/strategy-lab/${symbol}_15m.json`), 'utf8'));
  const base = INSTRUMENT_PROFILES[symbol];
  const bars = aggregateBars(raw, 16, base.barMs);
  const profile = { ...base, barMs: base.barMs * 16 };
  const trades = backtestGenome(genome, bars, computeFeatures(bars, profile), profile);
  const m = computeMetrics(trades);
  const mean = m.expectancyR;
  const sdR = Math.sqrt(trades.reduce((a, t) => a + (t.netR - mean) ** 2, 0) / Math.max(1, trades.length - 1));
  const years = (bars[bars.length - 1].t - bars[0].t) / (365.25 * 86_400_000);
  const backtestJson = {
    expectancyR: mean, sdR, trades: m.trades, tradesPerYear: m.trades / years, winRate: m.winRate,
    profitFactor: m.profitFactor, maxDrawdownR: m.maxDrawdownR, tStat: m.tStat,
    from: new Date(bars[0].t).toISOString(), to: new Date(bars[bars.length - 1].t).toISOString(),
    confirmation: 'ETHUSDT_PERP (unseen in search): +0.34R/trade over 192 trades, positive in bull and bear markets',
    caveat: 'Edge is from trend filters + trailing exit, not the breakout trigger (does not beat random entries under the same filters).',
  };
  const id = `${symbol}:${timeframe}:${genomeId(genome)}`;
  const prisma = new PrismaClient();
  const existing = await prisma.labStrategy.findUnique({ where: { id } });
  await prisma.labStrategy.upsert({
    where: { id },
    update: { backtestJson, genomeJson: genome as any },
    create: {
      id, symbol, timeframe, genomeJson: genome as any, backtestJson, status: 'SHADOW', leverage: 10, riskPercentage: 0.5,
      name: 'BTC 4h trend breakout (long/short, trailing 2.5 ATR)',
      statusReason: 'Registered from strategy lab; shadow trading before automatic promotion',
    },
  });
  console.log(`${existing ? 'updated' : 'registered'} ${id}`);
  console.log(JSON.stringify(backtestJson, null, 2));
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
