"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const normalization_1 = require("../normalization");
const quant_feature_engine_1 = require("../quant-feature-engine");
const quant_validation_1 = require("../quant-validation");
describe('Normalization & Anti-Lookahead Regression Tests', () => {
    const createDeterministicCandles = (count = 100, base = 1000) => {
        return Array.from({ length: count }, (_, i) => {
            const open = base + i * 2 + Math.sin(i * 0.2) * 5;
            const close = open + (i % 2 === 0 ? 3 : -2);
            const high = Math.max(open, close) + 2;
            const low = Math.min(open, close) - 2;
            return {
                timestamp: new Date(1700000000000 + i * 900000), // 15m intervals
                open,
                high,
                low,
                close,
                volume: 10000 + i * 100,
            };
        });
    };
    it('should calculate rolling Z-score strictly within historical window', () => {
        const values = [10, 12, 14, 16, 18, 20];
        const z = normalization_1.NormalizationEngine.rollingZScore(values, 5);
        expect(z).toBeGreaterThan(0);
        expect(z).toBeLessThanOrEqual(3.0);
    });
    it('should guarantee point-in-time invariance (Zero Lookahead Leakage)', () => {
        const fullCandles = createDeterministicCandles(80, 24000);
        const evalIndex = 40;
        const historicalSlice = fullCandles.slice(0, evalIndex + 1);
        // 1. Extract feature state with only historical data up to T
        const featuresAtT_HistoricalOnly = quant_feature_engine_1.QuantFeatureEngine.extractQuantState('NIFTY', historicalSlice);
        // 2. Extract feature state using lookahead invariance tester
        const invarianceResult = quant_validation_1.QuantValidationEngine.testLookaheadInvariance((c) => quant_feature_engine_1.QuantFeatureEngine.extractQuantState('NIFTY', c), fullCandles, evalIndex);
        expect(invarianceResult.isLeakageFree).toBe(true);
        expect(featuresAtT_HistoricalOnly.returns.return1Bar).toBe(invarianceResult.historicalResult.returns.return1Bar);
        expect(featuresAtT_HistoricalOnly.volatility.forecastVolatility).toBe(invarianceResult.historicalResult.volatility.forecastVolatility);
        expect(featuresAtT_HistoricalOnly.momentum.rsi14).toBe(invarianceResult.historicalResult.momentum.rsi14);
    });
});
//# sourceMappingURL=normalization-lookahead.test.js.map