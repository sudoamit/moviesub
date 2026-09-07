import { ISpreadConfig } from './types';

export const DEFAULT_SPREAD_CONFIG: ISpreadConfig = {
  baseSpreadBps: 1.5, // 0.015%
  illiquidMultiplier: 2.5,
};

export class SpreadModel {
  /**
   * Calculates realistic market bid-ask half-spread
   */
  static getHalfSpread(
    price: number,
    symbol: string,
    config: ISpreadConfig = DEFAULT_SPREAD_CONFIG,
  ): number {
    const sym = (symbol || '').toUpperCase();
    let spreadBps = config.baseSpreadBps;

    if (sym === 'NIFTY' || sym === 'BANKNIFTY') {
      spreadBps = 0.5; // Very tight liquid index spread (0.005%)
    } else if (sym === 'BTCUSDT' || sym === 'XAUUSD') {
      spreadBps = 1.0; // Tight crypto/gold spread
    }

    return Number(((price * spreadBps) / (2 * 10000)).toFixed(4));
  }
}
