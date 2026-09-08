import { ICandle } from '@quant/shared';
import { IADXResult } from './types';
/**
 * Calculates Average Directional Index (ADX) along with +DI and -DI
 */
export declare function calculateADX(candles: ICandle[], period?: number): IADXResult;
