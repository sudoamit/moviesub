const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function checkTodayRanges() {
  const instruments = await prisma.instrument.findMany({ where: { isActive: true } });
  for (const inst of instruments) {
    const candles = await prisma.candle.findMany({
      where: { instrumentId: inst.id, timeframe: 'M15' },
      orderBy: { timestamp: 'desc' },
      take: 25, // today's 25 15m candles
    });
    if (candles.length > 0) {
      const highs = candles.map((c) => Number(c.high));
      const lows = candles.map((c) => Number(c.low));
      const closes = candles.map((c) => Number(c.close));
      console.log('----------------------------------------------------');
      console.log(
        `${inst.symbol.padEnd(10)} | Today High: ₹${Math.max(...highs).toFixed(2)} | Low: ₹${Math.min(...lows).toFixed(2)} | Close: ₹${closes[0].toFixed(2)} | Today Range: ${(Math.max(...highs) - Math.min(...lows)).toFixed(2)} pts`,
      );
    }
  }
  await prisma.$disconnect();
}

checkTodayRanges().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
});
