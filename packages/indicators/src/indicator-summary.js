"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.calculateIndicatorSummary = calculateIndicatorSummary;
const types_1 = require("./types");
const ema_1 = require("./ema");
const sma_1 = require("./sma");
const rsi_1 = require("./rsi");
const atr_1 = require("./atr");
const adx_1 = require("./adx");
const bollinger_1 = require("./bollinger");
const vwap_1 = require("./vwap");
/**
 * Calculates a comprehensive snapshot of primary technical indicators for the latest candle
 */
function calculateIndicatorSummary(candles) {
    if (!candles || candles.length === 0) {
        return {
            ema9: null,
            ema20: null,
            ema50: null,
            ema200: null,
            sma20: null,
            sma50: null,
            rsi14: null,
            atr14: null,
            adx14: null,
            plusDI: null,
            minusDI: null,
            bollingerUpper: null,
            bollingerMiddle: null,
            bollingerLower: null,
            vwap: null,
        };
    }
    const lastIdx = candles.length - 1;
    const closes = (0, types_1.extractPrices)(candles, 'close');
    const ema9 = (0, ema_1.calculateEMA)(closes, 9);
    const ema20 = (0, ema_1.calculateEMA)(closes, 20);
    const ema50 = (0, ema_1.calculateEMA)(closes, 50);
    const ema200 = (0, ema_1.calculateEMA)(closes, 200);
    const sma20 = (0, sma_1.calculateSMA)(closes, 20);
    const sma50 = (0, sma_1.calculateSMA)(closes, 50);
    const rsi14 = (0, rsi_1.calculateRSI)(candles, 14);
    const atr14 = (0, atr_1.calculateATR)(candles, 14);
    const adx14 = (0, adx_1.calculateADX)(candles, 14);
    const bb20 = (0, bollinger_1.calculateBollingerBands)(candles, 20, 2);
    const vwap = (0, vwap_1.calculateVWAP)(candles);
    return {
        ema9: ema9[lastIdx] ?? null,
        ema20: ema20[lastIdx] ?? null,
        ema50: ema50[lastIdx] ?? null,
        ema200: ema200[lastIdx] ?? null,
        sma20: sma20[lastIdx] ?? null,
        sma50: sma50[lastIdx] ?? null,
        rsi14: rsi14[lastIdx] ?? null,
        atr14: atr14[lastIdx] ?? null,
        adx14: adx14.adx[lastIdx] ?? null,
        plusDI: adx14.plusDI[lastIdx] ?? null,
        minusDI: adx14.minusDI[lastIdx] ?? null,
        bollingerUpper: bb20.upper[lastIdx] ?? null,
        bollingerMiddle: bb20.middle[lastIdx] ?? null,
        bollingerLower: bb20.lower[lastIdx] ?? null,
        vwap: vwap[lastIdx] ?? null,
    };
}
//# sourceMappingURL=indicator-summary.js.map