import { z } from 'zod';
import { BOSConfirmationType, MTFMode } from '@quant/shared';

export const StrategyConfigSchema = z.object({
  name: z.string().default('Default SMC Strategy'),
  minScore: z.number().min(50).max(100).default(70),
  requireLiquiditySweep: z.boolean().default(true),
  requireBOS: z.boolean().default(true),
  requireFVG: z.boolean().default(false),
  requireOrderBlock: z.boolean().default(false),
  requireHTFAlignment: z.boolean().default(true),
  riskRewardMinimum: z.number().min(1.0).default(1.5),
  riskPerTrade: z.number().min(0.1).max(5.0).default(0.5),
  maxOpenSignals: z.number().int().min(1).default(5),
  maxDailyLossPercent: z.number().min(0.5).max(10.0).default(2.0),

  // SMC Parameter Configuration
  swingLeftBars: z.number().int().min(1).default(3),
  swingRightBars: z.number().int().min(1).default(3),
  minSwingDistanceAtrMultiplier: z.number().min(0.1).default(0.5),

  bosConfirmationType: z
    .nativeEnum(BOSConfirmationType)
    .default(BOSConfirmationType.CANDLE_CLOSE_AND_DISPLACEMENT),
  displacementThresholdAtr: z.number().min(0.5).default(1.2),

  equalHighLowToleranceAtr: z.number().min(0.01).max(0.5).default(0.1),
  fvgMinGapAtr: z.number().min(0.05).default(0.2),

  mtfMode: z.nativeEnum(MTFMode).default(MTFMode.BALANCED),
});

export type StrategyConfig = z.infer<typeof StrategyConfigSchema>;

export const DEFAULT_STRATEGY_CONFIG: StrategyConfig = StrategyConfigSchema.parse({});
