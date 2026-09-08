import { TradingExperience } from './types';
export interface IVolatilityBucketStats {
    bucket: string;
    tradeCount: number;
    winRate: number;
    expectancy: number;
    averageR: number;
    profitFactor: number;
    forecastMae: number;
    forecastRmse: number;
    forecastCorrelation: number;
}
export declare class VolatilityPerformanceAnalyzer {
    /**
     * Tracks volatility forecasting accuracy and strategy performance across volatility regimes.
     */
    static analyze(experiences: TradingExperience[]): IVolatilityBucketStats[];
}
