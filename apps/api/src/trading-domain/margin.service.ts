import { Injectable, Logger } from '@nestjs/common';
import {
  Direction,
  IMarginDomainService,
  LiquidationCalculationParams,
  MarginCalculationParams,
  MarginCalculationResult,
  MarginMode,
  PositionSide,
} from '@quant/shared';

@Injectable()
export class MarginService implements IMarginDomainService {
  private readonly logger = new Logger(MarginService.name);

  /**
   * Authoritatively calculates margin requirements, separating Notional Exposure, Margin, and Risk.
   */
  public calculateMargin(params: MarginCalculationParams): MarginCalculationResult {
    const {
      instrument,
      quantity,
      price,
      direction = PositionSide.LONG,
      leverage: requestedLeverage,
      marginMode: requestedMode,
      fxRate = 1.0,
      markPrice,
      stopLoss,
      fundingRate,
      accountCashBalance,
      currentUsedMargin = 0,
    } = params;

    const contractSize = instrument?.contractSize ?? 1;
    const notionalQuote = Number((quantity * price * contractSize).toFixed(2));
    const notionalAccount = Number((notionalQuote * fxRate).toFixed(2));
    const notionalValue = notionalAccount;

    const isSpot =
      instrument?.marginMode === 'SPOT' ||
      requestedMode === 'SPOT' ||
      instrument?.assetType === 'SPOT' ||
      instrument?.assetType === 'INDEX' ||
      instrument?.symbol?.includes('_SPOT');

    const isOption =
      instrument?.symbol?.includes(' CE') ||
      instrument?.symbol?.includes(' PE') ||
      (instrument as any)?.instrumentType === 'OPTION' ||
      instrument?.assetType === 'OPTION';

    // Calculate Risk Amount if stopLoss is present
    const riskAmount =
      stopLoss !== undefined && stopLoss !== null
        ? Number((Math.abs(price - stopLoss) * quantity * contractSize * fxRate).toFixed(2))
        : undefined;

    // Calculate Funding Payment if fundingRate is present
    const fundingPayment =
      fundingRate !== undefined && fundingRate !== null
        ? this.calculateFundingPayment(notionalAccount, fundingRate)
        : undefined;

    if (isSpot) {
      const initialMarginRequired = Number(notionalAccount.toFixed(2));
      const maintenanceMarginRequired = Number(notionalAccount.toFixed(2));
      const usedMargin =
        accountCashBalance !== undefined ? currentUsedMargin + initialMarginRequired : undefined;
      const availableMargin =
        accountCashBalance !== undefined
          ? Math.max(0, accountCashBalance - (usedMargin ?? 0))
          : undefined;

      return {
        notionalQuote,
        notionalAccount,
        notionalValue,
        initialMarginRequired,
        initialMargin: initialMarginRequired,
        maintenanceMarginRequired,
        maintenanceMargin: maintenanceMarginRequired,
        effectiveLeverage: 1,
        marginMode: 'SPOT',
        liquidationPrice: undefined, // Spot has no derivative liquidation
        usedMargin,
        availableMargin,
        riskAmount,
        markPrice: markPrice ?? price,
        marginRatio: undefined,
        fundingRate,
        fundingPayment: undefined, // Spot has no funding payments
      };
    }

    if (isOption) {
      // Long option premium model: buyer pays 100% of the premium
      const initialMarginRequired = Number(notionalAccount.toFixed(2));
      const maintenanceMarginRequired = 0;
      const usedMargin =
        accountCashBalance !== undefined ? currentUsedMargin + initialMarginRequired : undefined;
      const availableMargin =
        accountCashBalance !== undefined
          ? Math.max(0, accountCashBalance - (usedMargin ?? 0))
          : undefined;

      return {
        notionalQuote,
        notionalAccount,
        notionalValue,
        initialMarginRequired,
        initialMargin: initialMarginRequired,
        maintenanceMarginRequired,
        maintenanceMargin: maintenanceMarginRequired,
        effectiveLeverage: 1,
        marginMode: 'SPOT',
        liquidationPrice: undefined,
        usedMargin,
        availableMargin,
        riskAmount,
        markPrice: markPrice ?? price,
        marginRatio: undefined,
        fundingRate: undefined,
        fundingPayment: undefined,
      };
    }

    // Derivative / Leveraged isolated/cross margin
    const maxInstLev = instrument?.maxLeverage ?? 20;
    const effLeverage = Math.max(1, Math.min(requestedLeverage ?? 1, maxInstLev));
    const initialMarginRate = 1 / effLeverage;
    const maintenanceMarginRate = instrument?.maintenanceMarginRate ?? 0.05;

    const initialMarginRequired = Number((notionalAccount * initialMarginRate).toFixed(2));
    const maintenanceMarginRequired = Number((notionalAccount * maintenanceMarginRate).toFixed(2));

    const liquidationPrice =
      effLeverage > 1
        ? this.calculateLiquidationPrice({
            entryPrice: price,
            leverage: effLeverage,
            maintenanceMarginRate,
            direction,
          })
        : undefined;

    const usedMargin =
      accountCashBalance !== undefined ? currentUsedMargin + initialMarginRequired : undefined;
    const availableMargin =
      accountCashBalance !== undefined
        ? Math.max(0, accountCashBalance - (usedMargin ?? 0))
        : undefined;
    const marginRatio =
      accountCashBalance !== undefined
        ? this.calculateMarginRatio(maintenanceMarginRequired, accountCashBalance)
        : undefined;

    return {
      notionalQuote,
      notionalAccount,
      notionalValue,
      initialMarginRequired,
      initialMargin: initialMarginRequired,
      maintenanceMarginRequired,
      maintenanceMargin: maintenanceMarginRequired,
      effectiveLeverage: effLeverage,
      marginMode: (requestedMode || instrument?.marginMode || 'ISOLATED') as MarginMode,
      liquidationPrice,
      usedMargin,
      availableMargin,
      riskAmount,
      markPrice: markPrice ?? price,
      marginRatio,
      fundingRate,
      fundingPayment,
    };
  }

