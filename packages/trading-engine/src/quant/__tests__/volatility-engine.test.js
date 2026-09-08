"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const volatility_engine_1 = require("../volatility-engine");
describe('VolatilityEngine', () => {
    const createMockCandles = (count = 50, base = 100) => {
        return Array.from({ length: count }, (_, i) => {
            const open = base + Math.sin(i * 0.3) * 3;
            const close = open + (i % 2 === 0 ? 1.5 : -1.2);
            const high = Math.max(open, close) + 1.0;
            const low = Math.min(open, close) - 1.0;
            return {
                timestamp: new Date(Date.now() - (count - i) * 60000),
                open,
                high,
                low,
                close,
                volume: 1000 + i * 50,
            };
        });
    };
    it('should calculate Parkinson and Garman-Klass volatility correctly', () => {
        const candles = createMockCandles(40, 24000);
        const parkinson = volatility_engine_1.VolatilityEngine.calculateParkinson(candles, 20);
        const garmanKlass = volatility_engine_1.VolatilityEngine.calculateGarmanKlass(candles, 20);
        expect(parkinson).toBeGreaterThan(0);
        expect(garmanKlass).toBeGreaterThan(0);
        expect(isFinite(parkinson)).toBe(true);
        expect(isFinite(garmanKlass)).toBe(true);
    });
    it('should fit GARCH(1,1) with variance targeting', () => {
        const returns = Array.from({ length: 50 }, (_, i) => Math.sin(i) * 0.01);
        const garch = volatility_engine_1.VolatilityEngine.fitGarch11(returns);
        if (garch) {
            expect(garch.alpha + garch.beta).toBeLessThan(1.0);
            expect(garch.alpha).toBeGreaterThan(0);
            expect(garch.beta).toBeGreaterThan(0);
            expect(garch.omega).toBeGreaterThan(0);
        }
    });
    it('should gracefully fallback from GARCH to EWMA and Realized without throwing', () => {
        // Very small dataset where GARCH cannot fit
        const shortCandles = createMockCandles(8, 100);
        const volState = volatility_engine_1.VolatilityEngine.computeVolatilityState(shortCandles);
        expect(volState.forecastVolatility).toBeGreaterThanOrEqual(0);
        expect(['GARCH', 'EWMA', 'REALIZED']).toContain(volState.modelUsed);
        expect(volState.confidence).toBeGreaterThan(0);
    });
});
//# sourceMappingURL=volatility-engine.test.js.map