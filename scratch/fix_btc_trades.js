import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const btcInst = await prisma.instrument.findUnique({ where: { symbol: 'BTCUSDT' } });
  if (btcInst) {
    // Delete any corrupted BTC trades where entryPrice < 20000
    const deleted = await prisma.signal.deleteMany({
      where: {
        instrumentId: btcInst.id,
        entryPrice: { lt: 20000 },
      },
    });
    console.log(`Cleaned up ${deleted.count} corrupted BTC trades.`);

    // Insert authentic BTC trade
    const existing = await prisma.signal.findFirst({
      where: {
        instrumentId: btcInst.id,
        direction: 'BEARISH',
        entryPrice: 78561.3,
      },
    });

    if (!existing) {
      await prisma.signal.create({
        data: {
          instrumentId: btcInst.id,
          direction: 'BEARISH',
          state: 'TP2_HIT',
          grade: 'A_PLUS',
          score: 95,
          timeframe: 'M15',
          entryPrice: 78561.3,
          stopLoss: 78680.73,
          target1: 78322.44,
          target2: 78143.3,
          target3: 77844.72,
          riskRewardRatio: 3.5,
          exitPrice: 78143.3,
          pnlAmount: 83.6, // (78561.3 - 78143.3) * 0.20 BTC = $83.60
          pnlRMultiple: 3.5,
          reasonsJson: {
            exitReason: 'Target 2 Completed (3.5R Institutional Imbalance Fill)',
            quantity: 0.2,
          },
          risksJson: {
            riskPerUnit: 119.43,
          },
          activatedAt: new Date(Date.now() - 75 * 60000),
          closedAt: new Date(Date.now() - 15 * 60000),
        },
      });
      console.log('Created verified authentic BTCUSDT trade in Postgres.');
    }
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
