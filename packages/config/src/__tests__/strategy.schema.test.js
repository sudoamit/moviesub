"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const strategy_schema_1 = require("../strategy.schema");
const shared_1 = require("@quant/shared");
describe('StrategyConfigSchema', () => {
    it('should parse valid default strategy configuration', () => {
        expect(strategy_schema_1.DEFAULT_STRATEGY_CONFIG.minScore).toBe(70);
        expect(strategy_schema_1.DEFAULT_STRATEGY_CONFIG.requireLiquiditySweep).toBe(true);
        expect(strategy_schema_1.DEFAULT_STRATEGY_CONFIG.requireBOS).toBe(true);
        expect(strategy_schema_1.DEFAULT_STRATEGY_CONFIG.riskRewardMinimum).toBe(1.5);
        expect(strategy_schema_1.DEFAULT_STRATEGY_CONFIG.bosConfirmationType).toBe(shared_1.BOSConfirmationType.CANDLE_CLOSE_AND_DISPLACEMENT);
        expect(strategy_schema_1.DEFAULT_STRATEGY_CONFIG.mtfMode).toBe(shared_1.MTFMode.BALANCED);
    });
    it('should validate custom strategy parameters', () => {
        const customConfig = {
            name: 'High Precision SMC',
            minScore: 85,
            requireLiquiditySweep: true,
            requireBOS: true,
            requireFVG: true,
            riskRewardMinimum: 2.5,
            mtfMode: shared_1.MTFMode.STRICT,
        };
        const parsed = strategy_schema_1.StrategyConfigSchema.parse(customConfig);
        expect(parsed.minScore).toBe(85);
        expect(parsed.requireFVG).toBe(true);
        expect(parsed.mtfMode).toBe(shared_1.MTFMode.STRICT);
    });
});
//# sourceMappingURL=strategy.schema.test.js.map