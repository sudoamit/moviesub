import { IErrorReport, TradingExperience } from './types';
export declare class ErrorAnalyzer {
    /**
     * Analyzes an array of completed trading experiences to compile a detailed Error Report.
     */
    static analyze(experiences: TradingExperience[]): IErrorReport;
    /**
     * Dissects high-confidence losing predictions (P(win) >= 0.75 that resulted in loss) to isolate overconfidence patterns.
     */
    static analyzeHighConfidenceLosses(experiences: TradingExperience[]): {
        count: number;
        frequencyPct: number;
        averageLossR: number;
        prominentRegimes: Record<string, number>;
        prominentFailureReasons: Record<string, number>;
        calibrationRecommendation: string;
    };
    /**
     * Computes conditional win probabilities: P(win | regime), P(win | volatility), P(win | session), P(win | setup).
     */
    static computeConditionalProbabilities(experiences: TradingExperience[]): {
        byRegime: Record<string, {
            winRate: number;
            count: number;
            expectancyR: number;
        }>;
        byVolatility: Record<string, {
            winRate: number;
            count: number;
            expectancyR: number;
        }>;
        bySession: Record<string, {
            winRate: number;
            count: number;
            expectancyR: number;
        }>;
        bySetup: Record<string, {
            winRate: number;
            count: number;
            expectancyR: number;
        }>;
    };
}
