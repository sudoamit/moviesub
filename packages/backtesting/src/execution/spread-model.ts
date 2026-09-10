import { ExecutionCostStressConfig, ISpreadConfig } from './types';

export const DEFAULT_SPREAD_CONFIG: ISpreadConfig = {
  baseSpreadBps: 1.5, // 0.015%
  illiquidMultiplier: 2.5,
};

export class SpreadModel {
  /**
   * Calculates realistic market bid-ask half-spread with authoritative cost stress multiplier
   */
  static getHalfSpread(
    price: number,
    symbol: string,
    config: ISpreadConfig = DEFAULT_SPREAD_CONFIG,
    costStressConfig?: ExecutionCostStressConfig,
  ): number {
    let effectiveConfig = config;
    let multiplier = 1.0;

    if (costStressConfig) {
      if (costStressConfig.multiplier !== undefined) {
        if (
          typeof costStressConfig.multiplier !== 'number' ||
          !Number.isFinite(costStressConfig.multiplier) ||
          costStressConfig.multiplier < 0
        ) {
          throw new Error(
            `INVALID_COST_STRESS_MULTIPLIER: Multiplier must be a non-negative finite number, got ${costStressConfig.multiplier}`,
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
        if (costStressConfig.spreadConfig) {
          effectiveConfig = costStressConfig.spreadConfig;
        }
      }
    }

    const sym = (symbol || '').toUpperCase();
    let spreadBps = effectiveConfig.baseSpreadBps;

    if (sym === 'NIFTY' || sym === 'BANKNIFTY') {
      spreadBps = 0.5; // Very tight liquid index spread (0.005%)
    } else if (sym === 'BTCUSDT' || sym === 'XAUUSD') {
      spreadBps = 1.0; // Tight crypto/gold spread
    }

    const effectiveSpreadBps = spreadBps * multiplier;
    return Number(((price * effectiveSpreadBps) / (2 * 10000)).toFixed(4));
  }
}
