export interface IMACDResult {
    macd: (number | null)[];
    signal: (number | null)[];
    histogram: (number | null)[];
}
/**
 * Calculates MACD (Moving Average Convergence Divergence)
 */
export declare function calculateMACD(prices: number[], fastPeriod?: number, slowPeriod?: number, signalPeriod?: number): IMACDResult;
