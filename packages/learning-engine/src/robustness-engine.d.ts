import { StrategyCandidate, TradingExperience } from './types';
export interface IRobustnessReport {
    candidateId: string;
    normalCostExpectancy: number;
    doubleCostExpectancy: number;
    tripleCostExpectancy: number;
    survivedDoubleCosts: boolean;
    survivedTripleCosts: boolean;
    breakEvenCostR: number;
    isRobust: boolean;
}
export declare class RobustnessEngine {
    /**
     * Stress tests candidate strategies against aggressive transaction costs, slippage, and spread widening.
     */
    static evaluateCosts(candidate: StrategyCandidate, experiences: TradingExperience[]): IRobustnessReport;
}
