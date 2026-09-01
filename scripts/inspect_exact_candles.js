const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function inspectExactCandles() {
  const instruments = await prisma.instrument.findMany({ where: { isActive: true } });

  for (const inst of instruments) {
    const candles = await prisma.candle.findMany({
      where: { instrumentId: inst.id, timeframe: 'M15' },
      orderBy: { timestamp: 'desc' },
      take: 25,
    });

    console.log(`\n================================================================`);
    console.log(`EXACT CANDLES FOR ${inst.symbol} (Latest 25 15m bars):`);
    console.log(`----------------------------------------------------------------`);
    
    // Sort chronologically
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
        `[${idx.toString().padStart(2, ' ')}] Time: ${istTime} | O: ${Number(c.open).toFixed(2)} | H: ${Number(c.high).toFixed(2)} | L: ${Number(c.low).toFixed(2)} | C: ${Number(c.close).toFixed(2)} | Vol: ${c.volume}`
      );
    });
  }

  await prisma.$disconnect();
}

inspectExactCandles().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
});
