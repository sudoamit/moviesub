import {
  CurrencyCode,
  getAuthoritativeInstrument,
  hasInstrument,
  IFxConversionResult,
  IInstrument,
  IPositionSizing,
  MarginMode,
  PointInTimeCurrencyConverter,
} from '@quant/shared';
import { TradeAccountingEngine } from './trade-accounting-engine';

export interface ICalculatePositionOptions {
  accountBalance: number;
  riskPercentage?: number; // e.g. 1.0 (1%)
  entryPrice: number;
  stopLoss: number;
  symbol?: string;
  instrument?: IInstrument | string;
  direction?: 'BUY' | 'SELL' | 'LONG' | 'SHORT' | string;
  lotSize?: number;
  contractSize?: number;
  maxRiskPercentage?: number;
  maxLeverage?: number;
  leverage?: number;
  requestedLeverage?: number;
  marginMode?: MarginMode;
  availableMargin?: number;
  timestamp?: number;
  currencyConverter?: PointInTimeCurrencyConverter;
  regime?: string;
  volatilityPercentile?: number;
  expectedR?: number;
  mlProbability?: number;
}

export class PositionSizer {
  /**
   * Deterministically calculates multi-asset institutional position size based on strict stop-based risk,
   * authoritative instrument specifications, point-in-time FX conversions to INR account currency,
   * margin requirements, leverage constraints, and liquidation safety.
   *
   * STRICT 15-STEP ORDER OF OPERATIONS (FAIL-CLOSED).
   */
  static calculatePosition(options: ICalculatePositionOptions): IPositionSizing {
    let {
      accountBalance,
      riskPercentage = 1.0,
      entryPrice,
      stopLoss,
      symbol,
      instrument: instrumentInput,
      direction = 'BUY',
      lotSize,
      contractSize,
      maxRiskPercentage = 2.5,
      maxLeverage,
      leverage: customLeverage,
      requestedLeverage,
      marginMode,
      availableMargin,
      timestamp = Date.now(),
      currencyConverter = PointInTimeCurrencyConverter.getInstance(),
      regime,
      volatilityPercentile,
      expectedR,
      mlProbability,
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

    const stopDistance = Math.abs(entryPrice - stopLoss);
    if (stopDistance <= 0) {
      return this.createInvalid(options, 'Entry price cannot equal stop loss (risk per unit is 0)');
    }

    // 1. Resolve Authoritative Instrument Specification
    let resolvedInstrument: IInstrument | undefined;
    if (typeof instrumentInput === 'object' && instrumentInput !== null) {
      resolvedInstrument = instrumentInput;
    } else if (typeof instrumentInput === 'string') {
      try {
        resolvedInstrument = getAuthoritativeInstrument(instrumentInput);
      } catch (err: any) {
        return this.createInvalid(options, err.message);
      }
    } else if (symbol) {
      if (hasInstrument(symbol)) {
        resolvedInstrument = getAuthoritativeInstrument(symbol);
      }
    }

    const effectiveContractSize = resolvedInstrument?.contractSize ?? contractSize ?? 1;
    const effectiveLotSize = resolvedInstrument?.lotSize ?? lotSize ?? 1;
    const minQuantity = resolvedInstrument?.minimumQuantity ?? effectiveLotSize;
    const qtyPrecision = resolvedInstrument?.quantityPrecision ?? (effectiveLotSize < 1 ? 4 : 0);

    // 2. Validate Account Currency & 3. Quote Currency
    const accountCurrency: CurrencyCode = 'INR';
    const quoteCurrency: CurrencyCode =
      resolvedInstrument?.quoteCurrency || (resolvedInstrument?.currency as any) || 'INR';

    // 4. Resolve Point-In-Time FX Rate to INR
    let fxResult: IFxConversionResult;
    try {
      fxResult = currencyConverter.getRate(quoteCurrency, accountCurrency, timestamp);
    } catch (err: any) {
      return this.createInvalid(options, `FX_CONVERSION_FAILED: ${err.message}`);
    }

    const fxRate = fxResult.fxRate;

    // Dynamic Regime and Volatility adjustment
    if (
      regime === 'HIGH_VOLATILITY' ||
      (volatilityPercentile !== undefined && volatilityPercentile > 80)
    ) {
      riskPercentage *= 0.6; // Scale down risk during high volatility shocks
    } else if (
      expectedR &&
      expectedR >= 1.8 &&
      mlProbability &&
      mlProbability >= 0.7 &&
      regime === 'BULLISH_TREND'
    ) {
      riskPercentage = Math.min(maxRiskPercentage, riskPercentage * 1.25);
    }

    // Strict cap at max allowable risk percentage
    riskPercentage = Math.min(maxRiskPercentage, Math.max(0.1, riskPercentage));

    // 5. Calculate Risk Budget in INR
    const riskAmountINR = accountBalance * (riskPercentage / 100);

    // 6. Calculate Stop Distance and 7. Risk Per Unit in INR
    const riskPerUnitINR = stopDistance * effectiveContractSize * fxRate;
    if (riskPerUnitINR <= 0) {
      return this.createInvalid(options, 'Risk per unit in account currency is zero or invalid');
    }

    // 8. Calculate Risk-Based Quantity
    const unitsByRisk = riskAmountINR / riskPerUnitINR;

    // Resolve Leverage & Margin Mode early for margin capacity bounds
    const instrumentMaxLeverage = resolvedInstrument?.maxLeverage ?? maxLeverage ?? 10;
    const requestedLev = requestedLeverage ?? customLeverage ?? resolvedInstrument?.defaultLeverage ?? 1;

    if (requestedLev > instrumentMaxLeverage) {
      return this.createInvalid(
        options,
        `Requested leverage (${requestedLev}x) exceeds instrument maximum allowable leverage (${instrumentMaxLeverage}x)`,
      );
    }

    const effLeverage = Math.max(1, requestedLev);
    const effMarginMode: MarginMode =
      marginMode || resolvedInstrument?.marginMode || (effLeverage > 1 ? 'ISOLATED' : 'SPOT');

    const effAvailableMargin = availableMargin !== undefined ? availableMargin : accountBalance;
    const accountMaxLeverage = maxLeverage ?? instrumentMaxLeverage;

    // Unit value in account currency
    const unitPriceINR = entryPrice * effectiveContractSize * fxRate;
    const initialMarginRate = resolvedInstrument?.initialMarginRate ?? (effMarginMode === 'SPOT' ? 1.0 : 1 / effLeverage);
    const marginPerUnitINR = unitPriceINR * initialMarginRate;

    const maxUnitsByMargin = marginPerUnitINR > 0 ? effAvailableMargin / marginPerUnitINR : Infinity;
    const maxUnitsByLeverage = unitPriceINR > 0 ? (accountBalance * accountMaxLeverage) / unitPriceINR : Infinity;

    const calculatedUnits = Math.min(unitsByRisk, maxUnitsByMargin, maxUnitsByLeverage);

    // 9. Apply Instrument Lot / Minimum Quantity Rules (Strict Floor Rounding)
    let roundedUnits = Math.floor(calculatedUnits / effectiveLotSize) * effectiveLotSize;
    roundedUnits = Number(roundedUnits.toFixed(qtyPrecision));

    if (roundedUnits <= 0 || roundedUnits < minQuantity) {
      const minLotMargin = (minQuantity * marginPerUnitINR);
      const isMarginFailure = effAvailableMargin < minLotMargin;
      return {
        accountBalance,
        riskPercentage,
        riskAmount: Number(riskAmountINR.toFixed(2)),
        entryPrice,
        stopLoss,
        riskPerUnit: Number(riskPerUnitINR.toFixed(4)),
        calculatedUnits: Number(calculatedUnits.toFixed(qtyPrecision)),
        lotSize: effectiveLotSize,
        roundedUnits: 0,
        totalPositionValue: 0,
        maximumLoss: 0,
        accountCurrency,
        quoteCurrency,
        fxPair: fxResult.fxPair,
        fxRate: fxResult.fxRate,
        fxTimestamp: fxResult.fxTimestamp,
        fxSnapshotHash: fxResult.fxSnapshotHash,
        contractSize: effectiveContractSize,
        positionNotionalQuote: 0,
        positionNotionalAccount: 0,
        leverage: effLeverage,
        marginMode: effMarginMode,
        initialMarginRequired: Number(minLotMargin.toFixed(2)),
        maintenanceMarginRequired: Number((minLotMargin * (resolvedInstrument?.maintenanceMarginRate ?? 0.05)).toFixed(2)),
        isValid: false,
        rejectionReason: isMarginFailure
          ? `Required initial margin (${minLotMargin.toFixed(2)} INR) exceeds available margin (${effAvailableMargin.toFixed(2)} INR)`
          : `Calculated units (${calculatedUnits.toFixed(qtyPrecision)}) smaller than minimum lot size (${minQuantity}) without exceeding risk budget`,
      };
    }

    // Rounding Safety Check: verify rounded risk does not exceed risk budget
    const actualRiskINR = roundedUnits * riskPerUnitINR;
    if (actualRiskINR > riskAmountINR + 1e-4) {
      return this.createInvalid(
        options,
        `Rounding increased risk (${actualRiskINR.toFixed(2)} INR) above allowed risk budget (${riskAmountINR.toFixed(2)} INR)`,
      );
    }

    // 10. Calculate Notional Value
    const notionalCalc = TradeAccountingEngine.calculateNotional(
      roundedUnits,
      entryPrice,
      effectiveContractSize,
      fxRate,
    );
    const positionNotionalQuote = notionalCalc.notionalQuote;
    const positionNotionalINR = notionalCalc.notionalAccount;

    const marginCalc = TradeAccountingEngine.calculateMargin(
      positionNotionalINR,
      effLeverage,
      effMarginMode,
      resolvedInstrument?.initialMarginRate,
      resolvedInstrument?.maintenanceMarginRate,
    );

    const initialMarginRequired = marginCalc.initialMarginRequired;
    const maintenanceMarginRequired = marginCalc.maintenanceMarginRequired;

    // 12. Check Available Margin
    if (initialMarginRequired > effAvailableMargin + 1e-4) {
      return {
        accountBalance,
        riskPercentage,
        riskAmount: Number(actualRiskINR.toFixed(2)),
        entryPrice,
        stopLoss,
        riskPerUnit: Number(riskPerUnitINR.toFixed(4)),
        calculatedUnits: Number(calculatedUnits.toFixed(qtyPrecision)),
        lotSize: effectiveLotSize,
        roundedUnits,
        totalPositionValue: positionNotionalINR,
        maximumLoss: Number(actualRiskINR.toFixed(2)),
        accountCurrency,
        quoteCurrency,
        fxPair: fxResult.fxPair,
        fxRate: fxResult.fxRate,
        fxTimestamp: fxResult.fxTimestamp,
        fxSnapshotHash: fxResult.fxSnapshotHash,
        contractSize: effectiveContractSize,
        positionNotionalQuote,
        positionNotionalAccount: positionNotionalINR,
        leverage: effLeverage,
        marginMode: effMarginMode,
        initialMarginRequired,
        maintenanceMarginRequired,
        isValid: false,
        rejectionReason: `Required initial margin (${initialMarginRequired.toFixed(2)} INR) exceeds available margin (${effAvailableMargin.toFixed(2)} INR)`,
      };
    }

    // 13. Gross Account Leverage Limit
    if (positionNotionalINR > accountBalance * accountMaxLeverage + 1e-4) {
      return {
        accountBalance,
        riskPercentage,
        riskAmount: Number(actualRiskINR.toFixed(2)),
        entryPrice,
        stopLoss,
        riskPerUnit: Number(riskPerUnitINR.toFixed(4)),
        calculatedUnits: Number(calculatedUnits.toFixed(qtyPrecision)),
        lotSize: effectiveLotSize,
        roundedUnits,
        totalPositionValue: positionNotionalINR,
        maximumLoss: Number(actualRiskINR.toFixed(2)),
        accountCurrency,
        quoteCurrency,
        fxPair: fxResult.fxPair,
        fxRate: fxResult.fxRate,
        fxTimestamp: fxResult.fxTimestamp,
        fxSnapshotHash: fxResult.fxSnapshotHash,
        contractSize: effectiveContractSize,
        positionNotionalQuote,
        positionNotionalAccount: positionNotionalINR,
        leverage: effLeverage,
        marginMode: effMarginMode,
        initialMarginRequired,
        maintenanceMarginRequired,
        isValid: false,
        rejectionReason: `Required initial margin (${initialMarginRequired.toFixed(2)} INR) exceeds available margin (${effAvailableMargin.toFixed(2)} INR)`,
      };
    }

    // 13. Gross Account Leverage Limit
    if (positionNotionalINR > accountBalance * accountMaxLeverage + 1e-4) {
      return {
        accountBalance,
        riskPercentage,
        riskAmount: Number(actualRiskINR.toFixed(2)),
        entryPrice,
        stopLoss,
        riskPerUnit: Number(riskPerUnitINR.toFixed(4)),
        calculatedUnits: Number(calculatedUnits.toFixed(qtyPrecision)),
        lotSize: effectiveLotSize,
        roundedUnits,
        totalPositionValue: positionNotionalINR,
        maximumLoss: Number(actualRiskINR.toFixed(2)),
        accountCurrency,
        quoteCurrency,
        fxPair: fxResult.fxPair,
        fxRate: fxResult.fxRate,
        fxTimestamp: fxResult.fxTimestamp,
        fxSnapshotHash: fxResult.fxSnapshotHash,
        contractSize: effectiveContractSize,
        positionNotionalQuote,
        positionNotionalAccount: positionNotionalINR,
        leverage: effLeverage,
        marginMode: effMarginMode,
        initialMarginRequired,
        maintenanceMarginRequired,
        isValid: false,
        rejectionReason: `Position value (${positionNotionalINR.toFixed(2)} INR) exceeds maximum allowable account leverage (${accountMaxLeverage}x)`,
      };
    }

    // 14. Liquidation Safety Calculation
    const liquidationPrice = TradeAccountingEngine.calculateLiquidationPrice(
      entryPrice,
      direction,
      effLeverage,
      resolvedInstrument?.maintenanceMarginRate ?? 0.025,
    );

    // 15. Return Complete Institutional Position Sizing
    return {
      accountBalance,
      riskPercentage,
      riskAmount: Number(actualRiskINR.toFixed(2)),
      entryPrice,
      stopLoss,
      riskPerUnit: Number(riskPerUnitINR.toFixed(4)),
      calculatedUnits: Number(calculatedUnits.toFixed(qtyPrecision)),
      lotSize: effectiveLotSize,
      roundedUnits,
      totalPositionValue: positionNotionalINR, // In account currency (INR)
      maximumLoss: Number(actualRiskINR.toFixed(2)),
      accountCurrency,
      quoteCurrency,
      fxPair: fxResult.fxPair,
      fxRate: fxResult.fxRate,
      fxTimestamp: fxResult.fxTimestamp,
      fxSnapshotHash: fxResult.fxSnapshotHash,
      contractSize: effectiveContractSize,
      positionNotionalQuote,
      positionNotionalAccount: positionNotionalINR,
      leverage: effLeverage,
      marginMode: effMarginMode,
      initialMarginRequired,
      maintenanceMarginRequired,
      liquidationPrice,
      isValid: true,
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
