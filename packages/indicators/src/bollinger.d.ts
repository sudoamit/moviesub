import { ICandle } from '@quant/shared';
import { IBollingerBandsResult } from './types';
/**
 * Calculates Bollinger Bands (Upper, Middle, Lower, Bandwidth, %B)
 */
export declare function calculateBollingerBands(data: ICandle[] | number[], period?: number, stdDevMultiplier?: number): IBollingerBandsResult;
