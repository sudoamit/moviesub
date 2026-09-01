const { RealLiveMarketDataProvider } = require('./packages/shared/dist/market-data/real-live-market-provider.js');

async function testFetchRealCandles() {
  const provider = new RealLiveMarketDataProvider();
  const symbols = ['BTCUSDT', 'NIFTY', 'BANKNIFTY', 'RELIANCE', 'HDFCBANK', 'INFY'];

  console.log('Testing RealLiveMarketDataProvider for all symbols...\n');

  for (const sym of symbols) {
    try {
      const candles = await provider.getHistoricalCandles(sym, '15m', 10);
      console.log(`Symbol: ${sym}`);
      console.log(`Received: ${candles.length} candles`);
      if (candles.length > 0) {
        const last = candles[candles.length - 1];
        console.log(`Latest Candle: Time: ${last.timestamp.toISOString()}, Open: ${last.open}, High: ${last.high}, Low: ${last.low}, Close: ${last.close}`);
      }
    } catch (e) {
      console.error(`Error for ${sym}:`, e.message);
    }
    console.log('---');
  }
}

testFetchRealCandles();
