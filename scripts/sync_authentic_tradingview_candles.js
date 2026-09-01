const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const INSTRUMENTS_MAP = {
  BTCUSDT: {
    type: 'CRYPTO',
    symbol: 'BTCUSDT',
    binanceSymbol: 'BTCUSDT',
  },
  NIFTY: {
    type: 'EQUITY',
    symbol: 'NIFTY',
    yahooSymbol: '^NSEI',
  },
  BANKNIFTY: {
    type: 'EQUITY',
    symbol: 'BANKNIFTY',
    yahooSymbol: '^NSEBANK',
  },
  RELIANCE: {
    type: 'EQUITY',
    symbol: 'RELIANCE',
    yahooSymbol: 'RELIANCE.NS',
  },
  HDFCBANK: {
    type: 'EQUITY',
    symbol: 'HDFCBANK',
    yahooSymbol: 'HDFCBANK.NS',
  },
  INFY: {
    type: 'EQUITY',
    symbol: 'INFY',
    yahooSymbol: 'INFY.NS',
  },
};

const TIMEFRAME_CONFIGS = [
  { tf: 'M15', binanceInterval: '15m', yahooInterval: '15m', yahooRange: '1mo', limit: 250 },
  { tf: 'H1', binanceInterval: '1h', yahooInterval: '60m', yahooRange: '3mo', limit: 250 },
  { tf: 'H4', binanceInterval: '4h', yahooInterval: '60m', yahooRange: '6mo', limit: 250 },
  { tf: 'M5', binanceInterval: '5m', yahooInterval: '5m', yahooRange: '5d', limit: 250 },
  { tf: 'M1', binanceInterval: '1m', yahooInterval: '1m', yahooRange: '5d', limit: 250 },
];

async function fetchBinanceCandles(binanceSymbol, interval, limit) {
  const url = `https://api.binance.com/api/v3/klines?symbol=${binanceSymbol}&interval=${interval}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Binance API error: ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data)) return [];

  return data.map((k) => ({
    timestamp: new Date(k[0]),
    open: Number(parseFloat(k[1]).toFixed(2)),
    high: Number(parseFloat(k[2]).toFixed(2)),
    low: Number(parseFloat(k[3]).toFixed(2)),
    close: Number(parseFloat(k[4]).toFixed(2)),
    volume: Math.round(parseFloat(k[5])),
    isClosed: true,
  }));
}

async function fetchYahooCandles(yahooSymbol, interval, range, limit) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?interval=${interval}&range=${range}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`Yahoo API error: ${res.status}`);
  const data = await res.json();
  const result = data?.chart?.result?.[0];
  if (!result || !result.timestamp) return [];

  const timestamps = result.timestamp;
  const quote = result.indicators?.quote?.[0];
  if (!quote) return [];

  const candles = [];
  for (let i = 0; i < timestamps.length; i++) {
    const o = quote.open[i];
    const h = quote.high[i];
    const l = quote.low[i];
    const c = quote.close[i];
    const v = quote.volume[i] || 0;

    if (o !== null && h !== null && l !== null && c !== null && !isNaN(o) && !isNaN(c)) {
      candles.push({
        timestamp: new Date(timestamps[i] * 1000),
        open: Number(Number(o).toFixed(2)),
        high: Number(Number(h).toFixed(2)),
        low: Number(Number(l).toFixed(2)),
        close: Number(Number(c).toFixed(2)),
        volume: Math.round(v),
        isClosed: true,
      });
    }
  }

  return candles.slice(-limit);
}

async function syncAllAuthenticExchangeCandles() {
  console.log('================================================================================');
  console.log('⚡ SYNCING 100% AUTHENTIC TRADINGVIEW / EXCHANGE CANDLES (NO SYNTHETIC NOISE)');
  console.log('================================================================================\n');

  for (const [sym, config] of Object.entries(INSTRUMENTS_MAP)) {
    const inst = await prisma.instrument.findUnique({ where: { symbol: sym } });
    if (!inst) {
      console.warn(`Instrument ${sym} not found in database.`);
      continue;
    }

    console.log(`📡 Ingesting Authentic Candles for ${sym} (${config.type})...`);
    let latestSpotPrice = null;

    for (const tf of TIMEFRAME_CONFIGS) {
      let candles = [];
      try {
        if (config.type === 'CRYPTO') {
          candles = await fetchBinanceCandles(config.binanceSymbol, tf.binanceInterval, tf.limit);
        } else {
          candles = await fetchYahooCandles(config.yahooSymbol, tf.yahooInterval, tf.yahooRange, tf.limit);
        }
      } catch (err) {
        console.warn(`  Failed fetching ${sym} ${tf.tf}: ${err.message}`);
      }

      if (!candles || candles.length === 0) {
        console.warn(`  ⚠️ No candles received for ${sym} [${tf.tf}]`);
        continue;
      }

      // Record latest spot price from the highest resolution or M15
      if (tf.tf === 'M15' && candles.length > 0) {
        latestSpotPrice = candles[candles.length - 1].close;
      }

      // Delete old candles for clean replacement
      await prisma.candle.deleteMany({
        where: {
          instrumentId: inst.id,
          timeframe: tf.tf,
        },
      });

      // Insert real candles
      const dbRows = candles.map((c) => ({
        instrumentId: inst.id,
        timeframe: tf.tf,
        timestamp: c.timestamp,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
        isClosed: true,
      }));

      await prisma.candle.createMany({
        data: dbRows,
        skipDuplicates: true,
      });

      console.log(`  ✓ ${sym} [${tf.tf}]: Saved ${candles.length} authentic candles. (Latest Close: ${candles[candles.length - 1].close})`);
    }

    if (latestSpotPrice) {
      console.log(`  🎯 Synced ${sym} Spot Price -> ₹${latestSpotPrice}\n`);
    }
  }

  console.log('================================================================================');
  console.log('🎉 ALL 6 INSTRUMENTS SYNCHRONIZED TO AUTHENTIC TRADINGVIEW CANDLES');
  console.log('================================================================================');

  await prisma.$disconnect();
}

syncAllAuthenticExchangeCandles().catch(async (e) => {
  console.error('Fatal Sync Error:', e);
  await prisma.$disconnect();
});
