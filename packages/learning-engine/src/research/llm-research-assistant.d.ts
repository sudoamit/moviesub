import { IErrorReport } from '../types';
import { ResearchHypothesis } from './types';
export declare class LLMResearchAssistant {
    /**
     * Builds a structured prompt for the LLM to analyze empirical trading diagnostics.
     */
    static buildResearchPrompt(data: {
        errorReport: IErrorReport;
        regimeDistribution: Record<string, number>;
        currentExpectancy: number;
        winRate: number;
    }): string;
    /**
     * Parses LLM structured output into testable ResearchHypothesis candidate objects.
     */
    static parseLLMHypotheses(llmResponse: string, baselineExpectancy: number): Partial<ResearchHypothesis>[];
}
