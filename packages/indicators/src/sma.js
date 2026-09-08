"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.calculateSMA = calculateSMA;
/**
 * Calculates Simple Moving Average (SMA)
 * @param values Array of numbers (e.g. close prices)
 * @param period Lookback period
 */
function calculateSMA(values, period) {
    if (period <= 0 || !values || values.length === 0) {
        return [];
    }
    const result = new Array(values.length).fill(null);
    let sum = 0;
    for (let i = 0; i < values.length; i++) {
        sum += values[i];
        if (i >= period) {
            sum -= values[i - period];
        }
        if (i >= period - 1) {
            result[i] = sum / period;
        }
    }
    return result;
}
//# sourceMappingURL=sma.js.map