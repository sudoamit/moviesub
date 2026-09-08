import { ICandle } from '@quant/shared';
import { ISMCAnalysisConfig, ISMCAnalysisResult } from './types';
export declare class SMCAnalyzer {
    /**
     * Performs full deterministic Smart Money Concepts (SMC) analysis on candle series
     * with strict point-in-time correctness.
     */
    static analyze(rawCandles: ICandle[], config?: ISMCAnalysisConfig): ISMCAnalysisResult;
}
