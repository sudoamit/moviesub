"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const adx_1 = require("../adx");
describe('calculateADX', () => {
    it('should calculate ADX, +DI, and -DI for a directional trend', () => {
        const candles = [];
        let price = 100;
        for (let i = 0; i < 40; i++) {
            price += 2; // Strong uptrend
            candles.push({
                timestamp: new Date(Date.now() + i * 60000),
                open: price - 1,
                high: price + 2,
                low: price - 2,
                close: price + 1,
                volume: 1000,
            });
        }
        const { adx, plusDI, minusDI } = (0, adx_1.calculateADX)(candles, 14);
        // In a strong uptrend, +DI must be significantly higher than -DI
        const lastIdx = candles.length - 1;
        expect(plusDI[lastIdx]).toBeGreaterThan(minusDI[lastIdx]);
        expect(adx[lastIdx]).toBeGreaterThan(20);
    });
});
//# sourceMappingURL=adx.test.js.map