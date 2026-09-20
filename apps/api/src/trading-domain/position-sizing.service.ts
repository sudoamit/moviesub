import { Injectable, Logger } from '@nestjs/common';
import {
  IPositionSizingDomainService,
  SizingCalculationParams,
  SizingCalculationResult,
  QuantityValidationResult,
  PriceValidationResult,
  NotionalValidationResult,
} from '@quant/shared';
import { PositionSizer } from '@quant/risk-engine';

@Injectable()
export class PositionSizingService implements IPositionSizingDomainService {
  private readonly logger = new Logger(PositionSizingService.name);

  /**
   * One authoritative function to floor value to step size.
   * Never rounds upward to prevent silently increasing order risk or exposure.
   */
  public floorToStep(value: number, step: number): number {
    if (!Number.isFinite(value) || value <= 0) return 0;
    if (!Number.isFinite(step) || step <= 0) return value;
    // Account for floating point epsilon before floor
    const steps = Math.floor((value + 1e-9) / step);
    const floored = steps * step;
    // Determine precision from step
    const stepStr = step.toString();
    const precision = stepStr.includes('.') ? stepStr.split('.')[1].length : 0;
    return Number(floored.toFixed(precision));
  }

  /**
   * One authoritative function to normalize price to tick size.
   */
  public normalizePriceToTick(price: number, tickSize: number): number {
    if (!Number.isFinite(price) || price <= 0) return 0;
    if (!Number.isFinite(tickSize) || tickSize <= 0) return price;
    const ticks = Math.round(price / tickSize);
    const normalized = ticks * tickSize;
    const tickStr = tickSize.toString();
    const precision = tickStr.includes('.') ? tickStr.split('.')[1].length : 0;
    return Number(normalized.toFixed(precision));
  }

  /**
   * Validates calculated quantity against instrument parameters.
   * If calculated quantity is below minimum executable quantity: REJECT (never increase to min).
   */
  public validateQuantity(
    quantity: number,
    minQuantity: number,
    stepSize: number,
    maxQuantity?: number,
  ): QuantityValidationResult {
    if (!Number.isFinite(quantity) || quantity <= 0) {
      return {
        isValid: false,
        normalizedQuantity: 0,
        reason: `Quantity must be a positive finite number. Got: ${quantity}`,
        code: 'ZERO_OR_NEGATIVE',
      };
    }

    if (quantity < minQuantity) {
      return {
        isValid: false,
        normalizedQuantity: 0,
        reason: `Calculated quantity (${quantity}) is below minimum executable quantity (${minQuantity}). Rejected to prevent risk expansion.`,
        code: 'BELOW_MIN_QUANTITY',
      };
    }

    if (maxQuantity && maxQuantity > 0 && quantity > maxQuantity) {
      return {
        isValid: false,
        normalizedQuantity: maxQuantity,
        reason: `Calculated quantity (${quantity}) exceeds maximum allowed quantity (${maxQuantity}).`,
        code: 'EXCEEDS_MAX_QUANTITY',
      };
    }

    const floored = this.floorToStep(quantity, stepSize);
    if (floored < minQuantity) {
      return {
        isValid: false,
        normalizedQuantity: 0,
        reason: `Floored quantity (${floored}) after applying step size (${stepSize}) fell below minimum executable quantity (${minQuantity}).`,
        code: 'BELOW_MIN_QUANTITY',
      };
    }

    return {
      isValid: true,
      normalizedQuantity: floored,
      code: 'VALID',
    };
  }

  public validatePrice(price: number, tickSize: number): PriceValidationResult {
    if (!Number.isFinite(price) || price <= 0) {
      return {
        isValid: false,
        normalizedPrice: 0,
        reason: `Price must be positive and finite. Got: ${price}`,
        code: 'ZERO_OR_NEGATIVE',
      };
    }

    const normalized = this.normalizePriceToTick(price, tickSize);
    return {
      isValid: true,
      normalizedPrice: normalized,
      code: 'VALID',
    };
  }

