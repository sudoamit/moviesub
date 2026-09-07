import { IFeeConfig, OrderSide } from './types';

export class FeeModel {
  /**
   * Calculates comprehensive exchange transaction costs, brokerage, turnover, STT/CTT, and taxes
   */
  static calculateFees(
    symbol: string,
    executionPrice: number,
    quantity: number,
    side: OrderSide,
    isMaker = false,
    customConfig?: IFeeConfig,
  ): number {
    const sym = (symbol || '').toUpperCase();
    const turnover = executionPrice * quantity;

    if (customConfig) {
      let fee = customConfig.brokerageFlat ?? 0;
      if (customConfig.brokerageRateBps) {
        fee += (turnover * customConfig.brokerageRateBps) / 10000;
      }
      if (side === 'SELL' && customConfig.sttRateBps) {
        fee += (turnover * customConfig.sttRateBps) / 10000;
      }
      if (customConfig.exchangeTurnoverBps) {
        fee += (turnover * customConfig.exchangeTurnoverBps) / 10000;
      }
      if (customConfig.gstRate && fee > 0) {
        fee += fee * customConfig.gstRate;
      }
      return Number(fee.toFixed(2));
    }

    // 1. Crypto Asset (BTCUSDT)
    if (sym === 'BTCUSDT' || sym.endsWith('USDT')) {
      const rate = isMaker ? 0.0002 : 0.0005; // 2 bps maker / 5 bps taker
      return Number((turnover * rate).toFixed(4));
    }

    // 2. Spot Gold / Commodity (XAUUSD / GOLD)
    if (sym === 'XAUUSD' || sym === 'GOLD') {
      const rate = isMaker ? 0.00015 : 0.0003; // 1.5 bps maker / 3 bps taker
      return Number((turnover * rate).toFixed(2));
    }

    // 3. Indian Index / Equity (NIFTY, BANKNIFTY, RELIANCE, etc.)
    const brokerage = Math.min(20, turnover * 0.0003); // Max ₹20 per executed order
    const stt = side === 'SELL' ? turnover * 0.000125 : 0; // 0.0125% STT on sell side
    const exchangeTurnoverFee = turnover * 0.000019; // NSE turnover charge
    const sebiCharge = turnover * 0.000001; // SEBI regulatory charge
    const gst = (brokerage + exchangeTurnoverFee + sebiCharge) * 0.18; // 18% GST

    const totalFees = brokerage + stt + exchangeTurnoverFee + sebiCharge + gst;
    return Number(totalFees.toFixed(2));
  }
}
