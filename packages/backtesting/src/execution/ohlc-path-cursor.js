"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.OHLCPathCursor = void 0;
class OHLCPathCursor {
    segmentIndex = 0;
    segments;
    constructor(candle) {
        const isBullish = candle.close >= candle.open;
        if (isBullish) {
            // Bullish candle path: Open -> Low -> High -> Close
            this.segments = [
                { start: candle.open, end: candle.low, type: 'OPEN_LOW' },
                { start: candle.low, end: candle.high, type: 'LOW_HIGH' },
                { start: candle.high, end: candle.close, type: 'HIGH_CLOSE' },
            ];
        }
        else {
            // Bearish candle path: Open -> High -> Low -> Close
            this.segments = [
                { start: candle.open, end: candle.high, type: 'OPEN_HIGH' },
                { start: candle.high, end: candle.low, type: 'HIGH_LOW' },
                { start: candle.low, end: candle.close, type: 'LOW_CLOSE' },
            ];
        }
    }
    get currentSegment() {
        return this.segments[this.segmentIndex];
    }
    get isFinished() {
        return this.segmentIndex >= this.segments.length;
    }
    advance() {
        if (this.segmentIndex < this.segments.length) {
            this.segmentIndex++;
        }
        return !this.isFinished;
    }
    remainingSegments() {
        return this.segments.slice(this.segmentIndex);
    }
}
exports.OHLCPathCursor = OHLCPathCursor;
//# sourceMappingURL=ohlc-path-cursor.js.map