  /**
   * Calculates liquidation price for leveraged derivative positions.
   * Long: entryPrice * (1 - 1/leverage + MMR)
   * Short: entryPrice * (1 + 1/leverage - MMR)
   */
  public calculateLiquidationPrice(params: LiquidationCalculationParams): number | undefined {
    const { entryPrice, leverage, maintenanceMarginRate, direction } = params;
    if (!entryPrice || entryPrice <= 0 || !leverage || leverage <= 1) {
      return undefined;
    }

    const isShort =
      direction === PositionSide.SHORT ||
      direction === Direction.BEARISH ||
      direction === 'SHORT' ||
      direction === 'SELL';

    if (isShort) {
      const rawLiq = entryPrice * (1 + 1 / leverage - maintenanceMarginRate);
      return Number(rawLiq.toFixed(2));
    } else {
      const rawLiq = entryPrice * (1 - 1 / leverage + maintenanceMarginRate);
      return Math.max(0, Number(rawLiq.toFixed(2)));
    }
  }

  /**
   * Calculates Margin Ratio = Maintenance Margin / Margin Equity.
   * Margin call or liquidation is triggered when Margin Ratio >= 1.0.
   */
  public calculateMarginRatio(maintenanceMargin: number, marginEquity: number): number {
    if (marginEquity <= 0) {
      return maintenanceMargin > 0 ? 1.0 : 0;
    }
    return Number((maintenanceMargin / marginEquity).toFixed(4));
  }

  /**
   * Calculates Funding Payment = Notional Value * Funding Rate.
   */
  public calculateFundingPayment(notionalValue: number, fundingRate: number): number {
    return Number((notionalValue * fundingRate).toFixed(4));
  }

  /**
   * Validates if available margin covers required margin plus fee buffer.
   */
  public validateMarginSufficiency(
    availableMargin: number,
    requiredMargin: number,
    charges = 0,
  ): { sufficient: boolean; deficit: number } {
    const totalRequired = requiredMargin + charges;
    if (availableMargin >= totalRequired) {
      return { sufficient: true, deficit: 0 };
    }
    return {
      sufficient: false,
      deficit: Number((totalRequired - availableMargin).toFixed(2)),
    };
  }
}
