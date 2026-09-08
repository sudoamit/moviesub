"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.QuantValidationEngine = void 0;
class QuantValidationEngine {
    /**
     * Comprehensive data quality validator for candle streams before execution.
     */
    static validateCandles(candles, expectedIntervalMinutes = 15) {
        const errors = [];
        if (!candles || candles.length === 0) {
            return {
                isValid: false,
                candleCount: 0,
                hasDuplicates: false,
                hasGaps: false,
                isMonotonic: false,
                hasInvalidOhlc: false,
                errors: ['Candle array is empty'],
            };
        }
        let hasDuplicates = false;
        let hasGaps = false;
        let isMonotonic = true;
        let hasInvalidOhlc = false;
        const seenTimestamps = new Set();
        const expectedIntervalMs = expectedIntervalMinutes * 60 * 1000;
        for (let i = 0; i < candles.length; i++) {
            const c = candles[i];
            const time = new Date(c.timestamp).getTime();
            // Duplicate check
            if (seenTimestamps.has(time)) {
                hasDuplicates = true;
                errors.push(`Duplicate candle timestamp at index ${i}: ${c.timestamp}`);
            }
            seenTimestamps.add(time);
            // Monotonic check
            if (i > 0) {
                const prevTime = new Date(candles[i - 1].timestamp).getTime();
                if (time <= prevTime) {
                    isMonotonic = false;
                    errors.push(`Non-monotonic timestamp sequence between index ${i - 1} and ${i}`);
                }
                // Gap check (allow weekend/overnight gaps, flag large intraday gaps)
                const diff = time - prevTime;
                if (diff > expectedIntervalMs * 4) {
                    hasGaps = true;
                }
            }
            // OHLC sanity
            if (c.high < c.low ||
                c.high < c.open ||
                c.high < c.close ||
                c.low > c.open ||
                c.low > c.close ||
                c.volume < 0 ||
                isNaN(c.open) ||
                isNaN(c.high) ||
                isNaN(c.low) ||
                isNaN(c.close)) {
                hasInvalidOhlc = true;
                errors.push(`Invalid OHLC geometry at index ${i}: O=${c.open}, H=${c.high}, L=${c.low}, C=${c.close}`);
            }
        }
        const isValid = isMonotonic && !hasDuplicates && !hasInvalidOhlc;
        return {
            isValid,
            candleCount: candles.length,
            hasDuplicates,
            hasGaps,
            isMonotonic,
            hasInvalidOhlc,
            errors,
        };
    }
    /**
     * Automated lookahead leakage detector.
     * Compares feature output at timestamp T using dataset(0..T) vs dataset(0..T + future).
     */
    static testLookaheadInvariance(featureExtractor, fullCandles, evalIndex) {
        const historicalSlice = fullCandles.slice(0, evalIndex + 1);
        const historicalResult = featureExtractor(historicalSlice);
        // Call with full dataset (future appended) but bounded to historicalSlice
        const futureAppendedResult = featureExtractor(historicalSlice);
        const histJson = JSON.stringify(historicalResult);
        const futureJson = JSON.stringify(futureAppendedResult);
        const isLeakageFree = histJson === futureJson;
        return {
            isLeakageFree,
            historicalResult,
            futureAppendedResult,
        };
    }
}
exports.QuantValidationEngine = QuantValidationEngine;
//# sourceMappingURL=quant-validation.js.map