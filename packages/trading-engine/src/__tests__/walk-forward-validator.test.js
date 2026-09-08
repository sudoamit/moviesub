"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const ai_trade_learning_engine_1 = require("../ai-trade-learning-engine");
function createTimeOrderedDataset(count) {
    const examples = [];
    const baseTime = new Date('2024-01-01T09:15:00.000Z').getTime();
    for (let i = 0; i < count; i++) {
        const smcScore = 0.3 + (i % 6) * 0.12;
        const obStrength = 0.4 + (i % 4) * 0.15;
        const mtfAlignment = i % 3 === 0 ? 0.9 : 0.2;
        const features = {
            smcScore,
            obStrength,
            fvgSize: 0.5,
            mtfAlignment,
            killZoneSession: 1.0,
            smtDivergence: 0.7,
            volatilityAtr: 0.5,
            riskRewardRatio: 0.6,
            trendRegime: 0.8,
            liquiditySweep: 0.8,
            bosStrength: 0.7,
            chochStrength: 0.7,
            relativeVolume: 0.6,
            distanceToHTFLevel: 0.3,
            distanceToLiquidity: 0.3,
            marketSession: 0.5,
            dayOfWeek: 0.3,
        };
        const isWin = smcScore + obStrength + mtfAlignment > 1.8 ? 1 : 0;
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
        // Timestamp strictly increments by 1 hour
        const predTime = new Date(baseTime + i * 3600000);
        const availTime = new Date(baseTime + i * 3600000 + 1800000);
        examples.push({
            id: `wf-${i}`,
            symbol: 'NIFTY',
            featureSchemaVersion: ai_trade_learning_engine_1.FEATURE_SCHEMA_VERSION,
            features,
            featureArray,
            label: isWin,
            outcomeR: isWin === 1 ? 2.5 : -1.0,
            predictionTimestamp: predTime,
            availableForTrainingAt: availTime,
        });
    }
    return examples;
}
describe('PHASE 4: Walk-Forward Validation & Model Promotion', () => {
    describe('1. ChronologicalSplitter', () => {
        it('splits dataset strictly into chronological Train, Validation, and Out-of-Sample partitions without leakage', () => {
            const dataset = createTimeOrderedDataset(100);
            const splits = ai_trade_learning_engine_1.ChronologicalSplitter.split(dataset, {
                trainRatio: 0.6,
                validationRatio: 0.2,
                outOfSampleRatio: 0.2,
            });
            expect(splits.counts.train).toBe(60);
            expect(splits.counts.validation).toBe(20);
            expect(splits.counts.outOfSample).toBe(20);
            // Verify strict time bounds (no overlap)
            const trainEnd = new Date(splits.periods.trainEnd).getTime();
            const valStart = new Date(splits.periods.validationStart).getTime();
            const valEnd = new Date(splits.periods.validationEnd).getTime();
            const oosStart = new Date(splits.periods.outOfSampleStart).getTime();
            expect(trainEnd).toBeLessThan(valStart);
            expect(valEnd).toBeLessThan(oosStart);
        });
    });
    describe('2. WalkForwardValidator', () => {
        it('executes multiple expanding-window walk-forward folds', () => {
            const dataset = createTimeOrderedDataset(90);
            const result = ai_trade_learning_engine_1.WalkForwardValidator.runWalkForward(dataset, () => new ai_trade_learning_engine_1.TradePredictionModel('v1.0.0', { maxEpochs: 40 }), 3);
            expect(result.folds.length).toBe(3);
            expect(result.folds[0].foldIndex).toBe(1);
            expect(result.folds[1].foldIndex).toBe(2);
            expect(result.folds[2].foldIndex).toBe(3);
            // Expanding train window
            expect(result.folds[0].train.length).toBeLessThan(result.folds[1].train.length);
            expect(result.folds[1].train.length).toBeLessThan(result.folds[2].train.length);
            expect(typeof result.meanTestLogLoss).toBe('number');
            expect(typeof result.meanTestAccuracy).toBe('number');
            expect(typeof result.meanTestRocAuc).toBe('number');
            expect(result.stabilityScore).toBeGreaterThanOrEqual(0.0);
        });
    });
    describe('3. ModelPromotionEngine', () => {
        it('promotes a trained candidate model that beats the baseline and meets all criteria', () => {
            const fullData = createTimeOrderedDataset(100);
            const splits = ai_trade_learning_engine_1.ChronologicalSplitter.split(fullData, {
                trainRatio: 0.6,
                validationRatio: 0.2,
                outOfSampleRatio: 0.2,
            });
            const baseline = new ai_trade_learning_engine_1.TradePredictionModel('v1.0.0-baseline', {}, new Array(17).fill(0.0), 0.0);
            const candidate = new ai_trade_learning_engine_1.TradePredictionModel('v1.1.0-candidate', {
                learningRate: 0.1,
                maxEpochs: 60,
            });
            candidate.train(splits.train);
            const decision = ai_trade_learning_engine_1.ModelPromotionEngine.evaluatePromotion(candidate, splits.outOfSample, baseline, { minSampleSize: 15, maxOutOfSampleLogLoss: 0.693 });
            expect(decision.decisionStatus).toBe('PROMOTED');
            expect(decision.isPromoted).toBe(true);
            expect(decision.candidateMetrics.sampleSize).toBe(20);
        });
        it('rejects candidate model when out-of-sample sample size is below minimum threshold', () => {
            const smallData = createTimeOrderedDataset(15);
            const candidate = new ai_trade_learning_engine_1.TradePredictionModel('v1.1.0-candidate');
            const decision = ai_trade_learning_engine_1.ModelPromotionEngine.evaluatePromotion(candidate, smallData, null, {
                minSampleSize: 30,
            });
            expect(decision.decisionStatus).toBe('INSUFFICIENT_DATA');
            expect(decision.isPromoted).toBe(false);
            expect(decision.reasons.some((r) => r.includes('Insufficient out-of-sample sample size'))).toBe(true);
        });
        it('rejects candidate model when out-of-sample log loss is worse than baseline', () => {
            const fullData = createTimeOrderedDataset(80);
            const splits = ai_trade_learning_engine_1.ChronologicalSplitter.split(fullData, {
                trainRatio: 0.6,
                validationRatio: 0.2,
                outOfSampleRatio: 0.2,
            });
            // Baseline with good weights
            const baseline = new ai_trade_learning_engine_1.TradePredictionModel('v1.0.0-good');
            baseline.train(splits.train);
            // Candidate with deliberately corrupted weights
            const badCandidate = new ai_trade_learning_engine_1.TradePredictionModel('v1.1.0-corrupt', {}, new Array(17).fill(-5.0), -2.0);
            const decision = ai_trade_learning_engine_1.ModelPromotionEngine.evaluatePromotion(badCandidate, splits.outOfSample, baseline, { minSampleSize: 10 });
            expect(decision.decisionStatus).toBe('REJECTED');
            expect(decision.isPromoted).toBe(false);
            expect(decision.reasons.length).toBeGreaterThan(0);
        });
    });
});
//# sourceMappingURL=walk-forward-validator.test.js.map