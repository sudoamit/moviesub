import { CanonicalCandleAggregator, ChartMarketSnapshot } from '@quant/shared';
import { toAggregatorTick } from '../models/aggregator-tick';
import { isUsdQuoted, quoteCurrencySymbol } from '../models/instrument-display';
import { isSameSymbol } from '../hooks/usePaperTrading';

describe('Chart live price stays in sync with the stream', () => {
  const bucketStart = new Date(Date.UTC(2026, 8, 30, 6, 0, 0));

  const snapshot = (): ChartMarketSnapshot =>
    ({
      symbol: 'BTCUSDT_SPOT',
      timeframe: '15m',
      closedCandles: [],
      formingCandle: {
        timestamp: bucketStart.toISOString(),
        open: 83384.01,
        high: 83438.01,
        low: 83358.71,
        close: 83392,
        volume: 40,
        isClosed: false,
        provenance: 'LIVE',
      },
      livePrice: 83392,
      asOfTimestamp: bucketStart.toISOString(),
      observedAt: bucketStart.toISOString(),
      dataProvenance: 'LIVE',
      sourceIdentity: 'BINANCE_SPOT',
    }) as any;

  // Shape of a MarketStreamContext ticker: marketEventTime, no `timestamp`.
  const streamTicker = {
    symbol: 'BTCUSDT_SPOT',
    price: 83416,
    marketEventTime: bucketStart.getTime() + 60_000,
    isFresh: true,
    providerId: 'BINANCE_SPOT',
    volume: 12345.6, // rolling 24h volume
  };

  it('the raw stream ticker is rejected by the aggregator (root cause of the frozen chart price)', () => {
    const agg = new CanonicalCandleAggregator();
    const before = snapshot();
    const after = agg.processTick(before, streamTicker as any);
    expect(after.livePrice).toBe(83392);
  });

  it('the mapped tick updates livePrice and the forming candle close', () => {
    const agg = new CanonicalCandleAggregator();
    const tick = toAggregatorTick('BTCUSDT_SPOT', streamTicker)!;
    const after = agg.processTick(snapshot(), tick as any);
    expect(after.livePrice).toBe(83416);
    expect(after.formingCandle?.close).toBe(83416);
    // 24h rolling volume must never be added to the candle
    expect(after.formingCandle?.volume).toBeLessThan(1000);
  });

  it('stale or timestamp-less tickers are not applied', () => {
    expect(toAggregatorTick('BTCUSDT_SPOT', { ...streamTicker, isFresh: false })).toBeNull();
    expect(toAggregatorTick('BTCUSDT_SPOT', { price: 1, symbol: 'BTCUSDT_SPOT' })).toBeNull();
  });
});

describe('BTC display currency and symbol matching are alias-aware', () => {
  it('BTCUSDT_SPOT is USD-quoted, NIFTY is INR-quoted', () => {
    expect(quoteCurrencySymbol('BTCUSDT_SPOT')).toBe('$');
    expect(quoteCurrencySymbol('BTCUSDT')).toBe('$');
    expect(isUsdQuoted('XAUUSD')).toBe(true);
    expect(quoteCurrencySymbol('NIFTY')).toBe('₹');
  });

  it('a BTCUSDT signal matches the BTCUSDT_SPOT chart', () => {
    expect(isSameSymbol('BTCUSDT', 'BTCUSDT_SPOT')).toBe(true);
    expect(isSameSymbol('NIFTY', 'BTCUSDT_SPOT')).toBe(false);
  });
});
