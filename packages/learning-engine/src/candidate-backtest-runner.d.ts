import { IBacktestTrade } from '@quant/shared';
import { StrategyCandidate, TradingExperience } from './types';
export interface CandidateExecutionConfig {
    candidateId: string;
    candidateVersion: string;
    configHash: string;
    minMtfScore?: number;
    stopLossAtrMultiplier?: number;
    enablePartialTp1Trailing?: boolean;
    highVolatilitySizingMultiplier?: number;
    sizingMultiplier?: number;
    filterRegime?: string;
    minProbability?: number;
    conditionRules?: string[];
    fittedValue?: number;
}
export interface CandidateExecutionResult {
    candidateId: string;
    totalTrades: number;
    trades: IBacktestTrade[];
    rMultiples: number[];
    netPnL: number;
    grossProfit: number;
    grossLoss: number;
    winRate: number;
    expectancyR: number;
    profitFactor: number;
    maxDrawdownR: number;
}
export declare class CandidateBacktestRunner {
    /**
     * Converts a StrategyCandidate into an executable strategy configuration object.
     */
    static createExecutionConfig(candidate: StrategyCandidate): CandidateExecutionConfig;
    /**
     * Replays trading experiences through the authoritative ExecutionSimulator from @quant/backtesting.
     */
    static runCandidateBacktest(candidate: StrategyCandidate, experiences: TradingExperience[]): CandidateExecutionResult;
}
