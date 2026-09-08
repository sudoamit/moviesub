"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.calculateBollingerBands = calculateBollingerBands;
const types_1 = require("./types");
const sma_1 = require("./sma");
/**
 * Calculates Bollinger Bands (Upper, Middle, Lower, Bandwidth, %B)
 */
function calculateBollingerBands(data, period = 20, stdDevMultiplier = 2) {
    if (!data || data.length === 0 || period <= 0) {
        return { upper: [], middle: [], lower: [], bandwidth: [], percentB: [] };
    }
    const prices = typeof data[0] === 'number' ? data : (0, types_1.extractPrices)(data, 'close');
    const len = prices.length;
    const middle = (0, sma_1.calculateSMA)(prices, period);
    const upper = new Array(len).fill(null);
    const lower = new Array(len).fill(null);
    const bandwidth = new Array(len).fill(null);
    const percentB = new Array(len).fill(null);
    for (let i = period - 1; i < len; i++) {
        const ma = middle[i];
        let varianceSum = 0;
        for (let j = i - period + 1; j <= i; j++) {
            const diff = prices[j] - ma;
            varianceSum += diff * diff;
        }
        const stdDev = Math.sqrt(varianceSum / period);
        const up = ma + stdDevMultiplier * stdDev;
        const low = ma - stdDevMultiplier * stdDev;
        upper[i] = up;
        lower[i] = low;
        if (ma !== 0) {
            bandwidth[i] = (up - low) / ma;
        }
        const width = up - low;
        if (width !== 0) {
            percentB[i] = (prices[i] - low) / width;
        }
        else {
            percentB[i] = 0.5;
        }
    }
    return { upper, middle, lower, bandwidth, percentB };
}
//# sourceMappingURL=bollinger.js.map