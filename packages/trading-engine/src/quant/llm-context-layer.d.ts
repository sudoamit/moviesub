import { LLMTradeAssessment, PointInTimeMarketSnapshot } from './quant-types';
export declare class LLMContextLayer {
    static readonly PROMPT_VERSION = "2.0.0";
    static readonly MODEL_VERSION = "gemini-1.5-flash-quant";
    /**
     * Builds the structured JSON prompt for LLM qualitative context evaluation.
     */
    static buildStructuredPrompt(snapshot: PointInTimeMarketSnapshot): string;
    /**
     * Deterministic fallback assessment if LLM is offline or disabled.
     */
    static getDeterministicFallback(snapshot: PointInTimeMarketSnapshot): LLMTradeAssessment;
    /**
     * Safely parses and validates an LLM assessment response.
     */
    static parseAssessment(rawJson: string, snapshot: PointInTimeMarketSnapshot): LLMTradeAssessment;
}
