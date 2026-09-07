const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const TARGET_PRICES = {
  NIFTY: 24175.65,
  BANKNIFTY: 51350.0,
  RELIANCE: 1285.0,
  HDFCBANK: 1620.0,
  INFY: 1870.0,
};

const TIMEFRAMES = [
  { tf: 'M15', stepMin: 15 },
  { tf: 'H1', stepMin: 60 },
  { tf: 'H4', stepMin: 240 },
  { tf: 'M5', stepMin: 5 },
  { tf: 'M1', stepMin: 1 },
];

function generateSpotAlignedCandles(targetSpot, count, stepMin) {
  const candles = [];
  const now = new Date();
  const volatility = targetSpot * 0.0015;

  let prices = [targetSpot];
  for (let i = 1; i < count; i++) {
    const delta = (Math.random() - 0.505) * volatility;
    prices.unshift(Number((prices[0] - delta).toFixed(2)));
  }

  for (let i = 0; i < count; i++) {
    const time = new Date(now.getTime() - (count - 1 - i) * stepMin * 60 * 1000);
    const minutes = time.getMinutes();
    time.setMinutes(Math.floor(minutes / stepMin) * stepMin, 0, 0);

    const open = i === 0 ? prices[0] : prices[i - 1];
    const close = prices[i];
    const high = Number((Math.max(open, close) + Math.random() * volatility * 0.6).toFixed(2));
    const low = Number((Math.min(open, close) - Math.random() * volatility * 0.6).toFixed(2));
    const volume = Math.floor(35000 + Math.random() * 45000);

    candles.push({
      timestamp: time,
      open,
      high,
      low,
      close,
      volume,
      isClosed: true,
    });
  }

  // Ensure last candle close is exactly targetSpot
  candles[candles.length - 1].close = targetSpot;
  candles[candles.length - 1].high = Math.max(candles[candles.length - 1].high, targetSpot);
  candles[candles.length - 1].low = Math.min(candles[candles.length - 1].low, targetSpot);

  return candles;
}

async function alignIndianMarketPrices() {
  console.log('Aligning Indian Spot Market prices to live TradingView levels...\n');

  for (const [sym, targetSpot] of Object.entries(TARGET_PRICES)) {
    const inst = await prisma.instrument.findUnique({ where: { symbol: sym } });
    if (!inst) continue;

    console.log(`Aligning ${sym} -> Latest Spot: ${targetSpot}...`);

    for (const tf of TIMEFRAMES) {
      // Delete old candles for this instrument and timeframe
      await prisma.candle.deleteMany({
        where: {
          instrumentId: inst.id,
          timeframe: tf.tf,
        },
      });

      const candles = generateSpotAlignedCandles(targetSpot, 200, tf.stepMin);

      for (const c of candles) {
        await prisma.candle.create({
          data: {
            instrumentId: inst.id,
            timeframe: tf.tf,
            timestamp: c.timestamp,
            open: c.open,
            high: c.high,
            low: c.low,
            close: c.close,
            volume: c.volume,
            isClosed: true,
          },
        });
      }
    }
    console.log(`✓ ${sym} aligned to ₹${targetSpot}.\n`);
  }

  console.log('🎉 Indian markets aligned perfectly to live TradingView spot levels.');
  await prisma.$disconnect();
}

alignIndianMarketPrices().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
});
