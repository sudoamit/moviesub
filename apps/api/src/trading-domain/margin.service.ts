import { Injectable, Logger } from '@nestjs/common';
import {
  IMarginDomainService,
  MarginCalculationParams,
  MarginCalculationResult,
  MarginMode,
} from '@quant/shared';

@Injectable()
export class MarginService implements IMarginDomainService {
  private readonly logger = new Logger(MarginService.name);

  /**
   * Authoritatively calculates margin requirements, separating Notional Exposure from Margin.
   */
  public calculateMargin(params: MarginCalculationParams): MarginCalculationResult {
    const { instrument, quantity, price, leverage: requestedLeverage, marginMode: requestedMode, fxRate = 1.0 } = params;

    const contractSize = instrument?.contractSize ?? 1;
    const notionalQuote = quantity * price * contractSize;
    const notionalAccount = notionalQuote * fxRate;

    const isSpot =
      instrument?.marginMode === 'SPOT' ||
      requestedMode === 'SPOT' ||
      instrument?.assetType === 'INDEX' ||
      instrument?.symbol?.includes('_SPOT');

    const isOption =
      instrument?.symbol?.includes(' CE') ||
      instrument?.symbol?.includes(' PE') ||
      (instrument as any)?.instrumentType === 'OPTION';

    if (isSpot) {
      return {
        notionalQuote,
        notionalAccount,
        initialMarginRequired: Number(notionalAccount.toFixed(2)),
        maintenanceMarginRequired: Number(notionalAccount.toFixed(2)),
        effectiveLeverage: 1,
        marginMode: 'SPOT',
        liquidationPrice: undefined, // Spot has no derivative liquidation
      };
    }

    if (isOption) {
      // Long option premium model: buyer pays 100% of the premium
      return {
        notionalQuote,
        notionalAccount,
        initialMarginRequired: Number(notionalAccount.toFixed(2)),
        maintenanceMarginRequired: 0,
        effectiveLeverage: 1,
        marginMode: 'SPOT',
        liquidationPrice: undefined,
      };
    }

    // Derivative / Leveraged isolated margin
    const maxInstLev = instrument?.maxLeverage ?? 5;
    const effLeverage = Math.max(1, Math.min(requestedLeverage ?? 1, maxInstLev));
    const initialMarginRate = 1 / effLeverage;
    const maintenanceMarginRate = instrument?.maintenanceMarginRate ?? 0.05;

    const initialMarginRequired = Number((notionalAccount * initialMarginRate).toFixed(2));
    const maintenanceMarginRequired = Number((notionalAccount * maintenanceMarginRate).toFixed(2));

    return {
      notionalQuote,
      notionalAccount,
      initialMarginRequired,
      maintenanceMarginRequired,
      effectiveLeverage: effLeverage,
      marginMode: (requestedMode || instrument?.marginMode || 'ISOLATED') as MarginMode,
    };
  }

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
