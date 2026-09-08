import { ICandle, IMarketDataQualityResult } from '../interfaces';
import { Timeframe } from '../enums';
export interface ICandleValidationResult {
    isValid: boolean;
    errors: string[];
}
export declare class CandleValidator {
    /**
     * Validates a single candlestick against strict quantitative rules
     */
    static validate(candle: ICandle): ICandleValidationResult;
    /**
     * Validates, sorts chronologically, and deduplicates an array of candles
     */
    static normalizeAndCleanSeries(candles: ICandle[]): {
        validCandles: ICandle[];
        invalidCount: number;
        duplicateCount: number;
    };
    /**
     * Evaluates complete series against production Data Quality & Integrity Gate rules
     */
    static validateDataQuality(candles: ICandle[], symbol: string, timeframe?: Timeframe | string, maxAllowedStalenessMs?: number): IMarketDataQualityResult;
    /**
     * Helper to convert Timeframe enum to milliseconds
     */
    static timeframeToMs(timeframe: Timeframe | string): number;
}
