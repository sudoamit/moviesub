import { DriftReport, TradingExperience } from './types';
export declare class DriftDetector {
    /**
     * Evaluates 5-tier drift metrics across feature distributions, predictions, performance, regimes, and execution.
     */
    static evaluateDrift(recentExperiences: TradingExperience[], baselineExpectancyR?: number): DriftReport;
}
