import { ICandle } from '@quant/shared';
import { ISMCAnalysisResult } from '../types';
import { QuantState } from './quant-types';
export declare class QuantFeatureEngine {
    /**
     * Computes the complete point-in-time QuantState for a symbol and historical candle series.
     */
    static extractQuantState(symbol: string, candles: ICandle[], smcAnalysis?: ISMCAnalysisResult | null): QuantState;
}
