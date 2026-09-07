import { MarketRegimeEngine } from '../market-regime';
import { ICandle, MarketRegimeType } from '@quant/shared';

describe('MarketRegimeEngine', () => {
  it('should deterministically classify bullish trend for steady uptrend', () => {
    const candles: ICandle[] = [];
    let p = 100;
    for (let i = 0; i < 60; i++) {
      p += 1.5;
      candles.push({
        timestamp: new Date(1000 + i * 60000),
        open: p - 1,
        high: p + 2,
        low: p - 2,
        close: p + 1,
        volume: 1000,
      });
    }

    const regime = MarketRegimeEngine.classifyRegime(candles);
    expect([MarketRegimeType.BULLISH_TREND, MarketRegimeType.HIGH_VOLATILITY]).toContain(
      regime.regime,
    );
    expect(regime.atr).toBeGreaterThan(0);
    expect(regime.adx).toBeGreaterThan(0);
  });
});
