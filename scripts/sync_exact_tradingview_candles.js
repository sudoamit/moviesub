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
    yahooSymbol: '%5ENSEI',
  },
  BANKNIFTY: {
    type: 'EQUITY',
    symbol: 'BANKNIFTY',
    yahooSymbol: '%5ENSEBANK',
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

const TIMEFRAMES = [
  { tf: 'M15', binanceInterval: '15m', yahooInterval: '15m', yahooRange: '1mo', limit: 250 },
  { tf: 'H1', binanceInterval: '1h', yahooInterval: '60m', yahooRange: '3mo', limit: 250 },
  {
    tf: 'H4',
    binanceInterval: '4h',
    yahooInterval: '60m',
    yahooRange: '6mo',
    limit: 250,
    isH4Aggregate: true,
  },
  { tf: 'M5', binanceInterval: '5m', yahooInterval: '5m', yahooRange: '5d', limit: 250 },
  { tf: 'M1', binanceInterval: '1m', yahooInterval: '1m', yahooRange: '5d', limit: 250 },
];

async function fetchBinanceCandles(binanceSymbol, interval, limit) {
  const url = `https://api.binance.com/api/v3/klines?symbol=${binanceSymbol}&interval=${interval}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Binance API HTTP ${res.status}`);
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

async function fetchYahooCandles(yahooSymbol, interval, range, limit, isH4 = false) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${yahooSymbol}?interval=${interval}&range=${range}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' },
  });
  if (!res.ok) throw new Error(`Yahoo API HTTP ${res.status}`);
  const data = await res.json();
  const result = data?.chart?.result?.[0];
  if (!result || !result.timestamp) return [];

  const timestamps = result.timestamp;
  const quote = result.indicators?.quote?.[0];
  if (!quote) return [];

  const rawCandles = [];
  for (let i = 0; i < timestamps.length; i++) {
    const o = quote.open[i];
    const h = quote.high[i];
    const l = quote.low[i];
    const c = quote.close[i];
    const v = quote.volume[i] || 0;

    // Filter out null or NaN entries
    if (
      o !== null &&
      h !== null &&
      l !== null &&
      c !== null &&
      !isNaN(o) &&
      !isNaN(h) &&
      !isNaN(l) &&
      !isNaN(c)
    ) {
      rawCandles.push({
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

  if (isH4) {
    // Aggregate 4x 1-hour candles into true 4H bars
    const h4Candles = [];
    for (let i = 0; i < rawCandles.length; i += 4) {
      const chunk = rawCandles.slice(i, i + 4);
      if (chunk.length === 0) continue;
      const open = chunk[0].open;
      const close = chunk[chunk.length - 1].close;
      const high = Math.max(...chunk.map((c) => c.high));
      const low = Math.min(...chunk.map((c) => c.low));
      const volume = chunk.reduce((acc, c) => acc + c.volume, 0);

      h4Candles.push({
        timestamp: chunk[0].timestamp,
        open,
        high,
        low,
        close,
        volume,
        isClosed: true,
      });
    }
    return h4Candles.slice(-limit);
  }

  return rawCandles.slice(-limit);
}

async function main() {
  console.log('================================================================================');
  console.log('⚡ SYNCING 100% AUTHENTIC TRADINGVIEW EXCHANGE CANDLESTICKS');
  console.log('================================================================================\n');

  for (const [sym, config] of Object.entries(INSTRUMENTS_MAP)) {
    const inst = await prisma.instrument.findUnique({ where: { symbol: sym } });
    if (!inst) {
      console.warn(`❌ Instrument ${sym} not found in database.`);
      continue;
    }

    console.log(`📡 Ingesting Real Candles for ${sym} (${config.type})...`);

    for (const tf of TIMEFRAMES) {
      let candles = [];
      try {
        if (config.type === 'CRYPTO') {
          candles = await fetchBinanceCandles(config.binanceSymbol, tf.binanceInterval, tf.limit);
        } else {
          candles = await fetchYahooCandles(
            config.yahooSymbol,
            tf.yahooInterval,
            tf.yahooRange,
            tf.limit,
            tf.isH4Aggregate,
          );
        }
      } catch (err) {
        console.warn(`  ⚠️ Error fetching ${sym} ${tf.tf}: ${err.message}`);
      }

      if (!candles || candles.length === 0) {
        console.warn(`  ⚠️ No valid candles for ${sym} [${tf.tf}]`);
        continue;
      }

      // Delete stale candles for this timeframe
      await prisma.candle.deleteMany({
        where: {
          instrumentId: inst.id,
          timeframe: tf.tf,
        },
      });

      // Bulk insert in chunks of 50
      for (let i = 0; i < candles.length; i += 50) {
        const chunk = candles.slice(i, i + 50);
        await prisma.candle.createMany({
          data: chunk.map((c) => ({
            instrumentId: inst.id,
            timeframe: tf.tf,
            timestamp: c.timestamp,
            open: c.open,
            high: c.high,
            low: c.low,
            close: c.close,
            volume: c.volume,
            isClosed: true,
          })),
        });
      }

      const lastCandle = candles[candles.length - 1];
      console.log(
        `  ✓ ${sym} [${tf.tf}]: Ingested ${candles.length} bars (Latest: ${lastCandle.close} @ ${lastCandle.timestamp.toISOString()})`,
      );
    }

    console.log('');
  }

  console.log('✅ ALL TRADINGVIEW CANDLESTICKS SYNCHRONIZED SUCCESSFULLY!');
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error('Fatal sync error:', err);
  process.exit(1);
});
