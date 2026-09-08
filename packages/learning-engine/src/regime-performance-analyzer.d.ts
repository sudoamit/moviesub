import { TradingExperience } from './types';
export interface IRegimeStats {
    regime: string;
    tradeCount: number;
    winRate: number;
    expectancy: number;
    averageR: number;
    profitFactor: number;
    maxDrawdownR: number;
    sharpeRatio: number;
    sortinoRatio: number;
}
export declare class RegimePerformanceAnalyzer {
    /**
     * Evaluates strategy performance isolated across individual market regimes.
     */
    static analyze(experiences: TradingExperience[]): IRegimeStats[];
}
