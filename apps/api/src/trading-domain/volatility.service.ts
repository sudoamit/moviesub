import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import {
  ATRResult,
  Direction,
  ICandle,
  IVolatilityDomainService,
  RealizedVolatilityResult,
  VolatilityEstimatorType,
  VolatilityRegime,
  VolatilityTargetSizingParams,
  VolatilityTargetSizingResult,
} from '@quant/shared';

@Injectable()
export class VolatilityService implements IVolatilityDomainService {
  private readonly logger = new Logger(VolatilityService.name);

  /**
   * Validates candle array integrity.
   * Fails closed if candle count is insufficient or any price is non-finite or non-positive.
   */
  private validateCandles(candles: ICandle[], minCount = 2): void {
    if (!Array.isArray(candles) || candles.length < minCount) {
      throw new BadRequestException(
        `Insufficient candle data: at least ${minCount} closed candles required for volatility calculation (received: ${candles?.length ?? 0})`,
      );
    }

    for (let i = 0; i < candles.length; i++) {
      const c = candles[i];
      if (!c) {
        throw new BadRequestException(`Candle at index ${i} is null or undefined`);
      }

      const o = Number(c.open);
      const h = Number(c.high);
      const l = Number(c.low);
      const cl = Number(c.close);

      if (
        !Number.isFinite(o) ||
        !Number.isFinite(h) ||
        !Number.isFinite(l) ||
        !Number.isFinite(cl) ||
        o <= 0 ||
        h <= 0 ||
        l <= 0 ||
        cl <= 0
      ) {
        throw new BadRequestException(
          `Invalid candle at index ${i}: OHLC values must be finite positive numbers (O: ${o}, H: ${h}, L: ${l}, C: ${cl})`,
        );
      }

      if (h < l) {
        throw new BadRequestException(
          `Invalid candle at index ${i}: high (${h}) cannot be lower than low (${l})`,
        );
      }
    }
  }

  /**
   * Close-to-Close Realized Volatility:
   * Standard sample standard deviation of log returns r_t = ln(C_t / C_{t-1}).
   */
  calculateCloseToCloseVol(
    candles: ICandle[],
    annualizationFactor = 252,
  ): RealizedVolatilityResult {
    this.validateCandles(candles, 2);

    const logReturns: number[] = [];
    for (let i = 1; i < candles.length; i++) {
      const prevClose = Number(candles[i - 1].close);
      const currClose = Number(candles[i].close);
      logReturns.push(Math.log(currClose / prevClose));
    }

    const n = logReturns.length;
    const mean = logReturns.reduce((sum, r) => sum + r, 0) / n;
    const sumSqDiff = logReturns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0);
    const variance = n > 1 ? sumSqDiff / (n - 1) : sumSqDiff / n;
    const dailyVolatility = Math.sqrt(variance);
    const annualizedVolatility = dailyVolatility * Math.sqrt(annualizationFactor);

