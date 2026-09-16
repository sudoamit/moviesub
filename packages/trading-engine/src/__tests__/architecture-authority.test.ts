import * as fs from 'fs';
import * as path from 'path';

describe('Architectural Data Authority & Single Aggregation Implementation Test', () => {
  const hookPath = path.resolve(__dirname, '../../../../apps/web/src/hooks/useMarketContext.ts');
  const chartPath = path.resolve(__dirname, '../../../../apps/web/src/components/TradingChart.tsx');

  test('P0 Authority: useMarketContext.ts delegates live tick aggregation exclusively to CanonicalCandleAggregator', () => {
    const hookContent = fs.readFileSync(hookPath, 'utf8');

    // Assert CanonicalCandleAggregator is imported and invoked via aggregatorRef in useMarketContext.ts
    expect(hookContent).toContain('CanonicalCandleAggregator');
    expect(hookContent).toContain('aggregatorRef.current.processTick');

    // Assert does NOT independently perform bucket calculation or manual forming candle construction
    expect(hookContent).not.toContain('isRollover');
    expect(hookContent).not.toContain('Math.max(currentForming.high, liveP)');
  });

  test('P0 Authority: TradingChart.tsx only consumes canonical snapshot state without tick aggregation logic', () => {
    const chartContent = fs.readFileSync(chartPath, 'utf8');

    // Assert TradingChart does not construct forming candles or perform bucket math
    expect(chartContent).not.toContain('isRollover');
    expect(chartContent).not.toContain('TimeframeRegistry.getBucketOpenTime');
  });
});
