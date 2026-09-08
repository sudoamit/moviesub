import { TradingExperience } from './types';
export interface IStrategyPerformanceReport {
    totalTrades: number;
    winCount: number;
    lossCount: number;
    scratchCount: number;
    timeoutCount: number;
    winRate: number;
    expectancy: number;
    averageMFE: number;
    averageMAE: number;
    mfeMaeRatio: number;
    averageHoldingTimeMinutes: number;
    goodTradeLossRatio: number;
    badTradeWinRatio: number;
    tp1HitRate: number;
    tp2HitRate: number;
}
export declare class StrategyPerformanceAnalyzer {
    /**
     * Performs deep trade management, execution quality, and MFE/MAE analytics.
     */
    static analyze(experiences: TradingExperience[]): IStrategyPerformanceReport;
}
