"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_STRATEGY_CONFIG = exports.StrategyConfigSchema = void 0;
const zod_1 = require("zod");
const shared_1 = require("@quant/shared");
exports.StrategyConfigSchema = zod_1.z.object({
    name: zod_1.z.string().default('Default SMC Strategy'),
    minScore: zod_1.z.number().min(50).max(100).default(70),
    requireLiquiditySweep: zod_1.z.boolean().default(true),
    requireBOS: zod_1.z.boolean().default(true),
    requireFVG: zod_1.z.boolean().default(false),
    requireOrderBlock: zod_1.z.boolean().default(false),
    requireHTFAlignment: zod_1.z.boolean().default(true),
    riskRewardMinimum: zod_1.z.number().min(1.0).default(1.5),
    riskPerTrade: zod_1.z.number().min(0.1).max(5.0).default(0.5),
    maxOpenSignals: zod_1.z.number().int().min(1).default(5),
    maxDailyLossPercent: zod_1.z.number().min(0.5).max(10.0).default(2.0),
    // SMC Parameter Configuration
    swingLeftBars: zod_1.z.number().int().min(1).default(3),
    swingRightBars: zod_1.z.number().int().min(1).default(3),
    minSwingDistanceAtrMultiplier: zod_1.z.number().min(0.1).default(0.5),
    bosConfirmationType: zod_1.z
        .nativeEnum(shared_1.BOSConfirmationType)
        .default(shared_1.BOSConfirmationType.CANDLE_CLOSE_AND_DISPLACEMENT),
    displacementThresholdAtr: zod_1.z.number().min(0.5).default(1.2),
    equalHighLowToleranceAtr: zod_1.z.number().min(0.01).max(0.5).default(0.1),
    fvgMinGapAtr: zod_1.z.number().min(0.05).default(0.2),
    mtfMode: zod_1.z.nativeEnum(shared_1.MTFMode).default(shared_1.MTFMode.BALANCED),
});
exports.DEFAULT_STRATEGY_CONFIG = exports.StrategyConfigSchema.parse({});
//# sourceMappingURL=strategy.schema.js.map