import * as fs from 'fs';
import * as path from 'path';

describe('Architectural Data Authority & Single Aggregation Implementation Test', () => {
  const pagePath = path.resolve(__dirname, '../../../../apps/web/src/app/page.tsx');
  const chartPath = path.resolve(__dirname, '../../../../apps/web/src/components/TradingChart.tsx');

  test('P0 Authority: page.tsx delegates live tick aggregation exclusively to CanonicalCandleAggregator', () => {
    const pageContent = fs.readFileSync(pagePath, 'utf8');

    // Assert CanonicalCandleAggregator is imported and invoked in page.tsx
    expect(pageContent).toContain('CanonicalCandleAggregator');
    expect(pageContent).toContain('CanonicalCandleAggregator.processTick');

    // Assert page.tsx does NOT independently perform bucket calculation or manual forming candle construction
    expect(pageContent).not.toContain('isRollover');
    expect(pageContent).not.toContain('Math.max(currentForming.high, liveP)');
  });

  test('P0 Authority: TradingChart.tsx only consumes canonical snapshot state without tick aggregation logic', () => {
    const chartContent = fs.readFileSync(chartPath, 'utf8');

    // Assert TradingChart does not construct forming candles or perform bucket math
    expect(chartContent).not.toContain('isRollover');
    expect(chartContent).not.toContain('TimeframeRegistry.getBucketOpenTime');
  });
});
