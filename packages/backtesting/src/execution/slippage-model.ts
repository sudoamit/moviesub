import { ISlippageConfig, OrderSide, OrderType } from './types';
import { ICandle } from '@quant/shared';

export const DEFAULT_SLIPPAGE_CONFIG: ISlippageConfig = {
  baseSlippageBps: 2.0, // 0.02% base slippage
  volatilityMultiplier: 1.5,
  impactMultiplier: 0.8,
  maxSlippageBps: 25.0, // Cap at 0.25%
};

export class SlippageModel {
  /**
   * Calculates realistic market order execution slippage taking into account volatility and order size
   */
  static calculateSlippage(
    price: number,
    quantity: number,
    side: OrderSide,
    orderType: OrderType,
    candle?: ICandle,
    config: ISlippageConfig = DEFAULT_SLIPPAGE_CONFIG,
  ): { executedPrice: number; slippageAmount: number; slippageBps: number } {
    if (orderType === 'LIMIT') {
      // Passive limit fills experience 0 adverse slippage
      return { executedPrice: price, slippageAmount: 0, slippageBps: 0 };
    }

    let dynamicBps = config.baseSlippageBps;

    if (candle && candle.close > 0) {
      const candleRangeBps = ((candle.high - candle.low) / candle.close) * 10000;
      if (candleRangeBps > 50) {
        dynamicBps += (candleRangeBps / 100) * config.volatilityMultiplier;
      }
    }

    const effectiveBps = Math.min(config.maxSlippageBps, Math.max(0, dynamicBps));
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
