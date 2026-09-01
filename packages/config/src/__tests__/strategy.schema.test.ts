import { StrategyConfigSchema, DEFAULT_STRATEGY_CONFIG } from '../strategy.schema';
import { BOSConfirmationType, MTFMode } from '@quant/shared';

describe('StrategyConfigSchema', () => {
  it('should parse valid default strategy configuration', () => {
    expect(DEFAULT_STRATEGY_CONFIG.minScore).toBe(70);
    expect(DEFAULT_STRATEGY_CONFIG.requireLiquiditySweep).toBe(true);
    expect(DEFAULT_STRATEGY_CONFIG.requireBOS).toBe(true);
    expect(DEFAULT_STRATEGY_CONFIG.riskRewardMinimum).toBe(1.5);
    expect(DEFAULT_STRATEGY_CONFIG.bosConfirmationType).toBe(
      BOSConfirmationType.CANDLE_CLOSE_AND_DISPLACEMENT,
    );
    expect(DEFAULT_STRATEGY_CONFIG.mtfMode).toBe(MTFMode.BALANCED);
  });

  it('should validate custom strategy parameters', () => {
    const customConfig = {
      name: 'High Precision SMC',
      minScore: 85,
      requireLiquiditySweep: true,
      requireBOS: true,
      requireFVG: true,
      riskRewardMinimum: 2.5,
      mtfMode: MTFMode.STRICT,
    };

    const parsed = StrategyConfigSchema.parse(customConfig);
    expect(parsed.minScore).toBe(85);
    expect(parsed.requireFVG).toBe(true);
    expect(parsed.mtfMode).toBe(MTFMode.STRICT);
  });
});
