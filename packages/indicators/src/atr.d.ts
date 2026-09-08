import { ICandle } from '@quant/shared';
/**
 * Calculates True Range (TR) for each candle
 */
export declare function calculateTrueRange(candles: ICandle[]): number[];
/**
 * Calculates Average True Range (ATR) using standard Wilder's smoothing
 */
export declare function calculateATR(candles: ICandle[], period?: number): (number | null)[];
