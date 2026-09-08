"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const ai_trade_learning_engine_1 = require("../ai-trade-learning-engine");
describe('PHASE 5: Probability Calibration & Statistical Confidence Intervals', () => {
    describe('1. ProbabilityCalibrationEngine — Reliability Diagram & ECE', () => {
        it('generates a 10-bin calibration report with accurate Expected Calibration Error (ECE)', () => {
            // Create synthetic predicted probabilities and observed binary outcomes
            const predictions = [];
            // 80-90% Bucket: 20 samples, mean ~0.85, 17 wins (85% win rate -> zero error)
            for (let i = 0; i < 20; i++) {
                predictions.push({
                    predictedProb: 0.82 + (i % 5) * 0.015, // 0.82 to 0.88
                    actualLabel: i < 17 ? 1 : 0, // 85% observed win rate
                });
            }
            // 50-60% Bucket: 20 samples, mean ~0.55, 11 wins (55% win rate)
            for (let i = 0; i < 20; i++) {
                predictions.push({
                    predictedProb: 0.52 + (i % 5) * 0.015,
                    actualLabel: i < 11 ? 1 : 0, // 55% observed win rate
                });
            }
            // 20-30% Bucket: 20 samples, mean ~0.25, 5 wins (25% win rate)
            for (let i = 0; i < 20; i++) {
                predictions.push({
                    predictedProb: 0.22 + (i % 5) * 0.015,
                    actualLabel: i < 5 ? 1 : 0, // 25% observed win rate
                });
            }
            const report = ai_trade_learning_engine_1.ProbabilityCalibrationEngine.generateCalibrationReport(predictions, 10);
            expect(report.bins.length).toBe(10);
            expect(report.totalSamples).toBe(60);
            expect(report.expectedCalibrationError).toBeLessThan(0.05);
            expect(report.status).toBe('EXCELLENT');
            // Inspect 80-90% bin (binIndex = 9)
            const bin8090 = report.bins.find((b) => b.binRangeLabel === '80-90%');
            expect(bin8090).toBeDefined();
            expect(bin8090.sampleCount).toBe(20);
            expect(bin8090.meanPredictedProbability).toBeCloseTo(0.85, 1);
            expect(bin8090.observedWinRate).toBeCloseTo(0.85, 1);
            expect(bin8090.calibrationError).toBeLessThan(0.03);
        });
        it('flags poor calibration when predicted probabilities deviate sharply from reality', () => {
            // Overconfident model: Predicts 90% win rate, but actual outcomes are only 40%
            const miscalibrated = [];
            for (let i = 0; i < 30; i++) {
                miscalibrated.push({
                    predictedProb: 0.88,
                    actualLabel: i < 12 ? 1 : 0, // 40% actual
                });
            }
            const report = ai_trade_learning_engine_1.ProbabilityCalibrationEngine.generateCalibrationReport(miscalibrated, 10);
            expect(report.expectedCalibrationError).toBeGreaterThan(0.4);
            expect(report.status).toBe('POOR');
        });
        it('returns INSUFFICIENT_DATA status when sample size is below minimum threshold', () => {
            const tinySample = [
                { predictedProb: 0.8, actualLabel: 1 },
                { predictedProb: 0.7, actualLabel: 0 },
            ];
            const report = ai_trade_learning_engine_1.ProbabilityCalibrationEngine.generateCalibrationReport(tinySample, 10);
            expect(report.status).toBe('INSUFFICIENT_DATA');
            expect(report.totalSamples).toBe(2);
        });
    });
    describe('2. Wilson Score Statistical Confidence Intervals', () => {
        it('returns null when sample size is below minimum threshold (< 15)', () => {
            const interval = ai_trade_learning_engine_1.ProbabilityCalibrationEngine.calculateConfidenceInterval(0.82, 10, 15);
            expect(interval).toBeNull();
        });
        it('calculates rigorous 95% Wilson Score interval for adequate sample sizes', () => {
            const interval = ai_trade_learning_engine_1.ProbabilityCalibrationEngine.calculateConfidenceInterval(0.84, 50, 15, 0.95);
            expect(interval).not.toBeNull();
            expect(interval.confidenceLevel).toBe(0.95);
            expect(interval.sampleSize).toBe(50);
            expect(interval.lower).toBeGreaterThan(0.7);
            expect(interval.lower).toBeLessThan(0.84);
            expect(interval.upper).toBeGreaterThan(0.84);
            expect(interval.upper).toBeLessThan(0.95);
        });
        it('narrows the confidence interval as sample size increases', () => {
            const smallN = ai_trade_learning_engine_1.ProbabilityCalibrationEngine.calculateConfidenceInterval(0.8, 20);
            const largeN = ai_trade_learning_engine_1.ProbabilityCalibrationEngine.calculateConfidenceInterval(0.8, 200);
            const smallSpread = smallN.upper - smallN.lower;
            const largeSpread = largeN.upper - largeN.lower;
            expect(largeSpread).toBeLessThan(smallSpread);
        });
    });
    describe('3. PlattScaler — Univariate Logistic Recalibration', () => {
        it('fits parameters and recalibrates uncalibrated predictions toward true empirical win rates', () => {
            const rawProbs = [
                0.9, 0.85, 0.88, 0.82, 0.89, 0.2, 0.18, 0.22, 0.15, 0.19, 0.87, 0.84, 0.21, 0.17,
            ];
            const labels = [1, 1, 1, 0, 1, 0, 0, 0, 0, 0, 1, 1, 0, 0];
            const scaler = new ai_trade_learning_engine_1.PlattScaler();
            scaler.fit(rawProbs, labels, 60, 0.1);
            const params = scaler.getParameters();
            expect(params.isFitted).toBe(true);
            const highProbCalibrated = scaler.calibrate(0.88);
            const lowProbCalibrated = scaler.calibrate(0.18);
            expect(highProbCalibrated).toBeGreaterThan(0.7);
            expect(lowProbCalibrated).toBeLessThan(0.3);
        });
    });
});
//# sourceMappingURL=probability-calibration.test.js.map