import { TradingExperience } from './types';
export interface IRollbackCheckResult {
    shouldRollback: boolean;
    activeStrategyVersion: string;
    previousStableVersion: string;
    recentExpectancyR: number;
    expectedBaselineR: number;
    triggerReason?: string;
}
export declare class RollbackManager {
    /**
     * Monitors live strategy performance against expected baseline and executes deterministic rollback upon degradation.
     */
    static checkAndExecuteRollback(recentExperiences: TradingExperience[], minTradesForEvaluation?: number): IRollbackCheckResult;
}
