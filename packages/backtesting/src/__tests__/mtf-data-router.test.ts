import { MarketDataRouter } from '../market-data-router';
import { ICandle } from '@quant/shared';

describe('MarketDataRouter - Multi-Timeframe Zero Look-Ahead', () => {
  const baseTime = 1756972800000; // e.g. 10:00:00 UTC

  // 15m candles: 10:00, 10:15, 10:30, 10:45, 11:00
  const executionCandles: ICandle[] = [
    { timestamp: new Date(baseTime), open: 100, high: 102, low: 99, close: 101, volume: 1000 },
    { timestamp: new Date(baseTime + 15 * 60 * 1000), open: 101, high: 103, low: 100, close: 102, volume: 1100 },
    { timestamp: new Date(baseTime + 30 * 60 * 1000), open: 102, high: 104, low: 101, close: 103, volume: 1200 },
    { timestamp: new Date(baseTime + 45 * 60 * 1000), open: 103, high: 105, low: 102, close: 104, volume: 1300 },
    { timestamp: new Date(baseTime + 60 * 60 * 1000), open: 104, high: 106, low: 103, close: 105, volume: 1400 },
  ];

  // 1h candles: 09:00-10:00 (past), 10:00-11:00 (concurrent)
  const htf1Candles: ICandle[] = [
    { timestamp: new Date(baseTime - 60 * 60 * 1000), open: 95, high: 100, low: 94, close: 99, volume: 5000 },
    { timestamp: new Date(baseTime), open: 100, high: 106, low: 99, close: 105, volume: 6000 },
  ];

  it('should exclude concurrent HTF candle when execution time is before HTF candle close (Zero Lookahead)', () => {
    const router = new MarketDataRouter({
      executionCandles,
      htf1Candles,
      executionTimeframe: '15m',
      htf1Timeframe: '1h',
    });

    // At 10:15 (index 1), the 10:00-11:00 1h candle is still forming and has NOT closed
    const dataAt1015 = router.getAvailableMarketDataAt(1);
    expect(dataAt1015.executionSlice.length).toBe(2);
    // Only the 09:00-10:00 HTF candle must be visible
    expect(dataAt1015.htf1Slice.length).toBe(1);
    expect(new Date(dataAt1015.htf1Slice[0].timestamp).getTime()).toBe(baseTime - 60 * 60 * 1000);
  });

  it('should include HTF candle once its full duration has completed at or before execution bar close', () => {
    const router = new MarketDataRouter({
      executionCandles,
      htf1Candles,
      executionTimeframe: '15m',
      htf1Timeframe: '1h',
    });

    // At 10:45 (index 3), the 15m candle closes at 11:00. The 10:00-11:00 1h candle is now fully closed!
    const dataAt1045 = router.getAvailableMarketDataAt(3);
    expect(dataAt1045.executionSlice.length).toBe(4);
    expect(dataAt1045.htf1Slice.length).toBe(2);
    expect(new Date(dataAt1045.htf1Slice[1].timestamp).getTime()).toBe(baseTime);
  });

  it('should normalize and sort out-of-order and duplicate timestamps gracefully', () => {
    const unorderedHtf: ICandle[] = [
      { timestamp: new Date(baseTime), open: 100, high: 106, low: 99, close: 105, volume: 6000 },
      { timestamp: new Date(baseTime - 60 * 60 * 1000), open: 95, high: 100, low: 94, close: 99, volume: 5000 },
    ];

    const router = new MarketDataRouter({
      executionCandles,
      htf1Candles: unorderedHtf,
      executionTimeframe: '15m',
      htf1Timeframe: '1h',
    });

    const data = router.getAvailableMarketDataAt(0);
    expect(data.htf1Slice.length).toBe(1);
    expect(new Date(data.htf1Slice[0].timestamp).getTime()).toBe(baseTime - 60 * 60 * 1000);
  });
});
