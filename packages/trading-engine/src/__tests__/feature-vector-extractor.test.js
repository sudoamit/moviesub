"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const ai_trade_learning_engine_1 = require("../ai-trade-learning-engine");
const shared_1 = require("@quant/shared");
function createDeterministicCandles(count, startPrice = 24000, intervalSec = 900) {
    const candles = [];
    const baseTime = new Date('2026-08-20T04:00:00.000Z').getTime();
    let price = startPrice;
    for (let i = 0; i < count; i++) {
        const isBull = i % 2 === 0;
        const delta = (i % 5) * 5 + 10;
        const open = price;
        const close = isBull ? open + delta : open - delta;
        const high = Math.max(open, close) + 8;
        const low = Math.min(open, close) - 8;
        const volume = 1000 + (i % 7) * 200;
        candles.push({
            timestamp: new Date(baseTime + i * intervalSec * 1000),
            open,
            high,
            low,
            close,
            volume,
            isClosed: true,
        });
        price = close;
    }
    return candles;
}
function createMockSignal() {
    return {
        symbol: 'NIFTY',
        direction: shared_1.Direction.BULLISH,
        state: shared_1.SignalState.ACTIVE,
        grade: shared_1.SignalGrade.A_PLUS,
        score: 88,
        timeframe: '15m',
        entryZone: {
            min: 24100,
            max: 24130,
            optimal: 24115,
        },
        stopLoss: 24075,
        takeProfits: {
            tp1: 24175,
            tp2: 24215,
            tp3: 24275,
        },
        riskRewardRatios: {
            rr1: 1.5,
            rr2: 2.5,
            rr3: 4.0,
        },
        scoreBreakdown: {
            htfBias: 15,
            liquiditySweep: 16,
            bos: 15,
            fvg: 18,
            orderBlock: 24,
            displacement: 15,
            volumeConfirmation: 15,
            premiumDiscount: 15,
            riskReward: 15,
            indicatorAlignment: 15,
            totalScore: 88,
            grade: shared_1.SignalGrade.A_PLUS,
        },
        reasoning: {
            htfStructure: 'Bullish HTF Trend',
            liquidityReason: 'Buy-side liquidity sweep confirmed.',
            triggerReason: 'Mitigation of 15m bullish order block.',
            invalidationReason: 'Close below 24075.',
            confirmedChecklist: ['Order Block Confirmed', 'Liquidity Swept'],
            summary: 'Bullish order block mitigation with liquidity sweep.',
        },
        timestamp: new Date('2026-08-20T06:00:00.000Z'),
    };
}
describe('PHASE 1: FeatureVectorExtractor & Schema Specification', () => {
    it('strictly adheres to Schema Version 1.0 with 17 deterministic dimensions', () => {
        expect(ai_trade_learning_engine_1.FEATURE_SCHEMA_VERSION).toBe('1.0');
        expect(ai_trade_learning_engine_1.FeatureVectorExtractor.SCHEMA_VERSION).toBe('1.0');
        expect(ai_trade_learning_engine_1.FEATURE_NAMES.length).toBe(17);
        expect(ai_trade_learning_engine_1.FEATURE_VECTOR_DIMENSION).toBe(17);
        expect(ai_trade_learning_engine_1.FeatureVectorExtractor.DIMENSION).toBe(17);
        // Verify exact ordering
        expect(ai_trade_learning_engine_1.FEATURE_NAMES[0]).toBe('smcScore');
        expect(ai_trade_learning_engine_1.FEATURE_NAMES[1]).toBe('obStrength');
        expect(ai_trade_learning_engine_1.FEATURE_NAMES[2]).toBe('fvgSize');
        expect(ai_trade_learning_engine_1.FEATURE_NAMES[3]).toBe('mtfAlignment');
        expect(ai_trade_learning_engine_1.FEATURE_NAMES[4]).toBe('killZoneSession');
        expect(ai_trade_learning_engine_1.FEATURE_NAMES[5]).toBe('smtDivergence');
        expect(ai_trade_learning_engine_1.FEATURE_NAMES[6]).toBe('volatilityAtr');
        expect(ai_trade_learning_engine_1.FEATURE_NAMES[7]).toBe('riskRewardRatio');
        expect(ai_trade_learning_engine_1.FEATURE_NAMES[8]).toBe('trendRegime');
        expect(ai_trade_learning_engine_1.FEATURE_NAMES[9]).toBe('liquiditySweep');
        expect(ai_trade_learning_engine_1.FEATURE_NAMES[10]).toBe('bosStrength');
        expect(ai_trade_learning_engine_1.FEATURE_NAMES[11]).toBe('chochStrength');
        expect(ai_trade_learning_engine_1.FEATURE_NAMES[12]).toBe('relativeVolume');
        expect(ai_trade_learning_engine_1.FEATURE_NAMES[13]).toBe('distanceToHTFLevel');
        expect(ai_trade_learning_engine_1.FEATURE_NAMES[14]).toBe('distanceToLiquidity');
        expect(ai_trade_learning_engine_1.FEATURE_NAMES[15]).toBe('marketSession');
        expect(ai_trade_learning_engine_1.FEATURE_NAMES[16]).toBe('dayOfWeek');
    });
    it('extracts a normalized feature vector where all dimensions are in [0.0, 1.0]', () => {
        const candles = createDeterministicCandles(40);
        const signal = createMockSignal();
        const vector = ai_trade_learning_engine_1.FeatureVectorExtractor.extract({
            signal,
            candles,
            smtDivergenceScore: 0.85,
        });
        const validation = ai_trade_learning_engine_1.FeatureVectorExtractor.validateVector(vector);
        expect(validation.isValid).toBe(true);
        expect(validation.errors).toEqual([]);
        // Check individual normalized properties
        expect(vector.smcScore).toBeCloseTo(0.88, 2);
        expect(vector.obStrength).toBeGreaterThanOrEqual(0.0);
        expect(vector.obStrength).toBeLessThanOrEqual(1.0);
        expect(vector.fvgSize).toBeGreaterThanOrEqual(0.0);
        expect(vector.fvgSize).toBeLessThanOrEqual(1.0);
        expect(vector.smtDivergence).toBeCloseTo(0.85, 2);
        expect(vector.riskRewardRatio).toBeGreaterThanOrEqual(0.0);
        expect(vector.riskRewardRatio).toBeLessThanOrEqual(1.0);
    });
    it('maintains perfect array serialization and deserialization isomorphism', () => {
        const candles = createDeterministicCandles(30);
        const signal = createMockSignal();
        const vector = ai_trade_learning_engine_1.FeatureVectorExtractor.extract({ signal, candles });
        const array = ai_trade_learning_engine_1.FeatureVectorExtractor.toArray(vector);
        expect(array.length).toBe(17);
        expect(Array.isArray(array)).toBe(true);
        const reconstructed = ai_trade_learning_engine_1.FeatureVectorExtractor.fromArray(array);
        expect(reconstructed).toEqual(vector);
        // Verify ordering matches FEATURE_NAMES
        ai_trade_learning_engine_1.FEATURE_NAMES.forEach((name, idx) => {
            expect(array[idx]).toBe(vector[name]);
        });
    });
    it('strictly prevents look-ahead bias when asOfTimestamp is provided', () => {
        const fullCandles = createDeterministicCandles(60);
        const signal = createMockSignal();
        // Set point-in-time timestamp at candle index 25
        const asOfTimestamp = fullCandles[25].timestamp;
        const pointInTimeCandles = fullCandles.slice(0, 26);
        // 1. Extract from the full dataset (with future candles) constrained by asOfTimestamp
        const vectorConstrained = ai_trade_learning_engine_1.FeatureVectorExtractor.extract({
            signal,
            candles: fullCandles,
            asOfTimestamp,
        });
        // 2. Extract from point-in-time candles directly
        const vectorHistorical = ai_trade_learning_engine_1.FeatureVectorExtractor.extract({
            signal,
            candles: pointInTimeCandles,
            asOfTimestamp,
        });
        // Both feature vectors must be 100% identical with zero leakage from future candles 26..59
        expect(vectorConstrained).toEqual(vectorHistorical);
    });
    it('gracefully handles empty / minimal candle sequences with safe normalized defaults', () => {
        const signal = createMockSignal();
        const vector = ai_trade_learning_engine_1.FeatureVectorExtractor.extract({
            signal,
            candles: [],
        });
        const validation = ai_trade_learning_engine_1.FeatureVectorExtractor.validateVector(vector);
        expect(validation.isValid).toBe(true);
        expect(validation.errors).toEqual([]);
        expect(vector.smcScore).toBe(0.88);
        expect(vector.relativeVolume).toBe(0.5);
        expect(vector.volatilityAtr).toBe(0.5);
    });
});
//# sourceMappingURL=feature-vector-extractor.test.js.map