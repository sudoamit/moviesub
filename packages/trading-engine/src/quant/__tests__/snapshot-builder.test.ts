import { Direction, ICandle } from '@quant/shared';
import { MultiHorizonEngine } from '../multi-horizon-engine';
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

  it('should ignore future candles when asOfTimestamp is supplied to multi-horizon analysis', () => {
    const baseCandles: ICandle[] = [];
    for (let i = 0; i < 12; i++) {
      const open = 100 + i * 1.5;
      const close = 102 + i * 1.5;
      baseCandles.push({
        timestamp: new Date(1700000000000 + i * 15 * 60 * 1000),
        open,
        high: Math.max(open, close) + 2,
        low: Math.min(open, close) - 2,
        close,
        volume: 1000 + i * 10,
      });
    }

    const asOf = new Date(baseCandles[baseCandles.length - 1].timestamp);
    const futureCandles = [
      ...baseCandles,
      {
        timestamp: new Date(asOf.getTime() + 15 * 60 * 1000),
        open: 120,
        high: 127,
        low: 116,
        close: 118,
        volume: 20000,
      },
      {
        timestamp: new Date(asOf.getTime() + 30 * 60 * 1000),
        open: 118,
        high: 122,
        low: 90,
        close: 92,
        volume: 25000,
      },
    ];

    const historical = MultiHorizonEngine.evaluateMultiHorizon(baseCandles, baseCandles, baseCandles, {
      asOfTimestamp: asOf,
      executionTimeframe: '15m',
      htfTimeframe: '1h',
      macroTimeframe: '4h',
    });

    const withFuture = MultiHorizonEngine.evaluateMultiHorizon(futureCandles, futureCandles, futureCandles, {
      asOfTimestamp: asOf,
      executionTimeframe: '15m',
      htfTimeframe: '1h',
      macroTimeframe: '4h',
    });

    expect(withFuture.execution.trend).toBe(historical.execution.trend);
    expect(withFuture.higherTimeframe.trend).toBe(historical.higherTimeframe.trend);
    expect(withFuture.macro.trend).toBe(historical.macro.trend);
    expect(withFuture.alignment).toBe(historical.alignment);
    expect(withFuture.confluenceScore).toBe(historical.confluenceScore);
  });
});
