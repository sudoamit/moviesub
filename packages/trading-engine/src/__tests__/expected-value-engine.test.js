"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const ai_trade_learning_engine_1 = require("../ai-trade-learning-engine");
describe('PHASE 6: Expected Value & AI Recommendation Decision Tree', () => {
    describe('1. ExpectedValueEngine — Mathematical Calculations', () => {
        it('calculates expected value accurately for fixed R setups', () => {
            // 80% Win Rate with 2.5R target and 1.0R risk
            const payoff = {
                targetR: 2.5,
                lossR: 1.0,
            };
            const evResult = ai_trade_learning_engine_1.ExpectedValueEngine.calculateExpectedValue(0.8, payoff);
            expect(evResult.winProbability).toBe(0.8);
            expect(evResult.lossProbability).toBe(0.2);
            expect(evResult.averageWinR).toBe(2.5);
            expect(evResult.averageLossR).toBe(1.0);
            // EV = 0.8 * 2.5 - 0.2 * 1.0 = 2.0 - 0.2 = +1.80R
            expect(evResult.expectedValueR).toBe(1.8);
            expect(evResult.isPositiveExpectancy).toBe(true);
            expect(evResult.kellyCriterionFraction).toBeGreaterThan(0.5);
        });
        it('calculates expected value for multi-target scale-out structures', () => {
            // 50% scale-out at 1.5R (TP1) and 50% runner at 2.5R (TP2)
            const payoff = {
                targetR: 2.5,
                partialScaleOut: {
                    tp1R: 1.5,
                    tp1Ratio: 0.5,
                    tp2R: 2.5,
                    tp2Ratio: 0.5,
                },
            };
            // Average Win R = 0.5*1.5 + 0.5*2.5 = 2.0R
            const evResult = ai_trade_learning_engine_1.ExpectedValueEngine.calculateExpectedValue(0.6, payoff);
            expect(evResult.averageWinR).toBe(2.0);
            // EV = 0.6 * 2.0 - 0.4 * 1.0 = 1.2 - 0.4 = +0.80R
            expect(evResult.expectedValueR).toBe(0.8);
            expect(evResult.isPositiveExpectancy).toBe(true);
        });
        it('identifies negative expectancy trade setups', () => {
            const payoff = { targetR: 1.5, lossR: 1.0 };
            const evResult = ai_trade_learning_engine_1.ExpectedValueEngine.calculateExpectedValue(0.3, payoff);
            // EV = 0.3 * 1.5 - 0.7 * 1.0 = 0.45 - 0.70 = -0.25R
            expect(evResult.expectedValueR).toBe(-0.25);
            expect(evResult.isPositiveExpectancy).toBe(false);
            expect(evResult.kellyCriterionFraction).toBe(0.0);
        });
    });
    describe('2. Sample-Size Gated AI Recommendation Decision Tree', () => {
        it('downgrades high probability to WAIT when sample size is insufficient (Specification Example)', () => {
            // High probability (0.82) but only 17 observations -> MUST BE WAIT with INSUFFICIENT_DATA
            const payoff = { targetR: 2.0, lossR: 1.0 };
            const rec = ai_trade_learning_engine_1.ExpectedValueEngine.evaluateRecommendation({
                probability: 0.82,
                payoff,
                supportingSampleSize: 17,
                calibrationStatus: 'GOOD',
                minSampleSize: 25,
            });
            expect(rec.recommendation).toBe('WAIT');
            expect(rec.confidenceStatus).toBe('INSUFFICIENT_DATA');
            expect(rec.confidenceInterval).toBeNull();
            expect(rec.reasons.some((r) => r.includes('INSUFFICIENT_DATA'))).toBe(true);
        });
        it('produces HIGH_CONFIDENCE recommendation when backed by large sample size and strong EV', () => {
            // 82% win rate, +0.91R EV, large sample (4,821) -> HIGH_CONFIDENCE
            const payoff = { targetR: 2.0, lossR: 1.0 };
            const rec = ai_trade_learning_engine_1.ExpectedValueEngine.evaluateRecommendation({
                probability: 0.82,
                payoff,
                supportingSampleSize: 4821,
                calibrationStatus: 'GOOD',
                minSampleSize: 25,
                modelVersion: 'v1.0.0',
            });
            expect(rec.recommendation).toBe('HIGH_CONFIDENCE');
            expect(rec.confidenceStatus).toBe('CALIBRATED');
            expect(rec.confidenceInterval).not.toBeNull();
            expect(rec.expectedValueR).toBeGreaterThan(0.5);
            expect(rec.modelVersion).toBe('v1.0.0');
        });
        it('produces MODERATE_CONFIDENCE for setups with solid win rate (60%) and positive EV', () => {
            const payoff = { targetR: 2.0, lossR: 1.0 };
            const rec = ai_trade_learning_engine_1.ExpectedValueEngine.evaluateRecommendation({
                probability: 0.6,
                payoff,
                supportingSampleSize: 80,
                calibrationStatus: 'GOOD',
            });
            expect(rec.recommendation).toBe('MODERATE_CONFIDENCE');
        });
        it('produces LOW_CONFIDENCE for marginal positive expectancy setups', () => {
            const payoff = { targetR: 1.5, lossR: 1.0 };
            const rec = ai_trade_learning_engine_1.ExpectedValueEngine.evaluateRecommendation({
                probability: 0.48,
                payoff,
                supportingSampleSize: 50,
                calibrationStatus: 'FAIR',
            });
            // EV = 0.48 * 1.5 - 0.52 * 1.0 = 0.72 - 0.52 = +0.20R
            expect(rec.recommendation).toBe('LOW_CONFIDENCE');
        });
        it('rejects trades with negative expected value (WAIT)', () => {
            const payoff = { targetR: 1.0, lossR: 1.0 };
            const rec = ai_trade_learning_engine_1.ExpectedValueEngine.evaluateRecommendation({
                probability: 0.4,
                payoff,
                supportingSampleSize: 100,
            });
            expect(rec.recommendation).toBe('WAIT');
            expect(rec.reasons.some((r) => r.includes('NEGATIVE_EXPECTANCY'))).toBe(true);
        });
        it('downgrades recommendation to WAIT when probability calibration is POOR', () => {
            const payoff = { targetR: 2.5, lossR: 1.0 };
            const rec = ai_trade_learning_engine_1.ExpectedValueEngine.evaluateRecommendation({
                probability: 0.75,
                payoff,
                supportingSampleSize: 120,
                calibrationStatus: 'POOR',
            });
            expect(rec.recommendation).toBe('WAIT');
            expect(rec.reasons.some((r) => r.includes('POOR_CALIBRATION'))).toBe(true);
        });
    });
});
//# sourceMappingURL=expected-value-engine.test.js.map