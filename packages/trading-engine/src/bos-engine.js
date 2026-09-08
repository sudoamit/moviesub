"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BOSEngine = void 0;
const shared_1 = require("@quant/shared");
const indicators_1 = require("@quant/indicators");
class BOSEngine {
    /**
     * Detects valid Bullish and Bearish Breaks of Structure (BOS)
     */
    static detectBOS(candles, swings, options = {}) {
        if (!candles || candles.length === 0 || !swings || swings.length === 0) {
            return [];
        }
        const confType = options.confirmationType ?? shared_1.BOSConfirmationType.CANDLE_CLOSE_AND_DISPLACEMENT;
        const displacementThreshold = options.displacementThresholdAtr ?? 1.0;
        const atr = (0, indicators_1.calculateATR)(candles, 14);
        const bosEvents = [];
        const swingHighs = swings.filter((s) => s.type === shared_1.StructureType.SWING_HIGH ||
            s.type === shared_1.StructureType.HIGHER_HIGH ||
            s.type === shared_1.StructureType.LOWER_HIGH);
        const swingLows = swings.filter((s) => s.type === shared_1.StructureType.SWING_LOW ||
            s.type === shared_1.StructureType.HIGHER_LOW ||
            s.type === shared_1.StructureType.LOWER_LOW);
        // Track active unbroken swing levels
        const activeHighs = new Set(swingHighs);
        const activeLows = new Set(swingLows);
        for (let i = 0; i < candles.length; i++) {
            const candle = candles[i];
            const candleAtr = atr[i] || Math.max(1, candle.high - candle.low);
            const candleBody = Math.abs(candle.close - candle.open);
            const displacementRatio = candleBody / candleAtr;
            // 1. Check for Bullish BOS (Breaking Swing High)
            for (const high of Array.from(activeHighs)) {
                // Can only break AFTER the swing point was fully confirmed
                if (i <= high.confirmedAtIndex)
                    continue;
                let isBroken = false;
                if (confType === shared_1.BOSConfirmationType.WICK_BREAK) {
                    isBroken = candle.high > high.price;
                }
                else if (confType === shared_1.BOSConfirmationType.CANDLE_CLOSE) {
                    isBroken = candle.close > high.price;
                }
                else {
                    // CANDLE_CLOSE_AND_DISPLACEMENT
                    isBroken = candle.close > high.price && displacementRatio >= displacementThreshold;
                }
                if (isBroken) {
                    bosEvents.push({
                        direction: shared_1.Direction.BULLISH,
                        brokenLevel: high.price,
                        brokenSwingPoint: high,
                        breakPrice: candle.close,
                        candleIndex: i,
                        timestamp: candle.timestamp,
                        isConfirmed: true,
                        displacementRatio,
                    });
                    activeHighs.delete(high); // Level is broken
                }
            }
            // 2. Check for Bearish BOS (Breaking Swing Low)
            for (const low of Array.from(activeLows)) {
                if (i <= low.confirmedAtIndex)
                    continue;
                let isBroken = false;
                if (confType === shared_1.BOSConfirmationType.WICK_BREAK) {
                    isBroken = candle.low < low.price;
                }
                else if (confType === shared_1.BOSConfirmationType.CANDLE_CLOSE) {
                    isBroken = candle.close < low.price;
                }
                else {
                    isBroken = candle.close < low.price && displacementRatio >= displacementThreshold;
                }
                if (isBroken) {
                    bosEvents.push({
                        direction: shared_1.Direction.BEARISH,
                        brokenLevel: low.price,
                        brokenSwingPoint: low,
                        breakPrice: candle.close,
                        candleIndex: i,
                        timestamp: candle.timestamp,
                        isConfirmed: true,
                        displacementRatio,
                    });
                    activeLows.delete(low); // Level is broken
                }
            }
        }
        return bosEvents;
    }
}
exports.BOSEngine = BOSEngine;
//# sourceMappingURL=bos-engine.js.map