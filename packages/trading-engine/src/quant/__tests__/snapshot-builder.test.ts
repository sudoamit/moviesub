import { ICandle } from '@quant/shared';
import { SnapshotBuilder } from '../snapshot-builder';

describe('SnapshotBuilder', () => {
  const createMockCandles = (count = 50, base = 24000): ICandle[] => {
    return Array.from({ length: count }, (_, i) => {
      const open = base + i * 5;
      const close = open + (i % 2 === 0 ? 10 : -5);
      const high = Math.max(open, close) + 5;
      const low = Math.min(open, close) - 5;
      return {
        timestamp: new Date(1700000000000 + i * 900000),
        open,
        high,
        low,
        close,
        volume: 15000 + i * 100,
      };
    });
  };

  it('should build a complete canonical PointInTimeMarketSnapshot', () => {
    const candles = createMockCandles(60, 24000);
    const snapshot = SnapshotBuilder.buildSnapshot({
      symbol: 'NIFTY',
      executionCandles: candles,
      executionTimeframe: '15m',
    });

    expect(snapshot.instrument.symbol).toBe('NIFTY');
    expect(snapshot.marketPrice).toBe(candles[candles.length - 1].close);
    expect(snapshot.quant).toBeDefined();
    expect(snapshot.regime).toBeDefined();
    expect(snapshot.volatility).toBeDefined();
    expect(snapshot.score.totalScore).toBeGreaterThanOrEqual(0);
    expect(snapshot.score.totalScore).toBeLessThanOrEqual(100);
    expect(snapshot.trace).toBeDefined();
    expect(snapshot.trace.whyThisTradeRanked.length).toBeGreaterThanOrEqual(0);
    expect(snapshot.ml).toBeDefined();
    expect(snapshot.ml?.probabilityWin).toBeNull();
    expect(snapshot.ml?.expectedR).toBeNull();
    expect(snapshot.trace.ml.probability).toBeNull();
    expect(snapshot.trace.ml.expectedR).toBeNull();
  });
});
