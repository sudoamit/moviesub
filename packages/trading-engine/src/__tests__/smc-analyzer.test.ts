import { SMCAnalyzer } from '../smc-analyzer';
import { MockMarketDataProvider } from '@quant/shared';

describe('SMCAnalyzer', () => {
  it('should run complete SMC analysis on realistic historical candle series', async () => {
    const provider = new MockMarketDataProvider({ seed: 2026 });
    const candles = await provider.getHistoricalCandles('NIFTY', '15m', 200);

    const result = SMCAnalyzer.analyze(candles);

    expect(result.candlesCount).toBe(200);
    expect(result.swingPoints.length).toBeGreaterThan(0);
    expect(result.confirmedSwingHighs.length).toBeGreaterThan(0);
    expect(result.confirmedSwingLows.length).toBeGreaterThan(0);
    expect(result.marketRegime).toBeDefined();
    expect(result.marketRegime.atr).toBeGreaterThan(0);
    expect(result.marketRegime.adx).toBeGreaterThan(0);
  });
});
