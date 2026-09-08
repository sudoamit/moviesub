import { ICandle } from '@quant/shared';
export interface ICandleNormalizerOptions {
    enforceSorted?: boolean;
    deduplicate?: boolean;
    validateOHLC?: boolean;
}
export declare class CandleNormalizer {
    static getTimeframeDurationMs(tf: string | number): number;
    static getCandleCloseTimestamp(candle: ICandle, timeframe?: string | number): Date;
    static getClosedCandlesAsOf(candles: ICandle[], timeframe: string | number | undefined, asOfTimestamp: Date): ICandle[];
    /**
     * Validates single candle geometry and fields.
     */
    static validateCandle(c: ICandle): boolean;
    /**
     * Validates, cleans, deduplicates, and sorts a candle array in strict chronological order.
     * Rejects malformed / NaN / negative / inconsistent candles.
     */
    static normalize(candles: ICandle[], options?: ICandleNormalizerOptions): ICandle[];
}
