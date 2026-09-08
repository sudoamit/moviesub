import { ICandle } from '@quant/shared';
export interface IDataQualityReport {
    isValid: boolean;
    candleCount: number;
    hasDuplicates: boolean;
    hasGaps: boolean;
    isMonotonic: boolean;
    hasInvalidOhlc: boolean;
    errors: string[];
}
export declare class QuantValidationEngine {
    /**
     * Comprehensive data quality validator for candle streams before execution.
     */
    static validateCandles(candles: ICandle[], expectedIntervalMinutes?: number): IDataQualityReport;
    /**
     * Automated lookahead leakage detector.
     * Compares feature output at timestamp T using dataset(0..T) vs dataset(0..T + future).
     */
    static testLookaheadInvariance<T>(featureExtractor: (candles: ICandle[]) => T, fullCandles: ICandle[], evalIndex: number): {
        isLeakageFree: boolean;
        historicalResult: T;
        futureAppendedResult: T;
    };
}
