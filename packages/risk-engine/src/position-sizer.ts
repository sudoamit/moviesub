import { IPositionSizing } from '@quant/shared';

export interface ICalculatePositionOptions {
  accountBalance: number;
  riskPercentage?: number; // e.g. 1.0 (1%)
  entryPrice: number;
  stopLoss: number;
  lotSize?: number;
  contractSize?: number;
  maxRiskPercentage?: number;
  maxLeverage?: number;
}

export class PositionSizer {
  /**
   * Deterministically calculates institutional position size based on strict fixed percentage risk
   */
  static calculatePosition(options: ICalculatePositionOptions): IPositionSizing {
    const {
      accountBalance,
      riskPercentage = 1.0,
      entryPrice,
      stopLoss,
      lotSize = 1,
      contractSize = 1,
      maxRiskPercentage = 2.5,
      maxLeverage = 10,
    } = options;

    if (accountBalance <= 0) {
      return this.createInvalid(options, 'Account balance must be positive');
    }

    if (riskPercentage <= 0) {
      return this.createInvalid(options, 'Risk percentage must be positive');
    }

    if (riskPercentage > maxRiskPercentage) {
      return this.createInvalid(
        options,
        `Risk percentage (${riskPercentage}%) exceeds maximum allowable risk limit (${maxRiskPercentage}%)`,
      );
    }

    if (entryPrice <= 0 || stopLoss <= 0) {
      return this.createInvalid(options, 'Entry price and stop loss must be greater than zero');
    }

    const riskPerUnit = Math.abs(entryPrice - stopLoss);
    if (riskPerUnit <= 0) {
      return this.createInvalid(options, 'Entry price cannot equal stop loss (risk per unit is 0)');
    }

    const riskAmount = accountBalance * (riskPercentage / 100);
    const calculatedUnits = (riskAmount / riskPerUnit) * contractSize;

    // Floor to instrument lot size
    const effectiveLotSize = Math.max(1, lotSize);
    let roundedUnits = Math.floor(calculatedUnits / effectiveLotSize) * effectiveLotSize;

    // Must be at least 1 lot if calculated units are valid
    if (roundedUnits === 0 && calculatedUnits >= effectiveLotSize * 0.5) {
      roundedUnits = effectiveLotSize;
    }

    const totalPositionValue = roundedUnits * entryPrice;
    const maximumLoss = roundedUnits * riskPerUnit;

    // Leverage safety limit
    if (totalPositionValue > accountBalance * maxLeverage) {
      return {
        accountBalance,
        riskPercentage,
        riskAmount: Number(riskAmount.toFixed(2)),
        entryPrice,
        stopLoss,
        riskPerUnit: Number(riskPerUnit.toFixed(4)),
        calculatedUnits: Number(calculatedUnits.toFixed(4)),
        lotSize: effectiveLotSize,
        roundedUnits,
        totalPositionValue: Number(totalPositionValue.toFixed(2)),
        maximumLoss: Number(maximumLoss.toFixed(2)),
        isValid: false,
        rejectionReason: `Position value (${totalPositionValue.toFixed(2)}) exceeds maximum allowable account leverage (${maxLeverage}x)`,
      };
    }

    return {
      accountBalance,
      riskPercentage,
      riskAmount: Number(riskAmount.toFixed(2)),
      entryPrice,
      stopLoss,
      riskPerUnit: Number(riskPerUnit.toFixed(4)),
      calculatedUnits: Number(calculatedUnits.toFixed(4)),
      lotSize: effectiveLotSize,
      roundedUnits,
      totalPositionValue: Number(totalPositionValue.toFixed(2)),
      maximumLoss: Number(maximumLoss.toFixed(2)),
      isValid: roundedUnits > 0,
      rejectionReason: roundedUnits > 0 ? undefined : 'Calculated position size is smaller than minimum tradeable lot size',
    };
  }

  private static createInvalid(
    options: ICalculatePositionOptions,
    rejectionReason: string,
  ): IPositionSizing {
    return {
      accountBalance: options.accountBalance || 0,
      riskPercentage: options.riskPercentage || 0,
      riskAmount: 0,
      entryPrice: options.entryPrice || 0,
      stopLoss: options.stopLoss || 0,
      riskPerUnit: 0,
      calculatedUnits: 0,
      lotSize: options.lotSize || 1,
      roundedUnits: 0,
      totalPositionValue: 0,
      maximumLoss: 0,
      isValid: false,
      rejectionReason,
    };
  }
}
