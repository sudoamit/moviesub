"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.extractPrices = extractPrices;
function extractPrices(candles, source = 'close') {
    return candles.map((c) => {
        switch (source) {
            case 'open':
                return c.open;
            case 'high':
                return c.high;
            case 'low':
                return c.low;
            case 'hl2':
                return (c.high + c.low) / 2;
            case 'hlc3':
                return (c.high + c.low + c.close) / 3;
            case 'ohlc4':
                return (c.open + c.high + c.low + c.close) / 4;
            case 'close':
            default:
                return c.close;
        }
    });
}
//# sourceMappingURL=types.js.map