import { ReturnMetrics } from './quant-types';
export declare class ReturnAnalysisEngine {
    /**
     * Computes multi-bar returns, rolling moments, skewness, and kurtosis.
     * Pure point-in-time calculation using closes <= evaluation index.
     */
    static calculate(closes: number[]): ReturnMetrics;
}
