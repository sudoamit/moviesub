import { PromotionCriteria, PromotionEvaluationResult, StrategyCandidate } from './types';
export declare class PromotionGate {
    static readonly DEFAULT_CRITERIA: PromotionCriteria;
    /**
     * Evaluates a strategy candidate against institutional promotion criteria.
     */
    static evaluateCandidate(candidate: StrategyCandidate, criteria?: PromotionCriteria): PromotionEvaluationResult;
    /**
     * Computes the recommended Canary Deployment capital allocation stage (5% -> 10% -> 25% -> 50% -> 100%).
     */
    static calculateCanaryAllocation(candidate: StrategyCandidate, liveCanaryTradesCount: number, canaryExpectancyR: number, baselineExpectancyR: number): {
        allocationPct: number;
        stageName: 'INITIAL_CANARY' | 'MODERATE_EXPANSION' | 'HALF_CAPITAL' | 'FULL_PRODUCTION';
        recommendation: string;
    };
}
