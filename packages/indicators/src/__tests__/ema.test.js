"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const ema_1 = require("../ema");
describe('calculateEMA', () => {
    it('should calculate exponential moving average with standard smoothing', () => {
        // 5-period EMA with multiplier = 2 / (5 + 1) = 2/6 = 1/3
        const prices = [10, 11, 12, 13, 14, 15];
        const ema5 = (0, ema_1.calculateEMA)(prices, 5);
        expect(ema5[0]).toBeNull();
        expect(ema5[1]).toBeNull();
        expect(ema5[2]).toBeNull();
        expect(ema5[3]).toBeNull();
        // Seed at index 4 = SMA(10,11,12,13,14) = 12
        expect(ema5[4]).toBeCloseTo(12);
        // At index 5: 15 * (1/3) + 12 * (2/3) = 5 + 8 = 13
        expect(ema5[5]).toBeCloseTo(13);
    });
    it('should return nulls for array smaller than period', () => {
        expect((0, ema_1.calculateEMA)([10, 20], 5)).toEqual([null, null]);
    });
});
//# sourceMappingURL=ema.test.js.map