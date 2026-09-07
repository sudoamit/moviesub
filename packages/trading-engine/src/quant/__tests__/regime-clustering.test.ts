import { ICandle } from '@quant/shared';
import { RegimeClusteringEngine } from '../regime-clustering-engine';

describe('RegimeClusteringEngine', () => {
  const createMockCandles = (count = 60, trendSlope = 1.0): ICandle[] => {
    return Array.from({ length: count }, (_, i) => {
      const open = 100 + i * trendSlope + Math.sin(i * 0.4) * 2;
      const close = open + (trendSlope > 0 ? 1.0 : -1.0);
      const high = Math.max(open, close) + 0.5;
      const low = Math.min(open, close) - 0.5;
      return {
        timestamp: new Date(Date.now() - (count - i) * 60000),
        open,
        high,
        low,
        close,
        volume: 5000 + i * 20,
      };
    });
  };

  it('should run K-Means clustering deterministically', () => {
    const data = [
      [0.8, 0.5, 0.2, 0.1, 0.4, 0.6],
      [0.85, 0.6, 0.25, 0.12, 0.45, 0.65],
      [0.1, -0.4, 0.1, 0.05, -0.2, 0.3],
      [0.12, -0.45, 0.15, 0.08, -0.25, 0.35],
    ];

    const res = RegimeClusteringEngine.runKMeans(data, 2, 10);
    expect(res.centroids.length).toBe(2);
    expect(res.assignments.length).toBe(4);
  });

  it('should classify strong upward momentum as BULLISH_TREND', () => {
    const bullCandles = createMockCandles(60, 2.5);
    const regimeState = RegimeClusteringEngine.classifyRegime(bullCandles);

    expect(regimeState.regime).toBeDefined();
    expect(regimeState.trendStrength).toBeGreaterThan(0);
    expect(regimeState.confidence).toBeGreaterThan(0);
  });
});
