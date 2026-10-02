/**
 * Registers the crypto trend portfolio (validated across markets) as SHADOW lab strategies.
 * Existing strategies keep their status; only their reference statistics are refreshed.
 * Usage (repo root .env loaded): npx ts-node --transpile-only scripts/register-portfolio.ts
 */
import { describeGenome, loadHistory, referenceStats, safeLeverage, strategyId, StrategyGenome } from '../src';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { PrismaClient } = require('@prisma/client');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { PERPETUAL_SPECS } = require('@quant/shared');

const DIR = '../../data/strategy-lab';
// Tighter stops (validated across 9 markets): S1 1x ATR (was 2.5x), S2 2x ATR (was 2.5x)
const S1: StrategyGenome = { trigger: 'BREAKOUT_20', sides: 'BOTH', filters: ['HTF_TREND', 'STRUCTURE_TREND', 'RECENT_DISPLACEMENT'], stop: { type: 'ATR', atrMult: 1 }, rewardRisk: 0, maxBarsInTrade: 160, entryMode: 'MARKET', exit: 'TRAIL' };
const S2: StrategyGenome = { trigger: 'BREAKOUT_20', sides: 'LONG', filters: ['HTF_TREND', 'RECENT_DISPLACEMENT'], stop: { type: 'ATR', atrMult: 2 }, rewardRisk: 3, maxBarsInTrade: 32, entryMode: 'MARKET', exit: 'FIXED' };
const PORTFOLIO: Array<{ symbol: string; tf: '1h' | '4h'; genome: StrategyGenome; label: string }> = [
  ...['BTCUSDT_PERP', 'ETHUSDT_PERP', 'BNBUSDT_PERP'].map((symbol) => ({ symbol, tf: '4h' as const, genome: S1, label: '4h trend (long/short, trailing)' })),
  ...['BTCUSDT_PERP', 'ETHUSDT_PERP', 'SOLUSDT_PERP', 'ADAUSDT_PERP', 'LINKUSDT_PERP'].map((symbol) => ({ symbol, tf: '1h' as const, genome: S2, label: '1h breakout (long, 3R)' })),
];

async function main() {
  const prisma = new PrismaClient();
  // Retire registered SHADOW strategies that are not in the current portfolio (e.g. the wider-stop versions).
  const wanted = new Set(PORTFOLIO.map((p) => strategyId(p.symbol, p.tf, p.genome)));
  for (const old of await prisma.labStrategy.findMany({ where: { status: 'SHADOW' } })) {
    if (wanted.has(old.id)) continue;
    const open = await prisma.labStrategyTrade.count({ where: { strategyId: old.id, status: 'OPEN' } });
    await prisma.labStrategy.update({
      where: { id: old.id },
      data: { status: 'RETIRED', retiredAt: new Date(), statusReason: `Replaced by the tighter-stop portfolio${open ? ` (its ${open} open shadow trade is no longer managed)` : ''}` },
    });
    console.log(`retired ${old.id}`);
  }
  for (const p of PORTFOLIO) {
    const id = strategyId(p.symbol, p.tf, p.genome);
    const ref = referenceStats(p.genome, loadHistory(DIR, p.symbol), p.symbol, p.tf);
    const spec = PERPETUAL_SPECS[p.symbol];
    const leverage = Math.min(spec.maxLeverage, safeLeverage(ref.medianStopPct, spec.maintenanceMarginRate));
    const backtestJson = {
      ...ref,
      discoveryPath: 'CROSS_MARKET_PORTFOLIO',
      evidence: 'Same strategy profitable across 9 crypto perpetual markets (8 unseen in its search), positive out of sample on 8-9/9 markets with the tighter stop.',
      caveat: 'Markets were chosen after seeing their results (mild selection bias); shadow trading must confirm before live.',
    };
    const existing = await prisma.labStrategy.findUnique({ where: { id } });
    if (existing) {
      await prisma.labStrategy.update({ where: { id }, data: { backtestJson: { ...(existing.backtestJson as any), ...ref, referenceRefreshedAt: new Date().toISOString() } } });
      console.log(`exists  ${id} (${existing.status}) - reference refreshed`);
      continue;
    }
    await prisma.labStrategy.create({
      data: {
        id, symbol: p.symbol, timeframe: p.tf, genomeJson: p.genome as any, backtestJson, status: 'SHADOW', leverage, riskPercentage: 3,
        name: `${p.symbol.replace('USDT_PERP', '')} ${p.label}`,
        statusReason: 'Registered from the cross-market crypto trend portfolio; shadow trading before automatic promotion',
      },
    });
    console.log(`created ${p.symbol.padEnd(14)} ${p.tf} | ${ref.trades} trades (${ref.tradesPerYear.toFixed(0)}/yr) ${ref.expectancyR.toFixed(3)}R/trade | stop ~${(ref.medianStopPct * 100).toFixed(1)}% -> ${leverage}x`);
  }
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
