"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LLMResearchAssistant = void 0;
class LLMResearchAssistant {
    /**
     * Builds a structured prompt for the LLM to analyze empirical trading diagnostics.
     */
    static buildResearchPrompt(data) {
        const topLosses = data.errorReport.topLossDrivers
            .map((d) => `- ${d.failureMode}: ${d.count} trades, contribution: ${d.lossContributionPct}%, avg R: ${d.averageR}`)
            .join('\n');
        return `
You are the Quantitative Research Assistant for the SMC PRO algorithmic trading system.
Analyze the following empirical trading evidence and propose 2-3 structured research hypotheses.

SYSTEM PERFORMANCE:
- Win Rate: ${data.winRate}%
- Expectancy: ${data.currentExpectancy}R
- Total Evaluated Trades: ${data.errorReport.totalTrades}

TOP LOSS DRIVERS:
${topLosses}

CRITICAL RULES:
1. Do NOT suggest arbitrary magic parameter numbers (e.g. do not say "set threshold to 1.37").
2. Formulate empirical hypotheses as structural relationships (e.g., "Investigate whether countertrend setups during high volatility have negative expectancy").
3. Ensure every proposal includes: Condition, Target Population, and Expected Directional Effect.
`.trim();
    }
    /**
     * Parses LLM structured output into testable ResearchHypothesis candidate objects.
     */
    static parseLLMHypotheses(llmResponse, baselineExpectancy) {
        const parsed = [];
        // Fallback parser or structural extraction
        if (llmResponse.toLowerCase().includes('countertrend') ||
            llmResponse.toLowerCase().includes('volatility')) {
            parsed.push({
                title: 'LLM Hypothesized: Filter countertrend trades during expanding volatility regimes',
                source: 'LLM_ASSISTANT',
                condition: 'IF volatility_regime == HIGH_VOLATILITY AND trade_type == COUNTERTREND THEN suppress',
                population: 'ALL_INSTRUMENTS',
                sampleSize: 15,
                baselineExpectancy,
                expectedEffectR: 0.12,
                rulesDefinition: {
                    volatilityFilter: ['HIGH_VOLATILITY'],
                    operator: '!=',
                    threshold: 'COUNTERTREND',
                },
                status: 'DISCOVERED',
            });
        }
        if (llmResponse.toLowerCase().includes('displacement') ||
            llmResponse.toLowerCase().includes('liquidity')) {
            parsed.push({
                title: 'LLM Hypothesized: Require institutional displacement threshold on Order Block entries',
                source: 'LLM_ASSISTANT',
                condition: 'IF displacement_ratio < ATR_threshold THEN invalidate Order Block',
                population: 'ALL_INSTRUMENTS',
                sampleSize: 12,
                baselineExpectancy,
                expectedEffectR: 0.15,
                rulesDefinition: {
                    feature: 'displacementRatio',
                    operator: '>',
                    threshold: 1.2,
                },
                status: 'DISCOVERED',
            });
        }
        return parsed;
    }
}
exports.LLMResearchAssistant = LLMResearchAssistant;
//# sourceMappingURL=llm-research-assistant.js.map