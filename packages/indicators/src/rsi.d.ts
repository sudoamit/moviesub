import { ICandle } from '@quant/shared';
/**
 * Calculates Relative Strength Index (RSI) using Wilder's smoothed averages
 */
export declare function calculateRSI(data: ICandle[] | number[], period?: number): (number | null)[];
