"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.calculateEMA = calculateEMA;
/**
 * Calculates Exponential Moving Average (EMA)
 * Multiplier: 2 / (period + 1)
 * Initial seed: SMA of first 'period' bars
 */
function calculateEMA(values, period) {
    if (period <= 0 || !values || values.length === 0) {
        return [];
    }
    const result = new Array(values.length).fill(null);
    if (values.length < period) {
        return result;
    }
    const multiplier = 2 / (period + 1);
    // Initial SMA seed
    let sum = 0;
    for (let i = 0; i < period; i++) {
        sum += values[i];
    }
    let prevEma = sum / period;
    result[period - 1] = prevEma;
    // Subsequent EMAs
    for (let i = period; i < values.length; i++) {
        const currentEma = values[i] * multiplier + prevEma * (1 - multiplier);
        result[i] = currentEma;
        prevEma = currentEma;
    }
    return result;
}
//# sourceMappingURL=ema.js.map