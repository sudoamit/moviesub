"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.calculateMACD = calculateMACD;
const ema_1 = require("./ema");
/**
 * Calculates MACD (Moving Average Convergence Divergence)
 */
function calculateMACD(prices, fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) {
    const len = prices.length;
    if (!prices || len === 0) {
        return { macd: [], signal: [], histogram: [] };
    }
    const fastEMA = (0, ema_1.calculateEMA)(prices, fastPeriod);
    const slowEMA = (0, ema_1.calculateEMA)(prices, slowPeriod);
    const macdLine = new Array(len).fill(null);
    const validMacdValues = [];
    const validMacdIndices = [];
    for (let i = 0; i < len; i++) {
        const fast = fastEMA[i];
        const slow = slowEMA[i];
        if (fast !== null && slow !== null) {
            const val = fast - slow;
            macdLine[i] = val;
            validMacdValues.push(val);
            validMacdIndices.push(i);
        }
    }
    const signalEMA = (0, ema_1.calculateEMA)(validMacdValues, signalPeriod);
    const signalLine = new Array(len).fill(null);
    const histogram = new Array(len).fill(null);
    for (let k = 0; k < validMacdValues.length; k++) {
        const origIdx = validMacdIndices[k];
        const sig = signalEMA[k];
        signalLine[origIdx] = sig;
        if (sig !== null && macdLine[origIdx] !== null) {
            histogram[origIdx] = macdLine[origIdx] - sig;
        }
    }
    return { macd: macdLine, signal: signalLine, histogram };
}
//# sourceMappingURL=macd.js.map