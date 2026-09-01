import { MockMarketDataProvider } from '../mock-market-data-provider';
import { Timeframe } from '../../enums';
import { CandleValidator } from '../candle-validator';

describe('MockMarketDataProvider', () => {
  let provider: MockMarketDataProvider;

  beforeEach(() => {
    provider = new MockMarketDataProvider({ seed: 42 });
  });

  it('should generate requested number of valid historical candles', async () => {
    const candles = await provider.getHistoricalCandles('NIFTY', Timeframe.M15, 50);

    expect(candles).toHaveLength(50);
    // Verify each candle satisfies strict validation
    for (const candle of candles) {
      const val = CandleValidator.validate(candle);
      expect(val.isValid).toBe(true);
    }
  });

  it('should generate strictly monotonic increasing timestamps', async () => {
    const candles = await provider.getHistoricalCandles('BANKNIFTY', Timeframe.M5, 30);

    for (let i = 1; i < candles.length; i++) {
      expect(candles[i].timestamp.getTime()).toBeGreaterThan(candles[i - 1].timestamp.getTime());
      expect(candles[i].timestamp.getTime() - candles[i - 1].timestamp.getTime()).toBe(
        5 * 60 * 1000,
      );
    }
  });

  it('should produce deterministic repeatable candles with same seed', async () => {
    const p1 = new MockMarketDataProvider({ seed: 999 });
    const p2 = new MockMarketDataProvider({ seed: 999 });

    const end = new Date('2026-08-28T12:00:00Z');
    const c1 = await p1.getHistoricalCandles('BTCUSDT', Timeframe.H1, 20, end);
    const c2 = await p2.getHistoricalCandles('BTCUSDT', Timeframe.H1, 20, end);

    expect(c1).toEqual(c2);
  });

  it('should handle disconnect and reconnect simulation', async () => {
    expect(provider.getIsConnected()).toBe(true);

    provider.simulateDisconnect();
    expect(provider.getIsConnected()).toBe(false);

    await expect(provider.getHistoricalCandles('NIFTY', Timeframe.M15, 10)).rejects.toThrow(
      'Cannot fetch data: Provider is disconnected',
    );

    provider.simulateReconnect();
    expect(provider.getIsConnected()).toBe(true);

    const candles = await provider.getHistoricalCandles('NIFTY', Timeframe.M15, 10);
    expect(candles).toHaveLength(10);
  });

  it('should support subscription and unsubscription lifecycle', async () => {
    let receivedCount = 0;
    const callback = () => {
      receivedCount++;
    };

    await provider.subscribeToMarketData('INFY', Timeframe.M1, callback);
    await provider.unsubscribeFromMarketData('INFY', Timeframe.M1);
    expect(receivedCount).toBe(0);
  });
});
