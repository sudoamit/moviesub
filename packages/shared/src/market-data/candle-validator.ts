import { ICandle, IMarketDataQualityResult } from '../interfaces';
import { Timeframe } from '../enums';

export interface ICandleValidationResult {
  isValid: boolean;
  errors: string[];
}

export class CandleValidator {
  /**
   * Validates a single candlestick against strict quantitative rules
   */
  static validate(candle: ICandle): ICandleValidationResult {
    const errors: string[] = [];

    if (!candle) {
      return { isValid: false, errors: ['Candle object is null or undefined'] };
    }

    // 1. Timestamp validation
    if (
      !candle.timestamp ||
      !(candle.timestamp instanceof Date) ||
      isNaN(candle.timestamp.getTime())
    ) {
      errors.push('Invalid timestamp');
    }

    // 2. Positive price validation
    if (typeof candle.open !== 'number' || isNaN(candle.open) || candle.open <= 0) {
      errors.push(`Invalid open price: ${candle.open}`);
    }
    if (typeof candle.high !== 'number' || isNaN(candle.high) || candle.high <= 0) {
      errors.push(`Invalid high price: ${candle.high}`);
    }
    if (typeof candle.low !== 'number' || isNaN(candle.low) || candle.low <= 0) {
      errors.push(`Invalid low price: ${candle.low}`);
    }
    if (typeof candle.close !== 'number' || isNaN(candle.close) || candle.close <= 0) {
      errors.push(`Invalid close price: ${candle.close}`);
    }

    // 3. High/Low bounding validation
    if (errors.length === 0) {
      const maxBody = Math.max(candle.open, candle.close);
      const minBody = Math.min(candle.open, candle.close);

      // Allow 1e-6 epsilon for floating point tick rounding
      if (candle.high < maxBody - 1e-6) {
        errors.push(`High (${candle.high}) is lower than max(open, close) (${maxBody})`);
      }
      if (candle.low > minBody + 1e-6) {
        errors.push(`Low (${candle.low}) is higher than min(open, close) (${minBody})`);
      }
      if (candle.high < candle.low) {
        errors.push(`High (${candle.high}) is lower than Low (${candle.low})`);
      }
    }

    // 4. Volume validation
    if (typeof candle.volume !== 'number' || isNaN(candle.volume) || candle.volume < 0) {
      errors.push(`Invalid volume: ${candle.volume}`);
    }

    return {
      isValid: errors.length === 0,
      errors,
    };
  }

  /**
   * Validates, sorts chronologically, and deduplicates an array of candles
   */
  static normalizeAndCleanSeries(candles: ICandle[]): {
    validCandles: ICandle[];
    invalidCount: number;
    duplicateCount: number;
  } {
    if (!candles || candles.length === 0) {
      return { validCandles: [], invalidCount: 0, duplicateCount: 0 };
    }

    let invalidCount = 0;
    const validMap = new Map<number, ICandle>();
    let duplicateCount = 0;

    for (const candle of candles) {
      const validation = this.validate(candle);
      if (!validation.isValid) {
        invalidCount++;
        continue;
      }

      const timeKey = candle.timestamp.getTime();
      if (validMap.has(timeKey)) {
        duplicateCount++;
      }
      // Upsert: latest received candle for timestamp wins
      validMap.set(timeKey, candle);
    }

    const sortedCandles = Array.from(validMap.values()).sort(
      (a, b) => a.timestamp.getTime() - b.timestamp.getTime(),
    );

    return {
      validCandles: sortedCandles,
      invalidCount,
      duplicateCount,
    };
  }

