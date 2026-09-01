import { PrismaClient, AssetType, Timeframe } from '@prisma/client';
import { MockMarketDataProvider, CandleValidator, REDIS_KEYS } from '@quant/shared';
import Redis from 'ioredis';

const prisma = new PrismaClient();
const redis = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: Number(process.env.REDIS_PORT) || 6380,
  password: process.env.REDIS_PASSWORD || undefined,
  lazyConnect: true,
});

async function main() {
  console.log('--- Step 1: Seeding initial instruments ---');

  const instruments = [
    {
      symbol: 'NIFTY',
      name: 'NIFTY 50 Index',
      exchange: 'NSE',
      assetType: AssetType.INDEX,
      tickSize: 0.05,
      lotSize: 65,
      contractSize: 1,
      currency: 'INR',
      tradingHoursJson: { start: '09:15', end: '15:30', timezone: 'Asia/Kolkata' },
      isActive: true,
    },
    {
      symbol: 'BANKNIFTY',
      name: 'NIFTY Bank Index',
      exchange: 'NSE',
      assetType: AssetType.INDEX,
      tickSize: 0.05,
      lotSize: 15,
      contractSize: 1,
      currency: 'INR',
      tradingHoursJson: { start: '09:15', end: '15:30', timezone: 'Asia/Kolkata' },
      isActive: true,
    },
    {
      symbol: 'BTCUSDT',
      name: 'Bitcoin / Tether USD',
      exchange: 'BINANCE',
      assetType: AssetType.CRYPTO,
      tickSize: 0.01,
      lotSize: 1,
      contractSize: 1,
      currency: 'USDT',
      tradingHoursJson: { start: '00:00', end: '23:59', timezone: 'UTC' },
      isActive: true,
    },
    {
      symbol: 'RELIANCE',
      name: 'Reliance Industries Ltd.',
      exchange: 'NSE',
      assetType: AssetType.EQUITY,
      tickSize: 0.05,
      lotSize: 1,
      contractSize: 1,
      currency: 'INR',
      tradingHoursJson: { start: '09:15', end: '15:30', timezone: 'Asia/Kolkata' },
      isActive: true,
    },
    {
      symbol: 'HDFCBANK',
      name: 'HDFC Bank Ltd.',
      exchange: 'NSE',
      assetType: AssetType.EQUITY,
      tickSize: 0.05,
      lotSize: 1,
      contractSize: 1,
      currency: 'INR',
      tradingHoursJson: { start: '09:15', end: '15:30', timezone: 'Asia/Kolkata' },
      isActive: true,
    },
    {
      symbol: 'INFY',
      name: 'Infosys Ltd.',
      exchange: 'NSE',
      assetType: AssetType.EQUITY,
      tickSize: 0.05,
      lotSize: 1,
      contractSize: 1,
      currency: 'INR',
      tradingHoursJson: { start: '09:15', end: '15:30', timezone: 'Asia/Kolkata' },
      isActive: true,
    },
  ];

  const dbInstruments = [];
  for (const inst of instruments) {
    const created = await prisma.instrument.upsert({
      where: { symbol: inst.symbol },
      update: inst,
      create: inst,
    });
    dbInstruments.push(created);
    console.log(`Upserted instrument: ${inst.symbol}`);
  }

  console.log('\n--- Step 2: Backfilling historical candles ---');
  try {
    await redis.connect();
  } catch (e) {
    console.log('Redis connect warning:', (e as Error).message);
  }

  const provider = new MockMarketDataProvider({ seed: 2026 });
  const timeframes = [
    { tf: Timeframe.H4, limit: 150, tfStr: '4h' },
    { tf: Timeframe.H1, limit: 200, tfStr: '1h' },
    { tf: Timeframe.M15, limit: 300, tfStr: '15m' },
    { tf: Timeframe.M5, limit: 300, tfStr: '5m' },
  ];

  let totalCandlesIngested = 0;

  for (const inst of dbInstruments) {
    for (const { tf, limit, tfStr } of timeframes) {
      const rawCandles = await provider.getHistoricalCandles(inst.symbol, tfStr as any, limit);
      const { validCandles } = CandleValidator.normalizeAndCleanSeries(rawCandles);

      for (const candle of validCandles) {
        await prisma.candle.upsert({
          where: {
            instrumentId_timeframe_timestamp: {
              instrumentId: inst.id,
              timeframe: tf,
              timestamp: candle.timestamp,
            },
          },
          update: {
            open: candle.open,
            high: candle.high,
            low: candle.low,
            close: candle.close,
            volume: candle.volume,
            isClosed: true,
          },
          create: {
            instrumentId: inst.id,
            timeframe: tf,
            timestamp: candle.timestamp,
            open: candle.open,
            high: candle.high,
            low: candle.low,
            close: candle.close,
            volume: candle.volume,
            isClosed: true,
          },
        });
      }

      totalCandlesIngested += validCandles.length;

      // Seed Redis latest candle and buffer
      if (validCandles.length > 0 && redis.status === 'ready') {
        const latest = validCandles[validCandles.length - 1];
        await redis.set(REDIS_KEYS.LATEST_CANDLE(inst.symbol, tfStr), JSON.stringify(latest), 'EX', 86400);
        await redis.set(REDIS_KEYS.CANDLE_BUFFER(inst.symbol, tfStr), JSON.stringify(validCandles), 'EX', 86400);
      }

      console.log(`Ingested ${validCandles.length} candles for ${inst.symbol} [${tfStr}]`);
    }
  }

  console.log(`\nHistorical backfill complete! Total candles stored: ${totalCandlesIngested}`);
}

main()
  .catch((e) => {
    console.error('Error during seeding:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    if (redis.status === 'ready') {
      await redis.quit();
    }
  });
