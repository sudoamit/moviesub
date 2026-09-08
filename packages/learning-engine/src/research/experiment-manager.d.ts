import { ICandle } from '@quant/shared';
import { MissedTradeStressResult, MonteCarloMetrics, PerformanceMetrics, ResearchExperiment, ResearchHypothesis, SlippageStressResult } from './types';
export declare class ExperimentManager {
    /**
     * Calculates detailed performance metrics from simulated trade PnL arrays.
     */
    static calculatePerformanceMetrics(trades: {
        pnlR: number;
        pnl: number;
        isWin: boolean;
        durationMin?: number;
        mfe?: number;
        mae?: number;
    }[]): PerformanceMetrics;
    /**
     * Runs Slippage Stress Testing across 1x, 2x, and 3x execution slippage degradation.
     */
    static runSlippageStress(trades: {
        pnlR: number;
        pnl: number;
        isWin: boolean;
    }[]): SlippageStressResult[];
    /**
     * Runs Missed-Trade Execution Stress Testing (100%, 95%, 90%, 85% execution rates).
     */
    static runMissedTradeStress(trades: {
        pnlR: number;
        pnl: number;
        isWin: boolean;
    }[]): MissedTradeStressResult[];
    /**
     * Executes Monte Carlo Trade Order Randomization (shuffling trade order without changing underlying outcomes).
     */
    static runMonteCarloSimulation(trades: {
        pnlR: number;
    }[], iterations?: number): MonteCarloMetrics;
    /**
     * Computes strategy complexity penalty based on count of rules, thresholds, and features.
     */
    static calculateComplexityPenalty(rulesCount: number, thresholdCount: number, featureCount: number): number;
    /**
     * Executes a full research experiment from a structured hypothesis.
     */
    static executeExperiment(hypothesis: ResearchHypothesis, candles: ICandle[], options: {
        instrument: string;
        timeframe: string;
        baseStrategyVersion?: string;
        candidateStrategyVersion?: string;
    }): Promise<ResearchExperiment>;
}
