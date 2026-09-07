import { ICandle } from '@quant/shared';
import { AblationSimulator } from '../ablation-simulator';

describe('AblationSimulator', () => {
  const createMockCandles = (count = 100, base = 24000): ICandle[] => {
    return Array.from({ length: count }, (_, i) => {
      const open = base + i * 8 + Math.sin(i * 0.3) * 15;
      const close = open + (i % 2 === 0 ? 12 : -8);
      const high = Math.max(open, close) + 8;
      const low = Math.min(open, close) - 8;
      return {
        timestamp: new Date(1700000000000 + i * 900000),
        open,
        high,
        low,
        close,
        volume: 20000 + i * 100,
      };
    });
  };

  it('should run multi-variant ablation study and compare all 6 variants', () => {
    const candles = createMockCandles(100, 24000);
    const ablation = AblationSimulator.runAblationStudy({
      symbol: 'NIFTY',
      candles,
      timeframe: '15m',
      initialCapital: 100000,
    });

    expect(ablation.symbol).toBe('NIFTY');
    expect(ablation.variants.length).toBe(6);
    expect(ablation.variants.map((v) => v.variant)).toContain('SMC_ONLY');
    expect(ablation.variants.map((v) => v.variant)).toContain('FULL_SYSTEM');
    expect(ablation.bestVariant).toBeDefined();
    expect(ablation.recommendation).toBeDefined();
  });
});
