import { TradingExperience } from '../types';
import { ResearchHypothesis } from './types';
export declare class HypothesisEngine {
    /**
     * Validates that a hypothesis satisfies strict scientific criteria:
     * non-vague, parameterized condition, population, sample size, baseline, and expected effect.
     */
    static validateHypothesisStructure(hypothesis: ResearchHypothesis): boolean;
    /**
     * Mines empirical trade experiences and error logs to generate structured, testable hypotheses.
     */
    static mineHypothesesFromExperiences(experiences: TradingExperience[]): ResearchHypothesis[];
}
