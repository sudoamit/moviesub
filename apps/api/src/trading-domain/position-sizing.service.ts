import { Injectable, Logger } from '@nestjs/common';
import {
  IPositionSizingDomainService,
  SizingCalculationParams,
  SizingCalculationResult,
  QuantityValidationResult,
  PriceValidationResult,
  NotionalValidationResult,
} from '@quant/shared';

@Injectable()
export class PositionSizingService implements IPositionSizingDomainService {
  private readonly logger = new Logger(PositionSizingService.name);

  /**
   * Helper to safely extract numeric values from number, string, or DecimalLike objects.
   */
  private toNum(val: any, fallback = 0): number {
    if (val === undefined || val === null) return fallback;
    if (typeof val === 'number') return Number.isFinite(val) ? val : fallback;
    if (typeof val.toNumber === 'function') {
      try {
        return val.toNumber();
      } catch {
        return fallback;
      }
    }
    const parsed = parseFloat(String(val));
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  /**
   * One authoritative function to floor value to step size.
   * Never rounds upward to prevent silently increasing order risk or exposure.
   */
  public floorToStep(value: number, step: number): number {
    if (!Number.isFinite(value) || value <= 0) return 0;
    if (!Number.isFinite(step) || step <= 0) return value;

    // Account for floating point epsilon before floor to prevent precision truncation
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
   * Authoritatively computes position sizing via configured model:
   * - FIXED_LOTS
   * - RISK_PERCENT
   * - FIXED_NOTIONAL
   * - VOLATILITY_TARGET
   * Strictly enforces step flooring, min/max quantity, and minimum notional.
   */
  public calculateSizing(params: SizingCalculationParams): SizingCalculationResult {
    const {
      sizingModel,
      accountBalance,
      riskPercentage = 1.0,
      entryPrice,
      stopLoss,
      instrument,
      lots = 1,
      fixedNotional,
      targetVolatility,
      annualizedVol,
      leverage = 1,
      availableMargin,
      fxRate = 1.0,
    } = params;

    if (!Number.isFinite(accountBalance) || accountBalance <= 0) {
      return this.reject('Account balance must be positive', 'INVALID_ACCOUNT_BALANCE');
    }
    if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
      return this.reject('Entry price must be positive', 'INVALID_ENTRY_PRICE');
    }

    // Extract instrument parameters supporting both IInstrument and InstrumentDefinition
    const contractSize = this.toNum(instrument?.contractSize, 1);
    const lotSize = this.toNum(instrument?.lotSize, 1);
    const minQty = this.toNum(
      (instrument as any)?.minQuantity ?? (instrument as any)?.minimumQuantity,
      lotSize > 0 ? lotSize : 1,
    );
    const maxQty = this.toNum((instrument as any)?.maxQuantity, 0);
    const stepSize = this.toNum(
      (instrument as any)?.quantityStep ?? (instrument as any)?.lotSize,
      lotSize > 0 ? lotSize : 1,
    );
    const minNotional = this.toNum((instrument as any)?.minNotional, 0);

    let targetQuantity = 0;

    // 1. FIXED_LOTS Model
    if (sizingModel === 'FIXED_LOTS') {
      if (!Number.isFinite(lots) || lots <= 0) {
        return this.reject('Lots must be a positive number', 'INVALID_LOTS');
      }
      targetQuantity = lots * lotSize;
    }
    // 2. FIXED_NOTIONAL Model
    else if (sizingModel === 'FIXED_NOTIONAL') {
      if (!fixedNotional || fixedNotional <= 0) {
        return this.reject('Fixed notional must be positive', 'INVALID_NOTIONAL');
      }
      const unitValueAccount = entryPrice * contractSize * fxRate;
      if (unitValueAccount <= 0) {
        return this.reject('Unit value in account currency is non-positive', 'INVALID_UNIT_VALUE');
      }
      targetQuantity = fixedNotional / unitValueAccount;
    }
    // 3. VOLATILITY_TARGET Model
    else if (sizingModel === 'VOLATILITY_TARGET') {
      const targetVol = targetVolatility ?? 10.0; // Target 10% annual volatility
      const annVol = annualizedVol ?? 0.20; // Default 20% instrument volatility
      if (targetVol <= 0 || annVol <= 0) {
        return this.reject('Volatility parameters must be positive', 'INVALID_VOLATILITY');
      }
      const targetRiskBudgetAccount = accountBalance * (targetVol / 100);
      const unitVolAccount = entryPrice * contractSize * annVol * fxRate;
      targetQuantity = targetRiskBudgetAccount / unitVolAccount;
    }
    // 4. RISK_PERCENT Model
    else {
      const stopDistance = Math.abs(entryPrice - stopLoss);
      if (stopDistance <= 0 || !Number.isFinite(stopDistance)) {
        return this.reject('Stop loss must not equal entry price', 'INVALID_STOP_LOSS');
      }

      const riskPerUnitAccount = stopDistance * contractSize * fxRate;
      if (riskPerUnitAccount <= 0) {
        return this.reject('Risk per unit in account currency is zero or invalid', 'INVALID_RISK_PER_UNIT');
      }

      const allowedRiskAccount = accountBalance * (riskPercentage / 100);
      targetQuantity = allowedRiskAccount / riskPerUnitAccount;
    }

    // Authoritatively validate quantity (REJECTS if below minQuantity, never rounds up)
    const validation = this.validateQuantity(targetQuantity, minQty, stepSize, maxQty > 0 ? maxQty : undefined);
    if (!validation.isValid) {
      return this.reject(validation.reason || 'Quantity validation failed', validation.code || 'QUANTITY_REJECTED');
    }

    const finalQty = validation.normalizedQuantity;
    const notionalQuote = finalQty * entryPrice * contractSize;
    const notionalAccount = notionalQuote * fxRate;

    // Validate minimum notional threshold
    if (minNotional > 0) {
      const notionalValidation = this.validateNotional(notionalQuote, minNotional);
      if (!notionalValidation.isValid) {
        return this.reject(
          notionalValidation.reason || `Notional value below minimum required: ${minNotional}`,
          'BELOW_MIN_NOTIONAL',
        );
      }
    }

    const stopDistance = Math.abs(entryPrice - stopLoss);
    const riskPerUnitAccount = stopDistance * contractSize * fxRate;
    const riskAmountAccount = finalQty * riskPerUnitAccount;

    const effLeverage = (instrument as any)?.marginModel === 'SPOT' ? 1 : Math.max(1, leverage);
    const requiredMarginAccount = notionalAccount / effLeverage;

    // Margin check if available margin is specified
    if (availableMargin !== undefined && availableMargin > 0 && requiredMarginAccount > availableMargin) {
      return this.reject(
        `Required margin (${requiredMarginAccount.toFixed(2)}) exceeds available margin (${availableMargin.toFixed(2)})`,
        'INSUFFICIENT_MARGIN',
      );
    }

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

  private reject(reason: string, code: string): SizingCalculationResult {
    return {
      isValid: false,
      quantity: 0,
      lotCount: 0,
      notionalQuote: 0,
      notionalAccount: 0,
      riskAmountAccount: 0,
      riskPerUnitAccount: 0,
      requiredMarginAccount: 0,
      rejectionReason: reason,
      code,
    };
  }
}
