import { Direction, ICandle, MTFMode, Timeframe } from '@quant/shared';
import { ISMCAnalysisResult } from './types';
export interface IMTFTimeframeData {
    timeframe: Timeframe | string;
    candles: ICandle[];
    analysis?: ISMCAnalysisResult;
}
export interface IMTFAnalysisResult {
    executionTimeframe: Timeframe | string;
    htfBias: Direction;
    htf1Timeframe: Timeframe | string;
    htf1Trend: Direction;
    htf2Timeframe?: Timeframe | string;
    htf2Trend?: Direction;
    isAligned: boolean;
    alignmentScore: number;
    reason: string;
}
export declare class MultiTimeframeAnalyzer {
    static getTimeframeDurationMs(tf: Timeframe | string): number;
    /**
     * Filters HTF candles strictly to only those whose close time is <= maxAllowedCloseTime.
     * Eliminates look-ahead bias across all multi-timeframe analysis.
     */
    static filterClosedHTFCandles(htfCandles: ICandle[], htfTimeframe: Timeframe | string, maxAllowedCloseTime: number): ICandle[];
    /**
     * Analyzes Higher Timeframe (HTF) market structure to establish directional bias for lower timeframe execution
     * with guaranteed zero look-ahead bias.
     */
    static analyzeMTF(executionTf: IMTFTimeframeData, htf1: IMTFTimeframeData, htf2?: IMTFTimeframeData, mode?: MTFMode, asOfTimestamp?: Date): IMTFAnalysisResult;
}
