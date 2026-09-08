import { ISignalSetup } from '@quant/shared';
export type NoTradeReason = 'HTF_CONFLICT' | 'LOW_LIQUIDITY' | 'HIGH_VOLATILITY' | 'LOW_EXPECTED_VALUE' | 'BAD_RR' | 'DAILY_RISK_LIMIT' | 'DRAWDOWN_LIMIT' | 'CORRELATED_EXPOSURE' | 'SESSION_FILTER' | 'MODEL_UNCERTAINTY' | 'EXECUTION_RISK';
export interface INoTradeContext {
    isSessionActive?: boolean;
    marketRegime?: string;
    expectedR?: number;
    mlProbability?: number;
    isDrawdownHalted?: boolean;
    correlatedExposurePercent?: number;
    minScoreThreshold?: number;
    minRRThreshold?: number;
    minExpectedR?: number;
}
export interface ITradeDecision {
    decision: 'ALLOW' | 'BLOCK';
    isAllowed: boolean;
    reasons: NoTradeReason[];
    explanation: string;
    confidence: number;
    riskAdjustedExpectancy: number;
}
export declare class NoTradeEngine {
    /**
     * Evaluates whether a generated signal meets strict institutional risk-adjusted expectancy criteria.
     * "NO TRADE" is treated as a first-class, capital-preserving decision.
     */
    static evaluateTradePermission(signal: ISignalSetup, context?: INoTradeContext): ITradeDecision;
}
