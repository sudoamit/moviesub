const path = require('path');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const { calculateATR } = require(path.join(__dirname, '../packages/indicators/dist/atr.js'));

async function testStepByStep() {
  const inst = await prisma.instrument.findUnique({ where: { symbol: 'NIFTY' } });
  const candles = await prisma.candle.findMany({
    where: { instrumentId: inst.id, timeframe: 'M15' },
    orderBy: { timestamp: 'asc' },
    take: 200,
  });

  const lastCandle = candles[candles.length - 1];
  console.log('lastCandle:', lastCandle);

  const atrSeries = calculateATR(candles, 14);
  console.log('last atr in series:', atrSeries[candles.length - 1]);

  const currentAtr = atrSeries[candles.length - 1] || Math.max(1, lastCandle.high - lastCandle.low);
  console.log('currentAtr:', currentAtr);

  const currentPrice = lastCandle.close;
  console.log('currentPrice:', currentPrice);

  const fvg = {
    upperBound: 24360.8,
    lowerBound: 24348.3,
    direction: 'BEARISH'
  };

  let entryOptimal = currentPrice;
  let entryMin = currentPrice * 0.998;
  let entryMax = currentPrice * 1.002;

  if (fvg && fvg.direction === 'BEARISH') {
    entryMin = fvg.lowerBound;
    entryMax = fvg.upperBound;
    entryOptimal = (fvg.upperBound + fvg.lowerBound) / 2;
  }
  console.log('entryMin:', entryMin, 'entryMax:', entryMax, 'entryOptimal:', entryOptimal);

  const slBuffer = currentAtr * 0.2;
  console.log('slBuffer:', slBuffer);

  let structuralHigh = currentPrice + currentAtr * 1.5;
  if (fvg && fvg.direction === 'BEARISH') {
    structuralHigh = Math.max(structuralHigh, fvg.upperBound);
  }
  console.log('structuralHigh:', structuralHigh);

  const stopLoss = Math.max(entryMax + slBuffer, structuralHigh + slBuffer);
  console.log('stopLoss:', stopLoss);

  const risk = stopLoss - entryOptimal;
  console.log('risk:', risk);

  const tp1 = Math.max(0.01, entryOptimal - risk * 1.5);
  const tp2 = Math.max(0.01, entryOptimal - risk * 2.5);
  const tp3 = Math.max(0.01, entryOptimal - risk * 4.0);

  console.log('tp1:', tp1, 'tp2:', tp2, 'tp3:', tp3);

  await prisma.$disconnect();
}

testStepByStep().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
});
