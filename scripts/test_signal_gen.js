const path = require('path');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const { SignalGenerator } = require(path.join(__dirname, '../packages/trading-engine/dist/index.js'));

async function testSignals() {
  const instruments = await prisma.instrument.findMany({ where: { isActive: true } });

  for (const inst of instruments) {
    const execCandles = await prisma.candle.findMany({
      where: { instrumentId: inst.id, timeframe: 'M15' },
      orderBy: { timestamp: 'asc' },
      take: 200,
    });
    const htf1Candles = await prisma.candle.findMany({
      where: { instrumentId: inst.id, timeframe: 'H1' },
      orderBy: { timestamp: 'asc' },
      take: 200,
    });
    const htf2Candles = await prisma.candle.findMany({
      where: { instrumentId: inst.id, timeframe: 'H4' },
      orderBy: { timestamp: 'asc' },
      take: 200,
    });

    console.log(`\n======================================================`);
    console.log(`Testing Symbol: ${inst.symbol} (M15: ${execCandles.length}, H1: ${htf1Candles.length}, H4: ${htf2Candles.length})`);
    if (execCandles.length > 0) {
      const latestPrice = execCandles[execCandles.length - 1].close;
      console.log(`Current Spot Price: ₹${latestPrice}`);
      
      const signal = SignalGenerator.generateSignal({
        symbol: inst.symbol,
        executionCandles: execCandles,
        executionTimeframe: '15m',
        htf1Candles: htf1Candles,
        htf1Timeframe: '1h',
        htf2Candles: htf2Candles,
        htf2Timeframe: '4h',
      });

      console.log(`Direction: ${signal.direction} | Grade: ${signal.grade} | Score: ${signal.score}`);
      console.log(`Entry Optimal: ₹${signal.entryZone?.optimal} (Min: ₹${signal.entryZone?.min}, Max: ₹${signal.entryZone?.max})`);
      console.log(`Stop Loss: ₹${signal.stopLoss}`);
      console.log(`TP1: ₹${signal.takeProfits?.tp1} | TP2: ₹${signal.takeProfits?.tp2} | TP3: ₹${signal.takeProfits?.tp3}`);
      console.log(`RR1: ${signal.riskRewardRatios?.rr1} | RR2: ${signal.riskRewardRatios?.rr2} | RR3: ${signal.riskRewardRatios?.rr3}`);
      console.log(`Summary: ${signal.reasons?.summary}`);
      if (signal.reasons?.rejectReasons?.length > 0) {
        console.log(`Reject reasons:`, signal.reasons.rejectReasons);
      }
    }
  }
  await prisma.$disconnect();
}

testSignals().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
});
