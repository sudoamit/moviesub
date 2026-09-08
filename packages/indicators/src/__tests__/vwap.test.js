"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vwap_1 = require("../vwap");
describe('calculateVWAP', () => {
    it('should calculate Volume Weighted Average Price accurately', () => {
        const candles = [
            { timestamp: new Date(), open: 100, high: 105, low: 95, close: 100, volume: 100 }, // TP = 100, cum = 10000 / 100 = 100
            { timestamp: new Date(), open: 100, high: 115, low: 105, close: 110, volume: 200 }, // TP = 110, cum = (10000 + 22000) / 300 = 32000 / 300 = 106.666
        ];
        const vwap = (0, vwap_1.calculateVWAP)(candles);
        expect(vwap[0]).toBeCloseTo(100);
        expect(vwap[1]).toBeCloseTo(106.6666, 3);
    });
});
//# sourceMappingURL=vwap.test.js.map