    return {
      estimator: 'CLOSE_TO_CLOSE',
      period: candles.length,
      dailyVolatility,
      annualizedVolatility,
      variance,
      annualizationFactor,
      details: { meanReturn: mean, returnCount: n },
    };
  }

  /**
   * Parkinson (1980) High-Low Realized Volatility:
   * Uses intraday high-low range. ~5x more statistically efficient than Close-to-Close.
   * sigma^2 = (1 / (4 * ln(2) * N)) * sum( (ln(H_i / L_i))^2 )
   */
  calculateParkinsonVol(
    candles: ICandle[],
    annualizationFactor = 252,
  ): RealizedVolatilityResult {
    this.validateCandles(candles, 2);

    const n = candles.length;
    let sumLogRangeSq = 0;

    for (let i = 0; i < n; i++) {
      const h = Number(candles[i].high);
      const l = Number(candles[i].low);
      const logRange = Math.log(h / l);
      sumLogRangeSq += Math.pow(logRange, 2);
    }

    const constant = 4 * Math.log(2); // ~2.7725887
    const variance = sumLogRangeSq / (constant * n);
    const dailyVolatility = Math.sqrt(variance);
    const annualizedVolatility = dailyVolatility * Math.sqrt(annualizationFactor);

    return {
      estimator: 'PARKINSON',
      period: n,
      dailyVolatility,
      annualizedVolatility,
      variance,
      annualizationFactor,
      details: { sumLogRangeSq, constant },
    };
  }

  /**
   * Garman-Klass (1980) OHLC Realized Volatility:
   * Incorporates Open, High, Low, and Close. ~8x more efficient than Close-to-Close.
   * sigma^2 = (1 / N) * sum( 0.5 * (ln(H/L))^2 - (2*ln(2) - 1) * (ln(C/O))^2 )
   */
  calculateGarmanKlassVol(
    candles: ICandle[],
    annualizationFactor = 252,
  ): RealizedVolatilityResult {
    this.validateCandles(candles, 2);

    const n = candles.length;
    const c2 = 2 * Math.log(2) - 1; // ~0.386294
    let sumTerms = 0;

    for (let i = 0; i < n; i++) {
      const o = Number(candles[i].open);
      const h = Number(candles[i].high);
      const l = Number(candles[i].low);
      const c = Number(candles[i].close);

      const hlTerm = 0.5 * Math.pow(Math.log(h / l), 2);
      const coTerm = c2 * Math.pow(Math.log(c / o), 2);
      sumTerms += hlTerm - coTerm;
    }

    const variance = Math.max(0, sumTerms / n);
    const dailyVolatility = Math.sqrt(variance);
    const annualizedVolatility = dailyVolatility * Math.sqrt(annualizationFactor);

    return {
      estimator: 'GARMAN_KLASS',
      period: n,
      dailyVolatility,
      annualizedVolatility,
      variance,
      annualizationFactor,
      details: { sumTerms, c2 },
    };
  }

  /**
   * Yang-Zhang (2000) Realized Volatility:
   * Minimum-variance unbiased estimator accounting for both overnight gaps and intraday drift.
   * sigma^2_YZ = sigma^2_open + k * sigma^2_close + (1 - k) * sigma^2_RS
   */
  calculateYangZhangVol(
    candles: ICandle[],
    annualizationFactor = 252,
  ): RealizedVolatilityResult {
    this.validateCandles(candles, 2);

    const n = candles.length;
    const m = n - 1; // Number of consecutive pair intervals

    // 1. Overnight returns: ln(Open_t / Close_{t-1})
    const openReturns: number[] = [];
    // 2. Intraday returns: ln(Close_t / Open_t)
    const closeReturns: number[] = [];
    // 3. Rogers-Satchell terms
    const rsTerms: number[] = [];

    for (let i = 1; i < n; i++) {
      const prevClose = Number(candles[i - 1].close);
      const currOpen = Number(candles[i].open);
      const currHigh = Number(candles[i].high);
      const currLow = Number(candles[i].low);
      const currClose = Number(candles[i].close);

      openReturns.push(Math.log(currOpen / prevClose));
      closeReturns.push(Math.log(currClose / currOpen));

      const rsTerm =
        Math.log(currHigh / currClose) * Math.log(currHigh / currOpen) +
        Math.log(currLow / currClose) * Math.log(currLow / currOpen);
      rsTerms.push(rsTerm);
    }

    // Overnight variance
    const meanOpen = openReturns.reduce((s, r) => s + r, 0) / m;
    const sumSqOpen = openReturns.reduce((s, r) => s + Math.pow(r - meanOpen, 2), 0);
    const varOpen = m > 1 ? sumSqOpen / (m - 1) : sumSqOpen / m;

    // Intraday close variance
    const meanClose = closeReturns.reduce((s, r) => s + r, 0) / m;
    const sumSqClose = closeReturns.reduce((s, r) => s + Math.pow(r - meanClose, 2), 0);
    const varClose = m > 1 ? sumSqClose / (m - 1) : sumSqClose / m;

    // Rogers-Satchell variance
    const varRS = rsTerms.reduce((s, t) => s + t, 0) / m;

    // Weighting factor k
    const k = m > 1 ? 0.34 / (1.34 + (m + 1) / (m - 1)) : 0.34 / 2.34;

    const variance = Math.max(0, varOpen + k * varClose + (1 - k) * varRS);
    const dailyVolatility = Math.sqrt(variance);
    const annualizedVolatility = dailyVolatility * Math.sqrt(annualizationFactor);

    return {
      estimator: 'YANG_ZHANG',
      period: n,
      dailyVolatility,
      annualizedVolatility,
      variance,
      annualizationFactor,
      details: {
        varOpen,
        varClose,
        varRS,
        k,
        sampleSize: m,
      },
    };
  }

  /**
   * Average True Range (ATR) & Volatility Regime Classification:
   * TR_t = max(H - L, |H - C_{prev}|, |L - C_{prev}|)
   */
  calculateATR(candles: ICandle[], period = 14, baselineATR?: number): ATRResult {
    this.validateCandles(candles, 2);

    const trueRanges: number[] = [];

    // First candle TR is simply high - low
    trueRanges.push(Number(candles[0].high) - Number(candles[0].low));

    for (let i = 1; i < candles.length; i++) {
      const h = Number(candles[i].high);
      const l = Number(candles[i].low);
      const prevC = Number(candles[i - 1].close);

      const tr = Math.max(h - l, Math.abs(h - prevC), Math.abs(l - prevC));
      trueRanges.push(tr);
    }

    // Effective period is bounded by available true ranges
    const effectivePeriod = Math.min(period, trueRanges.length);
    const recentRanges = trueRanges.slice(-effectivePeriod);
    const atr = recentRanges.reduce((sum, tr) => sum + tr, 0) / effectivePeriod;

    const lastClose = Number(candles[candles.length - 1].close);
    const normalizedATR = lastClose > 0 ? (atr / lastClose) * 100 : 0;

    // Classify regime
    const regime = this.classifyRegime(atr, baselineATR ?? atr);

    // Derive adaptive stop loss multiplier
    let adaptiveStopLossMultiplier = 2.0;
    switch (regime) {
      case 'LOW_VOLATILITY':
        adaptiveStopLossMultiplier = 1.5;
        break;
      case 'NORMAL_VOLATILITY':
        adaptiveStopLossMultiplier = 2.0;
        break;
      case 'HIGH_VOLATILITY':
        adaptiveStopLossMultiplier = 2.5;
        break;
      case 'EXTREME_VOLATILITY':
        adaptiveStopLossMultiplier = 3.0;
        break;
    }

    return {
      atr,
      normalizedATR,
      period: effectivePeriod,
      trueRanges,
      regime,
      adaptiveStopLossMultiplier,
    };
  }

  /**
   * Classifies current volatility regime based on ratio to baseline volatility.
   */
  classifyRegime(currentVol: number, baselineVol: number): VolatilityRegime {
    if (baselineVol <= 0 || !Number.isFinite(baselineVol)) {
      return 'NORMAL_VOLATILITY';
    }

    const ratio = currentVol / baselineVol;
    if (ratio < 0.8) {
      return 'LOW_VOLATILITY';
    } else if (ratio <= 1.3) {
      return 'NORMAL_VOLATILITY';
    } else if (ratio <= 2.0) {
      return 'HIGH_VOLATILITY';
    } else {
      return 'EXTREME_VOLATILITY';
    }
  }

  /**
   * Calculates volatility-targeted position sizing:
   * Size = (AccountBalance * TargetVol%) / (EntryPrice * ContractSize * RealizedVolAnn * FxRate)
   * Clamps raw volatility scale factor between minScaleFactor and maxScaleFactor.
   */
  calculateVolatilityTargetSize(
    params: VolatilityTargetSizingParams,
  ): VolatilityTargetSizingResult {
    const {
      accountBalance,
      targetVolatilityPercent,
      realizedVolatilityAnnualized,
      entryPrice,
      contractSize = 1,
      fxRate = 1.0,
      minScaleFactor = 0.25, // floor: max 4x deleverage
      maxScaleFactor = 2.5,  // cap: max 2.5x leverage
      minQuantity = 1,
      stepSize = 1,
      maxQuantity = 0,
    } = params;

    // Fail closed on invalid inputs
    if (
      accountBalance <= 0 ||
      targetVolatilityPercent <= 0 ||
      realizedVolatilityAnnualized <= 0 ||
      entryPrice <= 0 ||
      contractSize <= 0 ||
      fxRate <= 0
    ) {
      return {
        targetQuantity: 0,
        normalizedQuantity: 0,
        rawVolatilityScaleFactor: 0,
        clampedScaleFactor: 0,
        targetRiskBudgetAccount: 0,
        targetExposureAccount: 0,
        isClamped: false,
        isValid: false,
        reason: 'All financial parameters must be positive numbers',
        code: 'INVALID_PARAMETERS',
      };
    }

    const targetVolDecimal = targetVolatilityPercent / 100;
    const targetRiskBudgetAccount = accountBalance * targetVolDecimal;
    const unitVolAccount = entryPrice * contractSize * realizedVolatilityAnnualized * fxRate;

    const rawQuantity = targetRiskBudgetAccount / unitVolAccount;
    const rawVolatilityScaleFactor = targetVolDecimal / realizedVolatilityAnnualized;

    // Clamp scaling factor
    const clampedScaleFactor = Math.min(
      Math.max(rawVolatilityScaleFactor, minScaleFactor),
      maxScaleFactor,
    );
    const isClamped = clampedScaleFactor !== rawVolatilityScaleFactor;

    // Adjust target quantity by scale clamp if clamped
    const adjustedQuantity = isClamped
      ? (rawQuantity * clampedScaleFactor) / rawVolatilityScaleFactor
      : rawQuantity;

    // Apply lot / step size constraints: ALWAYS FLOOR, NEVER ROUND UP
    let normalizedQuantity = adjustedQuantity;
    if (stepSize > 0) {
      normalizedQuantity = Math.floor(normalizedQuantity / stepSize) * stepSize;
    }

    // Check minimum quantity: STRICT REJECTION, NEVER CLAMP UP
    if (normalizedQuantity < minQuantity) {
      return {
        targetQuantity: adjustedQuantity,
        normalizedQuantity: 0,
        rawVolatilityScaleFactor,
        clampedScaleFactor,
        targetRiskBudgetAccount,
        targetExposureAccount: 0,
        isClamped,
        isValid: false,
        reason: `Target quantity ${adjustedQuantity.toFixed(4)} is below minimum quantity ${minQuantity}`,
        code: 'QUANTITY_BELOW_MINIMUM',
      };
    }

    // Max quantity ceiling
    if (maxQuantity > 0 && normalizedQuantity > maxQuantity) {
      normalizedQuantity = maxQuantity;
    }

    const targetExposureAccount = normalizedQuantity * entryPrice * contractSize * fxRate;

    return {
      targetQuantity: adjustedQuantity,
      normalizedQuantity,
      rawVolatilityScaleFactor,
      clampedScaleFactor,
      targetRiskBudgetAccount,
      targetExposureAccount,
      isClamped,
      isValid: true,
    };
  }

  /**
   * Computes regime-adaptive stop loss price:
   * BUY:  Entry - (ATR * AdaptiveMultiplier)
   * SELL: Entry + (ATR * AdaptiveMultiplier)
   */
  getAdaptiveStopLoss(
    entryPrice: number,
    direction: Direction | string,
    atrResult: ATRResult,
    baseMultiplier = 2.0,
  ): number {
    if (entryPrice <= 0 || !Number.isFinite(entryPrice)) {
      throw new BadRequestException('Entry price must be a positive number');
    }

    // Scale multiplier relative to baseline of 2.0
    const effectiveMultiplier = (atrResult.adaptiveStopLossMultiplier * baseMultiplier) / 2.0;
    const stopDistance = atrResult.atr * effectiveMultiplier;

    const dirStr = String(direction).toUpperCase();
    if (dirStr === 'BUY' || dirStr === 'LONG') {
      return Math.max(0.01, entryPrice - stopDistance);
    } else {
      return entryPrice + stopDistance;
    }
  }
}
