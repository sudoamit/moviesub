const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function showNiftyBank() {
  for (const sym of ['NIFTY', 'BANKNIFTY', 'BTCUSDT']) {
    const inst = await prisma.instrument.findUnique({ where: { symbol: sym } });
    const candles = await prisma.candle.findMany({
      where: { instrumentId: inst.id, timeframe: 'M15' },
      orderBy: { timestamp: 'desc' },
      take: 25,
    });
    console.log('===========================================================');
    console.log('EXACT CANDLES FOR', sym);
    candles.reverse().forEach((c, idx) => {
      const istTime = new Date(c.timestamp).toLocaleString('en-IN', {
        timeZone: 'Asia/Kolkata',
        day: '2-digit',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
        hour12: true,
      });
      console.log(
        `${idx.toString().padStart(2, ' ')} Time: ${istTime} | O: ${Number(c.open).toFixed(2)} | H: ${Number(c.high).toFixed(2)} | L: ${Number(c.low).toFixed(2)} | C: ${Number(c.close).toFixed(2)}`
      );
    });
  }
  await prisma.$disconnect();
}

showNiftyBank().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
});
