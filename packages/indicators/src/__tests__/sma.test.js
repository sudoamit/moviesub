"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const sma_1 = require("../sma");
describe('calculateSMA', () => {
    it('should calculate accurate simple moving average', () => {
        const prices = [10, 20, 30, 40, 50, 60];
        const sma3 = (0, sma_1.calculateSMA)(prices, 3);
        expect(sma3[0]).toBeNull();
        expect(sma3[1]).toBeNull();
        expect(sma3[2]).toBeCloseTo(20); // (10+20+30)/3
        expect(sma3[3]).toBeCloseTo(30); // (20+30+40)/3
        expect(sma3[4]).toBeCloseTo(40); // (30+40+50)/3
        expect(sma3[5]).toBeCloseTo(50); // (40+50+60)/3
    });
    it('should handle edge cases with empty or short input', () => {
        expect((0, sma_1.calculateSMA)([], 5)).toEqual([]);
        expect((0, sma_1.calculateSMA)([10, 20], 5)).toEqual([null, null]);
        expect((0, sma_1.calculateSMA)([10, 20], 0)).toEqual([]);
    });
});
//# sourceMappingURL=sma.test.js.map