  /**
   * Evaluates complete series against production Data Quality & Integrity Gate rules
   */
  static validateDataQuality(
    candles: ICandle[],
    symbol: string,
    timeframe: Timeframe | string = '15m',
    maxAllowedStalenessMs: number = 30 * 60 * 1000,
  ): IMarketDataQualityResult {
    const reasons: string[] = [];
    const now = Date.now();
    const tfMs = this.timeframeToMs(timeframe);

    if (!candles || candles.length < 5) {
      return {
        isValid: false,
        symbol,
        timeframe: String(timeframe),
        checkedAt: new Date(),
        staleData: true,
        missingCandlesCount: 0,
        duplicateCandlesCount: 0,
        abnormalPriceJumpsCount: 0,
        zeroVolumeCount: 0,
        feedDisconnected: true,
        reasons: [
          `Insufficient candle data: received ${candles?.length || 0} candles (minimum required: 5)`,
        ],
      };
    }

    const { validCandles, duplicateCount } = this.normalizeAndCleanSeries(candles);

    // 1. Staleness Check
    const latestCandle = validCandles[validCandles.length - 1];
    const ageMs = now - latestCandle.timestamp.getTime();
    const isCrypto = symbol.toUpperCase() === 'BTCUSDT';
    const effectiveMaxAge = isCrypto
      ? Math.max(3 * tfMs, maxAllowedStalenessMs)
      : 18 * 60 * 60 * 1000; // Crypto 24/7 vs NSE overnight
    const staleData = ageMs > effectiveMaxAge;
    if (staleData) {
      reasons.push(`Stale market feed: latest candle is ${Math.round(ageMs / 60000)} minutes old`);
    }

    // 2. Missing Candles / Time Gap Detection
    let missingCount = 0;
    for (let i = 1; i < validCandles.length; i++) {
      const diff = validCandles[i].timestamp.getTime() - validCandles[i - 1].timestamp.getTime();
      if (diff > tfMs * 2.5) {
        // Gap greater than 2 candles
        missingCount += Math.floor(diff / tfMs) - 1;
      }
    }
    if (missingCount > 3) {
      reasons.push(`Detected ${missingCount} missing candle intervals in series`);
    }

    // 3. Abnormal Price Jump Detection (> 15% move in 1 candle)
    let abnormalJumps = 0;
    for (let i = 1; i < validCandles.length; i++) {
      const prevClose = validCandles[i - 1].close;
      const currClose = validCandles[i].close;
      if (prevClose > 0) {
        const changePct = Math.abs(currClose - prevClose) / prevClose;
        if (changePct > 0.15) {
          abnormalJumps++;
        }
      }
    }
    if (abnormalJumps > 0) {
      reasons.push(
        `Abnormal price spike detected: ${abnormalJumps} candles exceeded 15% single-step variance`,
      );
    }

    // 4. Zero Volume Detection
    const zeroVolCount = validCandles.filter((c) => c.volume <= 0).length;
    if (zeroVolCount > validCandles.length * 0.5) {
      reasons.push(`Excessive zero-volume candles (${zeroVolCount} / ${validCandles.length})`);
    }

    const isValid = reasons.length === 0;

    return {
      isValid,
      symbol,
      timeframe: String(timeframe),
      checkedAt: new Date(),
      staleData,
      missingCandlesCount: missingCount,
      duplicateCandlesCount: duplicateCount,
      abnormalPriceJumpsCount: abnormalJumps,
      zeroVolumeCount: zeroVolCount,
      feedDisconnected: staleData && isCrypto,
      reasons,
    };
  }

  /**
   * Helper to convert Timeframe enum to milliseconds
   */
  static timeframeToMs(timeframe: Timeframe | string): number {
    switch (timeframe) {
      case Timeframe.M1:
      case '1m':
        return 60 * 1000;
      case Timeframe.M5:
      case '5m':
        return 5 * 60 * 1000;
      case Timeframe.M15:
      case '15m':
        return 15 * 60 * 1000;
      case Timeframe.M30:
      case '30m':
        return 30 * 60 * 1000;
      case Timeframe.H1:
      case '1h':
        return 60 * 60 * 1000;
      case Timeframe.H4:
      case '4h':
        return 4 * 60 * 60 * 1000;
      case Timeframe.D1:
      case '1d':
        return 24 * 60 * 60 * 1000;
      default:
        return 15 * 60 * 1000;
    }
  }
}
