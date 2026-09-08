"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SwingDetector = void 0;
const shared_1 = require("@quant/shared");
const indicators_1 = require("@quant/indicators");
class SwingDetector {
    /**
     * Detects and classifies structural swings with strictly zero look-ahead bias.
     * A swing at index i is ONLY confirmed at index i + rightBars.
     */
    static detectSwings(candles, options = {}) {
        const leftBars = options.leftBars ?? 3;
        const rightBars = options.rightBars ?? 3;
        const minDistanceMult = options.minDistanceAtrMultiplier ?? 0.5;
        if (!candles || candles.length < leftBars + rightBars + 1) {
            return [];
        }
        const atr = (0, indicators_1.calculateATR)(candles, 14);
        const swings = [];
        let lastConfirmedHigh = null;
        let lastConfirmedLow = null;
        // Up to candle length - rightBars can be confirmed
        const maxEvalIndex = candles.length - rightBars;
        for (let i = leftBars; i < maxEvalIndex; i++) {
            const currentHigh = candles[i].high;
            const currentLow = candles[i].low;
            const currentAtr = atr[i] || currentHigh - currentLow;
            const minDistance = currentAtr * minDistanceMult;
            // 1. Swing High evaluation
            let isSwingHigh = true;
            for (let l = 1; l <= leftBars; l++) {
                if (candles[i - l].high > currentHigh) {
                    isSwingHigh = false;
                    break;
                }
            }
            if (isSwingHigh) {
                for (let r = 1; r <= rightBars; r++) {
                    if (candles[i + r].high >= currentHigh) {
                        isSwingHigh = false;
                        break;
                    }
                }
            }
            if (isSwingHigh) {
                // Enforce minimum distance filter from previous low if available
                if (!lastConfirmedLow || Math.abs(currentHigh - lastConfirmedLow.price) >= minDistance) {
                    let type = shared_1.StructureType.SWING_HIGH;
                    if (lastConfirmedHigh) {
                        type =
                            currentHigh > lastConfirmedHigh.price
                                ? shared_1.StructureType.HIGHER_HIGH
                                : shared_1.StructureType.LOWER_HIGH;
                    }
                    const confirmedAtIndex = i + rightBars;
                    const swingPoint = {
                        index: i,
                        type,
                        price: currentHigh,
                        timestamp: candles[i].timestamp,
                        confirmedAtIndex,
                        confirmedAtTimestamp: candles[confirmedAtIndex].timestamp,
                    };
                    swings.push(swingPoint);
                    lastConfirmedHigh = swingPoint;
                }
            }
            // 2. Swing Low evaluation
            let isSwingLow = true;
            for (let l = 1; l <= leftBars; l++) {
                if (candles[i - l].low < currentLow) {
                    isSwingLow = false;
                    break;
                }
            }
            if (isSwingLow) {
                for (let r = 1; r <= rightBars; r++) {
                    if (candles[i + r].low <= currentLow) {
                        isSwingLow = false;
                        break;
                    }
                }
            }
            if (isSwingLow) {
                if (!lastConfirmedHigh || Math.abs(currentLow - lastConfirmedHigh.price) >= minDistance) {
                    let type = shared_1.StructureType.SWING_LOW;
                    if (lastConfirmedLow) {
                        type =
                            currentLow < lastConfirmedLow.price
                                ? shared_1.StructureType.LOWER_LOW
                                : shared_1.StructureType.HIGHER_LOW;
                    }
                    const confirmedAtIndex = i + rightBars;
                    const swingPoint = {
                        index: i,
                        type,
                        price: currentLow,
                        timestamp: candles[i].timestamp,
                        confirmedAtIndex,
                        confirmedAtTimestamp: candles[confirmedAtIndex].timestamp,
                    };
                    swings.push(swingPoint);
                    lastConfirmedLow = swingPoint;
                }
            }
        }
        // Sort by confirmed index ascending
        return swings.sort((a, b) => a.confirmedAtIndex - b.confirmedAtIndex);
    }
}
exports.SwingDetector = SwingDetector;
//# sourceMappingURL=swing-detector.js.map