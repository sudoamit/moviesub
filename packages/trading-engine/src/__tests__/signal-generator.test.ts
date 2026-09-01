import { SignalGenerator } from '../signal-generator';
import { MockMarketDataProvider, Timeframe } from '@quant/shared';

describe('SignalGenerator', () => {
  it('should generate an analytical signal setup from multi-timeframe candles', async () => {
    const provider = new MockMarketDataProvider({ seed: 777 });
    const execCandles = await provider.getHistoricalCandles('NIFTY', '15m', 150);
    const htf1Candles = await provider.getHistoricalCandles('NIFTY', '1h', 100);
    const htf2Candles = await provider.getHistoricalCandles('NIFTY', '4h', 100);

    const signal = SignalGenerator.generateSignal({
      symbol: 'NIFTY',
      executionCandles: execCandles,
      executionTimeframe: Timeframe.M15,
      htf1Candles,
      htf1Timeframe: Timeframe.H1,
      htf2Candles,
      htf2Timeframe: Timeframe.H4,
    });

    expect(signal).toBeDefined();
    expect(signal.symbol).toBe('NIFTY');
    expect(signal.score).toBeGreaterThanOrEqual(0);
    expect(signal.score).toBeLessThanOrEqual(100);
    expect(signal.grade).toBeDefined();
    expect(signal.scoreBreakdown).toBeDefined();
    expect(signal.reasoning).toBeDefined();
    expect(signal.reasoning.summary).toBeDefined();
  });
});
