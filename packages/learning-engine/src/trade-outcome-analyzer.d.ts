import { Direction, ISignalSetup } from '@quant/shared';
import { FailureMode, TradeOutcomeClassification } from './types';
export interface ITradeOutcomeInputs {
    tradeId: string;
    symbol: string;
    direction: Direction;
    entryPrice: number;
    entryTime: Date;
    exitPrice: number;
    exitTime: Date;
    stopLoss: number;
    takeProfit1?: number;
    takeProfit2?: number;
    riskAmount?: number;
    pnl: number;
    pnlR: number;
    signalSetup?: ISignalSetup;
    candlesDuringTrade?: {
        high: number;
        low: number;
        timestamp: Date;
    }[];
    marketRegime?: string;
    isExecutionSlippageExcessive?: boolean;
}
export interface IOutcomeAnalysisResult {
    outcomeClassification: TradeOutcomeClassification;
    outcomeStatus: 'WIN' | 'LOSS' | 'TIMEOUT' | 'SCRATCH';
    maxFavorableExcursion: number;
    maxAdverseExcursion: number;
    holdingTimeSeconds: number;
    failureReasons: FailureMode[];
    isExecutionSlippageExcessive: boolean;
    setupQualityScore: number;
}
export declare class TradeOutcomeAnalyzer {
    /**
     * Evaluates decision quality vs realized outcome to classify the trade.
     */
    static analyze(inputs: ITradeOutcomeInputs): IOutcomeAnalysisResult;
}
