"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const bollinger_1 = require("../bollinger");
describe('calculateBollingerBands', () => {
    it('should calculate upper, middle, and lower bands correctly', () => {
        const prices = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29];
        const bb = (0, bollinger_1.calculateBollingerBands)(prices, 20, 2);
        expect(bb.middle[19]).toBeCloseTo(19.5); // Average of 10..29
        expect(bb.upper[19]).toBeGreaterThan(bb.middle[19]);
        expect(bb.lower[19]).toBeLessThan(bb.middle[19]);
        expect(bb.bandwidth[19]).toBeGreaterThan(0);
        expect(bb.percentB[19]).toBeGreaterThan(0);
    });
});
//# sourceMappingURL=bollinger.test.js.map