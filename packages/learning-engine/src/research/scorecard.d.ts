import { LearningScorecard, SelfImprovementScorecard } from './types';
export declare class ScorecardEngine {
    /**
     * Generates the daily/weekly Self-Improvement Scorecard summarizing empirical research velocity.
     */
    static generateSelfImprovementScorecard(data: {
        experiencesCount: number;
        newPatternsCount: number;
        currentProductionVersion: string;
        shadowCount: number;
    }): SelfImprovementScorecard;
    /**
     * Generates the Learning Scorecard displaying version-over-version statistical evolution.
     */
    static generateLearningScorecard(): LearningScorecard;
}
