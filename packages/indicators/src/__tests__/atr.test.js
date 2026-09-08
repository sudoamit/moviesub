"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const atr_1 = require("../atr");
describe('calculateATR and calculateTrueRange', () => {
    const candles = [
        { timestamp: new Date(), open: 100, high: 110, low: 90, close: 105, volume: 1000 }, // TR = 110-90 = 20
        { timestamp: new Date(), open: 105, high: 115, low: 100, close: 110, volume: 1000 }, // TR = max(15, |115-105|=10, |100-105|=5) = 15
        { timestamp: new Date(), open: 110, high: 125, low: 108, close: 120, volume: 1000 }, // TR = max(17, |125-110|=15, |108-110|=2) = 17
        { timestamp: new Date(), open: 120, high: 130, low: 115, close: 125, volume: 1000 }, // TR = max(15, |130-120|=10, |115-120|=5) = 15
    ];
    it('should calculate True Range correctly', () => {
        const tr = (0, atr_1.calculateTrueRange)(candles);
        expect(tr[0]).toBe(20);
        expect(tr[1]).toBe(15);
        expect(tr[2]).toBe(17);
        expect(tr[3]).toBe(15);
    });
    it('should calculate ATR using Wilder smoothing', () => {
        const atr3 = (0, atr_1.calculateATR)(candles, 3);
        expect(atr3[0]).toBeNull();
        expect(atr3[1]).toBeNull();
        // Seed at index 2: SMA(20, 15, 17) = 52 / 3 = 17.333
        expect(atr3[2]).toBeCloseTo(17.3333, 3);
        // At index 3: (17.3333 * 2 + 15) / 3 = (34.6666 + 15) / 3 = 49.6666 / 3 = 16.555
        expect(atr3[3]).toBeCloseTo(16.5555, 3);
    });
});
//# sourceMappingURL=atr.test.js.map