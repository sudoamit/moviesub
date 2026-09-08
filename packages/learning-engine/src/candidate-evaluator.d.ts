import { StrategyCandidate, TradingExperience } from './types';
export interface ICandidateEvaluationResult {
    candidateId: string;
    passed: boolean;
    baselineExpectancy: number;
    candidateExpectancy: number;
    expectancyDelta: number;
    profitFactor: number;
    maxDrawdownPercent: number;
    totalSimulatedTrades: number;
    simulatedRMultiples: number[];
    rejectionReason?: string;
}
export declare class CandidateEvaluator {
    /**
     * Orchestrates candidate strategy evaluation against historical trading experiences
     * by delegating replay directly to CandidateBacktestRunner and authoritative backtest execution.
     */
    static evaluate(candidate: StrategyCandidate, experiences: TradingExperience[], costPerTradeR?: number): ICandidateEvaluationResult;
}
