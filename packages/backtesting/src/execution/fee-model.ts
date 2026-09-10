import { ExecutionCostStressConfig, IFeeConfig, OrderSide } from './types';

export class FeeModel {
  /**
   * Calculates comprehensive exchange transaction costs, brokerage, turnover, STT/CTT, and taxes,
   * supporting authoritative cost stress testing.
   */
  static calculateFees(
    symbol: string,
    executionPrice: number,
    quantity: number,
    side: OrderSide,
    isMaker = false,
    customConfig?: IFeeConfig,
    costStressConfig?: ExecutionCostStressConfig,
  ): number {
    let effectiveConfig = customConfig;
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
        if (costStressConfig.feeConfig) {
          effectiveConfig = costStressConfig.feeConfig;
        }
      }
    }

    const sym = (symbol || '').toUpperCase();
    const turnover = executionPrice * quantity;
    let baseFee = 0;

    if (effectiveConfig) {
      let fee = effectiveConfig.brokerageFlat ?? 0;
      if (effectiveConfig.brokerageRateBps) {
        fee += (turnover * effectiveConfig.brokerageRateBps) / 10000;
      }
      if (side === 'SELL' && effectiveConfig.sttRateBps) {
        fee += (turnover * effectiveConfig.sttRateBps) / 10000;
      }
      if (effectiveConfig.exchangeTurnoverBps) {
        fee += (turnover * effectiveConfig.exchangeTurnoverBps) / 10000;
      }
      if (effectiveConfig.gstRate && fee > 0) {
        fee += fee * effectiveConfig.gstRate;
      }
      baseFee = fee;
    } else if (sym === 'BTCUSDT' || sym.endsWith('USDT')) {
      // 1. Crypto Asset (BTCUSDT)
      const rate = isMaker ? 0.0002 : 0.0005; // 2 bps maker / 5 bps taker
      baseFee = turnover * rate;
    } else if (sym === 'XAUUSD' || sym === 'GOLD') {
      // 2. Spot Gold / Commodity (XAUUSD / GOLD)
      const rate = isMaker ? 0.00015 : 0.0003; // 1.5 bps maker / 3 bps taker
      baseFee = turnover * rate;
    } else {
      // 3. Indian Index / Equity (NIFTY, BANKNIFTY, RELIANCE, etc.)
      const brokerage = Math.min(20, turnover * 0.0003); // Max ₹20 per executed order
      const stt = side === 'SELL' ? turnover * 0.000125 : 0; // 0.0125% STT on sell side
      const exchangeTurnoverFee = turnover * 0.000019; // NSE turnover charge
      const sebiCharge = turnover * 0.000001; // SEBI regulatory charge
      const gst = (brokerage + exchangeTurnoverFee + sebiCharge) * 0.18; // 18% GST

      baseFee = brokerage + stt + exchangeTurnoverFee + sebiCharge + gst;
    }

    const totalFee = baseFee * multiplier;
    return Number(totalFee.toFixed(4));
  }
}
