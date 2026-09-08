import { TradingExperience } from './types';
export interface CounterfactualExitScenario {
    scenarioName: 'TP1_FIXED' | 'TP2_STANDARD' | 'TP3_RUNNER' | 'TRAILING_BREAKEVEN' | 'TIME_BASED_CUTOFF';
    simulatedExitPrice: number;
    simulatedPnLR: number;
    realizedDeltaR: number;
    wasSuperiorToActual: boolean;
}
export interface TradeCounterfactualAnalysis {
    tradeId: string;
    symbol: string;
    actualExitPrice: number;
    actualPnLR: number;
    scenarios: CounterfactualExitScenario[];
    optimalScenario: CounterfactualExitScenario;
    opportunityLossR: number;
}
export declare class CounterfactualAnalyzer {
    /**
     * Analyzes a closed trading experience under alternative exit policies.
     * STRICT POINT-IN-TIME GUARANTEE: Uses only ex-post trade telemetry for post-mortem learning,
     * never leaking future information into live decision gates.
     */
    static analyzeExperience(exp: TradingExperience): TradeCounterfactualAnalysis;
    /**
     * Evaluates counterfactuals across a portfolio of experiences to identify system-wide exit inefficiencies.
     */
    static analyzeBatch(experiences: TradingExperience[]): {
        totalOpportunityLossR: number;
        recommendedExitPolicy: string;
        tp1SuperiorityPct: number;
        tp2SuperiorityPct: number;
        trailingBESuperiorityPct: number;
    };
}
