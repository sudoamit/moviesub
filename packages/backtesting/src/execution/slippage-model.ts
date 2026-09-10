import { ExecutionCostStressConfig, ISlippageConfig, OrderSide, OrderType } from './types';
import { ICandle } from '@quant/shared';

export const DEFAULT_SLIPPAGE_CONFIG: ISlippageConfig = {
  baseSlippageBps: 2.0, // 0.02% base slippage
  volatilityMultiplier: 1.5,
  impactMultiplier: 0.8,
  maxSlippageBps: 25.0, // Cap at 0.25%
};

export class SlippageModel {
  /**
   * Calculates realistic market order execution slippage taking into account volatility, order size,
   * and authoritative cost stress multiplier.
   */
  static calculateSlippage(
    price: number,
    quantity: number,
    side: OrderSide,
    orderType: OrderType,
    candle?: ICandle,
    config: ISlippageConfig = DEFAULT_SLIPPAGE_CONFIG,
    costStressConfig?: ExecutionCostStressConfig,
  ): { executedPrice: number; slippageAmount: number; slippageBps: number } {
    if (orderType === 'LIMIT') {
      // Passive limit fills experience 0 adverse slippage
      return { executedPrice: price, slippageAmount: 0, slippageBps: 0 };
    }

    let effectiveConfig = config;
    let multiplier = 1.0;

    if (costStressConfig) {
      if (costStressConfig.multiplier !== undefined) {
        if (
          typeof costStressConfig.multiplier !== 'number' ||
          !Number.isFinite(costStressConfig.multiplier) ||
          costStressConfig.multiplier <= 0
        ) {
          throw new Error(
            `INVALID_COST_STRESS_MULTIPLIER: Multiplier must be a positive finite number, got ${costStressConfig.multiplier}`,
          );
        }
      }

      if (costStressConfig.mode === 'NORMAL') {
        if (costStressConfig.multiplier !== undefined && costStressConfig.multiplier !== 1.0) {
          throw new Error(
            `CONFLICTING_COST_STRESS_CONFIG: NORMAL mode cannot have multiplier != 1.0, got ${costStressConfig.multiplier}`,
          );
        }
        multiplier = 1.0;
      } else if (costStressConfig.mode === 'MULTIPLIER') {
        multiplier = costStressConfig.multiplier ?? 1.0;
      } else if (costStressConfig.mode === 'ABSOLUTE') {
        if (costStressConfig.multiplier !== undefined && costStressConfig.multiplier !== 1.0) {
          throw new Error(
            `CONFLICTING_COST_STRESS_CONFIG: ABSOLUTE mode cannot specify multiplier != 1.0, got ${costStressConfig.multiplier}`,
          );
        }
        if (costStressConfig.slippageConfig) {
          effectiveConfig = costStressConfig.slippageConfig;
        }
      }
    }

    let dynamicBps = effectiveConfig.baseSlippageBps;

    if (candle && candle.close > 0) {
      const candleRangeBps = ((candle.high - candle.low) / candle.close) * 10000;
      if (candleRangeBps > 50) {
        dynamicBps += (candleRangeBps / 100) * effectiveConfig.volatilityMultiplier;
      }
    }

    const effectiveBps = Math.min(
      effectiveConfig.maxSlippageBps * multiplier,
      Math.max(0, dynamicBps * multiplier),
    );
    const slippageAmount = Number(((price * effectiveBps) / 10000).toFixed(4));
    const executedPrice =
      side === 'BUY'
        ? Number((price + slippageAmount).toFixed(4))
        : Number((price - slippageAmount).toFixed(4));

    return {
      executedPrice,
      slippageAmount,
      slippageBps: effectiveBps,
    };
  }
}
