import { ICandle } from '@quant/shared';
import { IIndicatorSummary } from './types';
/**
 * Calculates a comprehensive snapshot of primary technical indicators for the latest candle
 */
export declare function calculateIndicatorSummary(candles: ICandle[]): IIndicatorSummary;
