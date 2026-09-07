const path = require('path');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const { SMCAnalyzer } = require(
  path.join(__dirname, '../packages/trading-engine/dist/smc-analyzer.js'),
);
const { TradeLevelsCalculator } = require(
  path.join(__dirname, '../packages/trading-engine/dist/trade-levels.js'),
);

async function debugLevels() {
  const inst = await prisma.instrument.findUnique({ where: { symbol: 'NIFTY' } });
  const candles = await prisma.candle.findMany({
    where: { instrumentId: inst.id, timeframe: 'M15' },
    orderBy: { timestamp: 'asc' },
    take: 200,
  });

  console.log('Candles count:', candles.length);
  const analysis = SMCAnalyzer.analyze(candles);
  console.log('Analysis summary:', {
    trend: analysis.currentTrend,
    swingsHigh: analysis.confirmedSwingHighs.length,
    swingsLow: analysis.confirmedSwingLows.length,
    obs: analysis.activeOrderBlocks.length,
    fvgs: analysis.activeFVGs.length,
  });

  const anchorSwing = analysis.confirmedSwingHighs.slice(-1)[0] || null;
  const activeOB =
    analysis.activeOrderBlocks.filter((ob) => ob.direction === 'BEARISH').slice(-1)[0] || null;
  const activeFVG =
    analysis.activeFVGs.filter((f) => f.direction === 'BEARISH').slice(-1)[0] || null;

  console.log('anchorSwing:', anchorSwing);
  console.log('activeOB:', activeOB);
  console.log('activeFVG:', activeFVG);

  const levels = TradeLevelsCalculator.calculateLevels(
    'BEARISH',
    candles,
    anchorSwing,
    activeOB,
    activeFVG,
  );

  console.log('\nFinal Calculated levels:', levels);
  await prisma.$disconnect();
}

debugLevels().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
});
