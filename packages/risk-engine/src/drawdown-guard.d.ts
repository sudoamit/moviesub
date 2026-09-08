export interface IDrawdownStatus {
    currentEquity: number;
    peakEquity: number;
    startingDayEquity: number;
    totalDrawdownAmount: number;
    totalDrawdownPercent: number;
    dailyDrawdownAmount: number;
    dailyDrawdownPercent: number;
    isTradingHalted: boolean;
    riskReductionMultiplier: number;
    warningMessage?: string;
}
export interface IDrawdownGuardOptions {
    maxAccountDrawdownPercent?: number;
    maxDailyDrawdownPercent?: number;
}
export declare class DrawdownGuard {
    /**
     * Evaluates equity curve and drawdown limits to protect capital
     */
    static evaluateDrawdown(currentEquity: number, peakEquity: number, startingDayEquity: number, options?: IDrawdownGuardOptions): IDrawdownStatus;
}
