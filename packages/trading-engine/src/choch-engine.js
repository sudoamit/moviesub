"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CHOCHEngine = void 0;
const shared_1 = require("@quant/shared");
class CHOCHEngine {
    /**
     * Detects market structure trend reversals (Change of Character) with strictly zero look-ahead bias.
     * A CHOCH occurs when price breaks the structural pivot of an opposing established trend:
     * - Bullish CHOCH: In a Bearish trend, price breaks above the most recent confirmed Lower High (or Swing High).
     * - Bearish CHOCH: In a Bullish trend, price breaks below the most recent confirmed Higher Low (or Swing Low).
     */
    static detectCHOCH(candles, swings) {
        if (!candles || candles.length === 0 || !swings || swings.length < 2) {
            return [];
        }
        const chochEvents = [];
        let currentTrend = shared_1.Direction.NEUTRAL;
        // Track active unbroken swing levels
        const brokenSwingIndices = new Set();
        for (let i = 0; i < candles.length; i++) {
            const candle = candles[i];
            // Swings confirmed at or before candle i
            const visibleSwings = swings.filter((s) => s.confirmedAtIndex <= i);
            if (visibleSwings.length < 2)
                continue;
            // Update structural trend dynamically from chronological swings if currently neutral
            if (currentTrend === shared_1.Direction.NEUTRAL) {
                const lastSwing = visibleSwings[visibleSwings.length - 1];
                if (lastSwing.type === shared_1.StructureType.HIGHER_HIGH ||
                    lastSwing.type === shared_1.StructureType.HIGHER_LOW) {
                    currentTrend = shared_1.Direction.BULLISH;
                }
                else if (lastSwing.type === shared_1.StructureType.LOWER_LOW ||
                    lastSwing.type === shared_1.StructureType.LOWER_HIGH) {
                    currentTrend = shared_1.Direction.BEARISH;
                }
            }
            const recentHighs = visibleSwings.filter((s) => (s.type === shared_1.StructureType.LOWER_HIGH || s.type === shared_1.StructureType.SWING_HIGH) &&
                !brokenSwingIndices.has(s.index));
            const recentLows = visibleSwings.filter((s) => (s.type === shared_1.StructureType.HIGHER_LOW || s.type === shared_1.StructureType.SWING_LOW) &&
                !brokenSwingIndices.has(s.index));
            const recentLH = recentHighs[recentHighs.length - 1];
            const recentHL = recentLows[recentLows.length - 1];
            // 1. Bullish CHOCH: In a Bearish trend, price closes above recent Lower High
            if (currentTrend === shared_1.Direction.BEARISH && recentLH && i > recentLH.confirmedAtIndex) {
                if (candle.close > recentLH.price) {
                    chochEvents.push({
                        direction: shared_1.Direction.BULLISH,
                        previousTrend: shared_1.Direction.BEARISH,
                        brokenLevel: recentLH.price,
                        candleIndex: i,
                        timestamp: candle.timestamp,
                        strength: 1.5,
                    });
                    brokenSwingIndices.add(recentLH.index);
                    currentTrend = shared_1.Direction.BULLISH; // Trend flips to Bullish
                }
            }
            // 2. Bearish CHOCH: In a Bullish trend, price closes below recent Higher Low
            if (currentTrend === shared_1.Direction.BULLISH && recentHL && i > recentHL.confirmedAtIndex) {
                if (candle.close < recentHL.price) {
                    chochEvents.push({
                        direction: shared_1.Direction.BEARISH,
                        previousTrend: shared_1.Direction.BULLISH,
                        brokenLevel: recentHL.price,
                        candleIndex: i,
                        timestamp: candle.timestamp,
                        strength: 1.5,
                    });
                    brokenSwingIndices.add(recentHL.index);
                    currentTrend = shared_1.Direction.BEARISH; // Trend flips to Bearish
                }
            }
        }
        return chochEvents;
    }
}
exports.CHOCHEngine = CHOCHEngine;
//# sourceMappingURL=choch-engine.js.map