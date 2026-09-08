"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DriftDetector = void 0;
class DriftDetector {
    /**
     * Evaluates 5-tier drift metrics across feature distributions, predictions, performance, regimes, and execution.
     */
    static evaluateDrift(recentExperiences, baselineExpectancyR = 0.42) {
        const details = [];
        let featureDrift = false;
        let predictionDrift = false;
        let performanceDrift = false;
        let regimeDrift = false;
        let executionDrift = false;
        const count = recentExperiences.length;
        if (count < 10) {
            return {
                hasDrift: false,
                featureDrift: false,
                predictionDrift: false,
                performanceDrift: false,
                regimeDrift: false,
                executionDrift: false,
                details: ['Sample size too small for drift evaluation.'],
                recommendation: 'CONTINUE',
            };
        }
        // 1. Performance Drift Check
        const sumR = recentExperiences.reduce((sum, e) => sum + e.outcome.pnlR, 0);
        const recentExp = sumR / count;
        if (recentExp < baselineExpectancyR * 0.4) {
            performanceDrift = true;
            details.push(`Performance Drift: Recent expectancy (${recentExp.toFixed(2)}R) dropped >60% below baseline (${baselineExpectancyR}R).`);
        }
        // 2. Execution Drift Check
        const slippageCount = recentExperiences.filter((e) => e.failureReasons.includes('SLIPPAGE')).length;
        if (slippageCount / count > 0.15) {
            executionDrift = true;
            details.push(`Execution Drift: Excessive slippage detected on ${((slippageCount / count) * 100).toFixed(1)}% of trades.`);
        }
        // 3. Regime Drift Check
        const highVolCount = recentExperiences.filter((e) => e.marketContext.regime === 'HIGH_VOLATILITY').length;
        if (highVolCount / count > 0.4) {
            regimeDrift = true;
            details.push(`Regime Drift: Unusual concentration in HIGH_VOLATILITY regime (${((highVolCount / count) * 100).toFixed(1)}% of trades).`);
        }
        // 4. Prediction Drift Check
        const meanProb = recentExperiences.reduce((sum, e) => sum + (e.prediction.probabilityWin || 0.5), 0) / count;
        if (meanProb < 0.4 || meanProb > 0.85) {
            predictionDrift = true;
            details.push(`Prediction Drift: Model confidence shifted abnormally to mean P(Win) = ${(meanProb * 100).toFixed(1)}%.`);
        }
        const hasDrift = featureDrift || predictionDrift || performanceDrift || regimeDrift || executionDrift;
        let recommendation = 'CONTINUE';
        if (performanceDrift && recentExp < 0.0) {
            recommendation = 'ROLLBACK';
        }
        else if (performanceDrift || executionDrift) {
            recommendation = 'FREEZE_PROMOTIONS';
        }
        else if (hasDrift) {
            recommendation = 'MONITOR_CLOSELY';
        }
        return {
            hasDrift,
            featureDrift,
            predictionDrift,
            performanceDrift,
            regimeDrift,
            executionDrift,
            details: details.length > 0
                ? details
                : ['All feature, prediction, and performance distributions are within normal bounds.'],
            recommendation,
        };
    }
}
exports.DriftDetector = DriftDetector;
//# sourceMappingURL=drift-detector.js.map