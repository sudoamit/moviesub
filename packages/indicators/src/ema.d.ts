/**
 * Calculates Exponential Moving Average (EMA)
 * Multiplier: 2 / (period + 1)
 * Initial seed: SMA of first 'period' bars
 */
export declare function calculateEMA(values: number[], period: number): (number | null)[];
