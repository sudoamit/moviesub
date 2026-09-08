export type TradeManagementStage = 'STAGE_1_INITIAL' | 'STAGE_2_BREAKEVEN' | 'STAGE_3_TRAILING';
export interface IDynamicTrailingState {
    stage: TradeManagementStage;
    stageBadge: string;
    currentStopLoss: number;
    isRiskFree: boolean;
    partialBookedPercent: number;
    profitLockedAmount: number;
    recommendedAction: string;
    trailingStepPrice: number;
}
export declare class TrailingEngine {
    /**
     * Evaluates real-time position price action against TP milestones and updates Stop Loss dynamically
     */
    static evaluate(entryPrice: number, initialStopLoss: number, tp1Price: number, tp2Price: number, currentPrice: number, direction?: 'BULLISH' | 'BEARISH', atr?: number): IDynamicTrailingState;
}