  public validateNotional(notional: number, minNotional?: number): NotionalValidationResult {
    if (!minNotional || minNotional <= 0) {
      return { isValid: true, notional, code: 'VALID' };
    }
    if (notional < minNotional) {
      return {
        isValid: false,
        notional,
        reason: `Notional value (${notional}) is below minimum required notional (${minNotional})`,
        code: 'BELOW_MIN_NOTIONAL',
      };
    }
    return { isValid: true, notional, code: 'VALID' };
  }

  /**
   * Authoritatively computes position sizing via configured model.
   */
  public calculateSizing(params: SizingCalculationParams): SizingCalculationResult {
    const {
      sizingModel,
      accountBalance,
      riskPercentage = 1.0,
      entryPrice,
      stopLoss,
      symbol,
      instrument,
      lots = 1,
      fixedNotional,
      leverage = 1,
      availableMargin,
      fxRate = 1.0,
    } = params;

    const contractSize = instrument?.contractSize ?? 1;
    const lotSize = instrument?.lotSize ?? 1;
    const minQty = instrument?.minimumQuantity ?? lotSize;
    const stepSize = instrument?.lotSize ?? 1;

    let targetQuantity = 0;

    if (sizingModel === 'FIXED_LOTS') {
      targetQuantity = lots * lotSize;
    } else if (sizingModel === 'FIXED_NOTIONAL') {
      if (!fixedNotional || fixedNotional <= 0) {
        return {
          isValid: false,
          quantity: 0,
          lotCount: 0,
          notionalQuote: 0,
          notionalAccount: 0,
          riskAmountAccount: 0,
          riskPerUnitAccount: 0,
          requiredMarginAccount: 0,
          rejectionReason: 'Fixed notional must be positive',
          code: 'INVALID_NOTIONAL',
        };
      }
      targetQuantity = fixedNotional / (entryPrice * contractSize);
    } else {
      // RISK_PERCENT model
      const sizing = PositionSizer.calculatePosition({
        accountBalance,
        riskPercentage,
        entryPrice,
        stopLoss,
        symbol,
        instrument,
        leverage,
        availableMargin,
      });

      if (!sizing.isValid) {
        return {
          isValid: false,
          quantity: 0,
          lotCount: 0,
          notionalQuote: 0,
          notionalAccount: 0,
          riskAmountAccount: sizing.riskAmount ?? 0,
          riskPerUnitAccount: sizing.riskPerUnit ?? 0,
          requiredMarginAccount: sizing.initialMarginRequired ?? 0,
          rejectionReason: sizing.rejectionReason,
          code: 'SIZING_REJECTED',
        };
      }
      targetQuantity = sizing.roundedUnits;
    }

    // Authoritatively validate quantity
    const validation = this.validateQuantity(targetQuantity, minQty, stepSize);
    if (!validation.isValid) {
      return {
        isValid: false,
        quantity: 0,
        lotCount: 0,
        notionalQuote: 0,
        notionalAccount: 0,
        riskAmountAccount: 0,
        riskPerUnitAccount: 0,
        requiredMarginAccount: 0,
        rejectionReason: validation.reason,
        code: validation.code,
      };
    }

    const finalQty = validation.normalizedQuantity;
    const notionalQuote = finalQty * entryPrice * contractSize;
    const notionalAccount = notionalQuote * fxRate;
    const riskPerUnitAccount = Math.abs(entryPrice - stopLoss) * contractSize * fxRate;
    const riskAmountAccount = finalQty * riskPerUnitAccount;
    const effLeverage = instrument?.marginMode === 'SPOT' ? 1 : Math.max(1, leverage);
    const requiredMarginAccount = notionalAccount / effLeverage;

    return {
      isValid: true,
      quantity: finalQty,
      lotCount: lotSize > 0 ? Math.floor(finalQty / lotSize) : 1,
      notionalQuote,
      notionalAccount,
      riskAmountAccount,
      riskPerUnitAccount,
      requiredMarginAccount,
    };
  }
}
