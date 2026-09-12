import { Direction, isLongPosition, MarginMode } from '@quant/shared';

export interface ITradeMarginCalculation {
  positionNotionalQuote: number;
  positionNotionalAccount: number; // in INR
  initialMarginRequired: number; // in INR
  maintenanceMarginRequired: number; // in INR
  leverage: number;
  marginMode: MarginMode;
}

export interface ITradePnlCalculation {
  grossPnlQuote: number;
  grossPnlAccount: number; // in INR
  netPnlAccount: number; // in INR
  realizedR: number;
  fees: number;
  slippage: number;
}

export class TradeAccountingEngine {
  /**
   * Calculates notional values in both quote currency and INR account currency.
   */
  static calculateNotional(
    quantity: number,
    price: number,
    contractSize = 1,
    fxRate = 1.0,
  ): { notionalQuote: number; notionalAccount: number } {
    if (quantity < 0 || price < 0 || contractSize <= 0 || fxRate <= 0) {
      throw new Error(
        `INVALID_NOTIONAL_INPUTS: quantity (${quantity}), price (${price}), contractSize (${contractSize}), fxRate (${fxRate}) must be valid positive values`,
      );
    }
    const notionalQuote = Number((quantity * price * contractSize).toFixed(4));
    const notionalAccount = Number((notionalQuote * fxRate).toFixed(2));
    return { notionalQuote, notionalAccount };
  }

  /**
   * Authoritatively calculates Initial and Maintenance Margin in INR.
   * REMOVES ALL HARDCODED /5 ASSUMPTIONS.
   */
  static calculateMargin(
    notionalAccount: number,
    leverage = 1,
    marginMode: MarginMode = 'ISOLATED',
    initialMarginRate?: number,
    maintenanceMarginRate = 0.05,
  ): { initialMarginRequired: number; maintenanceMarginRequired: number } {
    if (notionalAccount <= 0) {
      return { initialMarginRequired: 0, maintenanceMarginRequired: 0 };
    }

    let initialMarginRequired: number;

    if (marginMode === 'SPOT') {
      initialMarginRequired = notionalAccount;
    } else {
      const effLeverage = Math.max(1, leverage);
      initialMarginRequired = notionalAccount / effLeverage;
    }

    const maintenanceMarginRequired = notionalAccount * Math.max(0, maintenanceMarginRate);

    return {
      initialMarginRequired: Number(initialMarginRequired.toFixed(2)),
      maintenanceMarginRequired: Number(maintenanceMarginRequired.toFixed(2)),
    };
  }

  /**
   * Calculates isolated margin liquidation threshold price.
   * Strictly distinct from stop-loss.
   */
  static calculateLiquidationPrice(
    entryPrice: number,
    direction: Direction | string,
    leverage = 1,
    maintenanceMarginRate = 0.025,
  ): number {
    if (entryPrice <= 0 || leverage <= 0) return 0;
    if (leverage <= 1) return 0; // 1x spot/cash cannot be liquidated from leverage

    const isLong = isLongPosition(direction as any);
    const mmr = Math.max(0, maintenanceMarginRate);
    const marginRatio = 1.0 / leverage;

    if (isLong) {
      // Long liquidation occurs when price drops below entry * (1 - 1/leverage + MMR)
      const liq = entryPrice * (1.0 - marginRatio + mmr);
      return Number(Math.max(0, liq).toFixed(4));
    } else {
      // Short liquidation occurs when price rises above entry * (1 + 1/leverage - MMR)
      const liq = entryPrice * (1.0 + marginRatio - mmr);
      return Number(liq.toFixed(4));
    }
  }

  /**
   * Calculates authoritative stop-based risk in INR.
   * INVARIANT: Risk is stop-based and independent of leverage.
   */
  static calculateStopRisk(
    entryPrice: number,
    stopLoss: number,
    quantity: number,
    contractSize = 1,
    fxRate = 1.0,
  ): number {
    const stopDistance = Math.abs(entryPrice - stopLoss);
    const riskQuote = stopDistance * quantity * contractSize;
    const riskAccount = riskQuote * fxRate;
    return Number(riskAccount.toFixed(2));
  }

  /**
   * Calculates gross and net P&L with point-in-time FX conversion.
   * INVARIANT: Changing leverage DOES NOT change fixed-position gross P&L.
   */
  static calculateTradePnl(
    entryPrice: number,
    exitPrice: number,
    quantity: number,
    direction: Direction | string,
    contractSize = 1,
    fxRate = 1.0,
    fees = 0,
    slippage = 0,
    initialRiskAccount = 0,
  ): ITradePnlCalculation {
    const isLong = isLongPosition(direction as any);
    const priceDiff = isLong ? exitPrice - entryPrice : entryPrice - exitPrice;
    const grossPnlQuote = Number((priceDiff * quantity * contractSize).toFixed(4));
    const grossPnlAccount = Number((grossPnlQuote * fxRate).toFixed(2));
    const netPnlAccount = Number((grossPnlAccount - fees).toFixed(2));

    const effRisk = Math.max(1, initialRiskAccount > 0 ? initialRiskAccount : Math.abs(grossPnlAccount));
    const realizedR = Number((netPnlAccount / effRisk).toFixed(2));

    return {
      grossPnlQuote,
      grossPnlAccount,
      netPnlAccount,
      realizedR,
      fees,
      slippage,
    };
  }
}
