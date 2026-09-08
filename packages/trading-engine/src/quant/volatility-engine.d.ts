import { ICandle } from '@quant/shared';
import { VolatilityState } from './quant-types';
export interface IGarchParams {
    omega: number;
    alpha: number;
    beta: number;
    unconditionalVariance: number;
}
export declare class VolatilityEngine {
    /**
     * Parkinson High-Low Volatility Estimator
     */
    static calculateParkinson(candles: ICandle[], window?: number): number;
    /**
     * Garman-Klass OHLC Volatility Estimator (efficient & unbiased)
     */
    static calculateGarmanKlass(candles: ICandle[], window?: number): number;
    /**
     * Rolling Realized Volatility from logarithmic returns
     */
    static calculateRealizedVolatility(closes: number[], window?: number): number;
    /**
     * Fits GARCH(1,1) using Variance Targeting on rolling returns.
     * Returns fitted parameters or null if numerical optimization fails.
     */
    static fitGarch11(returns: number[]): IGarchParams | null;
    /**
     * Forecasts next-period volatility using EWMA baseline (RiskMetrics lambda = 0.94)
     */
    static forecastEwma(returns: number[], lambda?: number): number;
    /**
     * Full Volatility Forecast with 3-Tier Graceful Fallback:
     * Tier 1: GARCH(1,1) -> Tier 2: EWMA(0.94) -> Tier 3: Realized Rolling Volatility
     */
    static computeVolatilityState(candles: ICandle[]): VolatilityState;
}
