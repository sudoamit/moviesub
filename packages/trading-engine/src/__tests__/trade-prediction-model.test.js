"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const ai_trade_learning_engine_1 = require("../ai-trade-learning-engine");
function createSyntheticDataset(count, signalToNoiseRatio = 0.8) {
    const examples = [];
    const baseTime = new Date('2026-08-01T09:15:00.000Z').getTime();
    for (let i = 0; i < count; i++) {
        // Synthetic ground-truth rule: High smcScore + obStrength + mtfAlignment correlates to Win
        const smcScore = 0.3 + (i % 7) * 0.1;
        const obStrength = 0.2 + (i % 5) * 0.15;
        const mtfAlignment = i % 3 === 0 ? 0.9 : 0.2;
        const killZoneSession = i % 2 === 0 ? 1.0 : 0.0;
        const features = {
            smcScore,
            obStrength,
            fvgSize: 0.5,
            mtfAlignment,
            killZoneSession,
            smtDivergence: 0.6,
            volatilityAtr: 0.4,
            riskRewardRatio: 0.6,
            trendRegime: 0.8,
            liquiditySweep: 0.7,
            bosStrength: 0.65,
            chochStrength: 0.5,
            relativeVolume: 0.6,
            distanceToHTFLevel: 0.3,
            distanceToLiquidity: 0.4,
            marketSession: 0.5,
            dayOfWeek: 0.3,
        };
        // Ground truth probability
        const logit = 3.0 * smcScore + 2.5 * obStrength + 2.0 * mtfAlignment - 3.5;
        const trueProb = 1.0 / (1.0 + Math.exp(-logit));
        const isWin = i / count < trueProb ? 1 : 0;
        const featureArray = [
            features.smcScore,
            features.obStrength,
            features.fvgSize,
            features.mtfAlignment,
            features.killZoneSession,
            features.smtDivergence,
            features.volatilityAtr,
            features.riskRewardRatio,
            features.trendRegime,
            features.liquiditySweep,
            features.bosStrength,
            features.chochStrength,
            features.relativeVolume,
            features.distanceToHTFLevel,
            features.distanceToLiquidity,
            features.marketSession,
            features.dayOfWeek,
        ];
        examples.push({
            id: `syn-${i}`,
            symbol: 'NIFTY',
            featureSchemaVersion: ai_trade_learning_engine_1.FEATURE_SCHEMA_VERSION,
            features,
            featureArray,
            label: isWin,
            outcomeR: isWin === 1 ? 2.5 : -1.0,
            predictionTimestamp: new Date(baseTime + i * 900000),
            availableForTrainingAt: new Date(baseTime + i * 900000 + 1800000),
        });
    }
    return examples;
}
describe('PHASE 3: Baseline Logistic Regression TradePredictionModel', () => {
    it('predicts win probabilities strictly bounded inside [0.0001, 0.9999]', () => {
        const model = new ai_trade_learning_engine_1.TradePredictionModel('v1.0.0');
        const features = {
            smcScore: 0.9,
            obStrength: 0.85,
            fvgSize: 0.7,
            mtfAlignment: 0.9,
            killZoneSession: 1.0,
            smtDivergence: 0.8,
            volatilityAtr: 0.5,
            riskRewardRatio: 0.7,
            trendRegime: 1.0,
            liquiditySweep: 1.0,
            bosStrength: 0.8,
            chochStrength: 0.8,
            relativeVolume: 0.8,
            distanceToHTFLevel: 0.2,
            distanceToLiquidity: 0.2,
            marketSession: 0.4,
            dayOfWeek: 0.3,
        };
        const prob = model.predictProbability(features);
        expect(prob).toBeGreaterThanOrEqual(0.0001);
        expect(prob).toBeLessThanOrEqual(0.9999);
        const result = model.predict(features);
        expect(result.modelVersion).toBe('v1.0.0');
        expect(result.probability).toBeCloseTo(prob, 3);
        expect(typeof result.rawLogit).toBe('number');
    });
    it('performs online stochastic gradient descent and updates weights correctly', () => {
        const model = new ai_trade_learning_engine_1.TradePredictionModel('v1.0.0', { learningRate: 0.1 });
        const features = {
            smcScore: 0.9,
            obStrength: 0.9,
            fvgSize: 0.5,
            mtfAlignment: 0.9,
            killZoneSession: 1.0,
            smtDivergence: 0.5,
            volatilityAtr: 0.5,
            riskRewardRatio: 0.5,
            trendRegime: 0.5,
            liquiditySweep: 1.0,
            bosStrength: 0.5,
            chochStrength: 0.5,
            relativeVolume: 0.5,
            distanceToHTFLevel: 0.5,
            distanceToLiquidity: 0.5,
            marketSession: 0.5,
            dayOfWeek: 0.5,
        };
        const initialProb = model.predictProbability(features);
        // Update with positive label (Win = 1)
        model.update(features, 1);
        const updatedProb = model.predictProbability(features);
        // Probability for this setup must increase after positive reinforcement
        expect(updatedProb).toBeGreaterThan(initialProb);
        // Update multiple times with negative label (Loss = 0)
        for (let i = 0; i < 5; i++) {
            model.update(features, 0);
        }
        const finalProb = model.predictProbability(features);
        expect(finalProb).toBeLessThan(updatedProb);
    });
    it('trains on a dataset and achieves loss convergence', () => {
        const dataset = createSyntheticDataset(120);
        const model = new ai_trade_learning_engine_1.TradePredictionModel('v1.0.0', {
            learningRate: 0.1,
            batchSize: 16,
            maxEpochs: 60,
        });
        const metrics = model.train(dataset);
        expect(metrics.totalExamples).toBe(120);
        expect(metrics.epochsTrained).toBeGreaterThan(0);
        expect(metrics.finalLoss).toBeLessThan(metrics.initialLoss);
        expect(metrics.accuracy).toBeGreaterThan(0.5);
        expect(metrics.brierScore).toBeLessThan(0.35);
        expect(metrics.rocAuc).toBeGreaterThan(0.6);
    });
    it('evaluates quantitative metrics accurately across all required metrics', () => {
        const dataset = createSyntheticDataset(60);
        const model = new ai_trade_learning_engine_1.TradePredictionModel('v1.0.0');
        model.train(dataset);
        const evalMetrics = model.evaluate(dataset);
        expect(evalMetrics.sampleSize).toBe(60);
        expect(evalMetrics.accuracy).toBeGreaterThanOrEqual(0.0);
        expect(evalMetrics.accuracy).toBeLessThanOrEqual(1.0);
        expect(evalMetrics.precision).toBeGreaterThanOrEqual(0.0);
        expect(evalMetrics.recall).toBeGreaterThanOrEqual(0.0);
        expect(evalMetrics.f1Score).toBeGreaterThanOrEqual(0.0);
        expect(evalMetrics.logLoss).toBeGreaterThan(0.0);
        expect(evalMetrics.brierScore).toBeGreaterThan(0.0);
        expect(evalMetrics.rocAuc).toBeGreaterThanOrEqual(0.0);
        expect(evalMetrics.rocAuc).toBeLessThanOrEqual(1.0);
        expect(typeof evalMetrics.profitFactor).toBe('number');
        expect(typeof evalMetrics.expectancyR).toBe('number');
        expect(typeof evalMetrics.maxDrawdownR).toBe('number');
    });
    it('extracts feature importance ranked by absolute weight magnitude', () => {
        const model = new ai_trade_learning_engine_1.TradePredictionModel('v1.0.0');
        const dataset = createSyntheticDataset(80);
        model.train(dataset);
        const importance = model.getFeatureImportance();
        expect(importance.length).toBe(ai_trade_learning_engine_1.FEATURE_VECTOR_DIMENSION);
        // Verify ordering is strictly descending by absoluteWeight
        for (let i = 1; i < importance.length; i++) {
            expect(importance[i - 1].absoluteWeight).toBeGreaterThanOrEqual(importance[i].absoluteWeight);
        }
    });
});
//# sourceMappingURL=trade-prediction-model.test.js.map