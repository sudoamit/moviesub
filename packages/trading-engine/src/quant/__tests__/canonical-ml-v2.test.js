"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const quant_types_1 = require("../quant-types");
const canonical_ml_v2_1 = require("../canonical-ml-v2");
const snapshot_builder_1 = require("../snapshot-builder");
describe('CanonicalMLEngineV2', () => {
    const createMockCandles = (count = 50, base = 80000) => {
        return Array.from({ length: count }, (_, i) => {
            const open = base + i * 20;
            const close = open + (i % 2 === 0 ? 30 : -10);
            const high = Math.max(open, close) + 15;
            const low = Math.min(open, close) - 15;
            return {
                timestamp: new Date(1700000000000 + i * 900000),
                open,
                high,
                low,
                close,
                volume: 25000 + i * 50,
            };
        });
    };
    it('should maintain strict 28-dimensional canonical ordering', () => {
        expect(quant_types_1.CANONICAL_FEATURE_SCHEMA_VERSION).toBe('2.0');
        expect(quant_types_1.CANONICAL_V2_DIMENSION).toBe(28);
        expect(quant_types_1.CANONICAL_FEATURE_NAMES_V2.length).toBe(28);
        expect(quant_types_1.CANONICAL_FEATURE_NAMES_V2[0]).toBe('smcScore');
        expect(quant_types_1.CANONICAL_FEATURE_NAMES_V2[27]).toBe('multiHorizonConfluence');
    });
    it('should extract canonical 28-dimensional features and compute Expected Value (EV)', () => {
        const candles = createMockCandles(50, 80000);
        const snapshot = snapshot_builder_1.SnapshotBuilder.buildSnapshot({
            symbol: 'BTCUSDT',
            executionCandles: candles,
        });
        const features = canonical_ml_v2_1.CanonicalMLEngineV2.extractFeatures(snapshot);
        const featureArray = canonical_ml_v2_1.CanonicalMLEngineV2.toArray(features);
        expect(featureArray.length).toBe(28);
        featureArray.forEach((val) => {
            expect(val).toBeGreaterThanOrEqual(0.0);
            expect(val).toBeLessThanOrEqual(1.0);
        });
        const prediction = canonical_ml_v2_1.CanonicalMLEngineV2.predict(features, 2.5);
        expect(prediction.probabilityWin).toBeGreaterThan(0);
        expect(prediction.probabilityWin).toBeLessThanOrEqual(1.0);
        expect(prediction.featureSchemaVersion).toBe('2.0');
        expect(typeof prediction.expectedR).toBe('number');
    });
    it('marks model output as unavailable when no calibrated expected win is provided', () => {
        const candles = createMockCandles(50, 80000);
        const snapshot = snapshot_builder_1.SnapshotBuilder.buildSnapshot({
            symbol: 'BTCUSDT',
            executionCandles: candles,
        });
        const features = canonical_ml_v2_1.CanonicalMLEngineV2.extractFeatures(snapshot);
        const prediction = canonical_ml_v2_1.CanonicalMLEngineV2.predict(features, null);
        expect(prediction.probabilityWin).toBeNull();
        expect(prediction.expectedR).toBeNull();
        expect(prediction.calibrated).toBe(false);
    });
});
//# sourceMappingURL=canonical-ml-v2.test.js.map