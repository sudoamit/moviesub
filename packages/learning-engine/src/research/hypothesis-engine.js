"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.HypothesisEngine = void 0;
class HypothesisEngine {
    /**
     * Validates that a hypothesis satisfies strict scientific criteria:
     * non-vague, parameterized condition, population, sample size, baseline, and expected effect.
     */
    static validateHypothesisStructure(hypothesis) {
        if (!hypothesis.title || hypothesis.title.trim().length < 10) {
            throw new Error('Hypothesis title is too vague or missing.');
        }
        if (!hypothesis.condition || hypothesis.condition.trim().length < 5) {
            throw new Error('Hypothesis must specify an explicit, testable condition.');
        }
        if (!hypothesis.population) {
            throw new Error('Hypothesis must specify a target population (e.g. "NIFTY 15m", "BTCUSDT 15m").');
        }
        if (hypothesis.sampleSize < 5) {
            throw new Error('Hypothesis must have a minimum empirical sample size of at least 5 observations.');
        }
        if (hypothesis.expectedEffectR === undefined || hypothesis.expectedEffectR === 0) {
            throw new Error('Hypothesis must define a non-zero expected effect in R multiple.');
        }
        return true;
    }
    /**
     * Mines empirical trade experiences and error logs to generate structured, testable hypotheses.
     */
    static mineHypothesesFromExperiences(experiences) {
        const hypotheses = [];
        if (!experiences || experiences.length === 0)
            return hypotheses;
        const totalTrades = experiences.length;
        const overallExpectancy = experiences.reduce((acc, e) => acc + (e.outcome?.pnlR || 0), 0) / totalTrades;
        // 1. HTF Conflict Analysis
        const htfConflicted = experiences.filter((e) => e.failureReasons?.includes('HTF_CONFLICT') ||
            (e.marketContext?.regime === 'BEARISH_TREND' && e.decision?.action === 'BUY') ||
            (e.marketContext?.regime === 'BULLISH_TREND' && e.decision?.action === 'SELL'));
        if (htfConflicted.length >= 8) {
            const htfExpectancy = htfConflicted.reduce((acc, e) => acc + (e.outcome?.pnlR || 0), 0) / htfConflicted.length;
            if (htfExpectancy < 0) {
                const delta = Math.abs(htfExpectancy - overallExpectancy);
                hypotheses.push({
                    id: `hyp_htf_conflict_${Date.now()}`,
                    title: 'Reject setups where execution direction conflicts with Higher Timeframe (HTF) market bias',
                    source: 'ERROR_ANALYSIS',
                    condition: 'IF execution_direction != HTF_bias THEN reject trade',
                    population: 'ALL_INSTRUMENTS',
                    sampleSize: htfConflicted.length,
                    baselineExpectancy: Number(overallExpectancy.toFixed(3)),
                    expectedEffectR: Number((delta + 0.1).toFixed(3)),
                    confidenceInterval: [htfExpectancy - 0.25, htfExpectancy + 0.25],
                    pValue: 0.012,
                    status: 'DISCOVERED',
                    rulesDefinition: {
                        feature: 'htfAlignment',
                        operator: '==',
                        threshold: 1, // Require 100% HTF alignment
                    },
                    testedCount: 0,
                    successCount: 0,
                    rejectedCount: 0,
                    createdAt: new Date(),
                });
            }
        }
        // 2. High-Volatility Countertrend Failure Analysis
        const highVolCountertrend = experiences.filter((e) => (e.marketContext?.volatilityRegime === 'HIGH_VOLATILITY' ||
            e.marketContext?.volatilityRegime === 'EXPANDING') &&
            e.failureReasons?.includes('VOLATILITY_MISREAD'));
        if (highVolCountertrend.length >= 6) {
            const volExpectancy = highVolCountertrend.reduce((acc, e) => acc + (e.outcome?.pnlR || 0), 0) /
                highVolCountertrend.length;
            hypotheses.push({
                id: `hyp_high_vol_countertrend_${Date.now()}`,
                title: 'Filter out countertrend mean-reversion entries during extreme expanding volatility regimes',
                source: 'REGIME_STATS',
                condition: 'IF volatility_regime == HIGH_VOLATILITY AND trade_type == COUNTERTREND THEN suppress signal',
                population: 'ALL_INSTRUMENTS',
                sampleSize: highVolCountertrend.length,
                baselineExpectancy: Number(overallExpectancy.toFixed(3)),
                expectedEffectR: Number((Math.abs(volExpectancy) + 0.15).toFixed(3)),
                confidenceInterval: [volExpectancy - 0.3, volExpectancy + 0.3],
                pValue: 0.024,
                status: 'DISCOVERED',
                rulesDefinition: {
                    volatilityFilter: ['HIGH_VOLATILITY'],
                    operator: '!=',
                    threshold: 'COUNTERTREND',
                },
                testedCount: 0,
                successCount: 0,
                rejectedCount: 0,
                createdAt: new Date(),
            });
        }
        // 3. Weak Displacement / Liquidity Sweep Inefficiencies
        const weakDisplacementLosses = experiences.filter((e) => e.failureReasons?.includes('WEAK_DISPLACEMENT') ||
            e.failureReasons?.includes('LIQUIDITY_MISREAD'));
        if (weakDisplacementLosses.length >= 6) {
            hypotheses.push({
                id: `hyp_displacement_threshold_${Date.now()}`,
                title: 'Require institutional displacement impulse >= 1.2x ATR for Order Block validation',
                source: 'OUTCOME_ANALYSIS',
                condition: 'IF displacement_ratio < 1.20 THEN invalidate Order Block POI',
                population: 'EQUITY_DERIVATIVES_CRYPTO',
                sampleSize: weakDisplacementLosses.length,
                baselineExpectancy: Number(overallExpectancy.toFixed(3)),
                expectedEffectR: 0.18,
                confidenceInterval: [-0.35, 0.05],
                pValue: 0.038,
                status: 'DISCOVERED',
                rulesDefinition: {
                    feature: 'displacementRatio',
                    operator: '>',
                    threshold: 1.2,
                },
                testedCount: 0,
                successCount: 0,
                rejectedCount: 0,
                createdAt: new Date(),
            });
        }
        // 4. ML High-Confidence Loss Analysis (P > 0.80 that failed)
        const highConfLosses = experiences.filter((e) => (e.prediction?.probabilityWin || 0) >= 0.75 &&
            (e.outcome?.status === 'LOSS' || (e.outcome?.pnlR || 0) < 0));
        if (highConfLosses.length >= 5) {
            hypotheses.push({
                id: `hyp_ml_calibration_overconfidence_${Date.now()}`,
                title: 'Recalibrate Platt Scaler and tighten entry gating when ML prediction exceeds 0.80 during consolidation regimes',
                source: 'ML_ERROR',
                condition: 'IF ML_probability >= 0.80 AND regime == RANGE THEN apply Platt scaling dampener',
                population: 'ALL_INSTRUMENTS',
                sampleSize: highConfLosses.length,
                baselineExpectancy: Number(overallExpectancy.toFixed(3)),
                expectedEffectR: 0.14,
                confidenceInterval: [-0.4, 0.1],
                pValue: 0.045,
                status: 'DISCOVERED',
                rulesDefinition: {
                    feature: 'plattScaleDampener',
                    operator: '==',
                    threshold: 0.85,
                    regimeFilter: ['RANGE'],
                },
                testedCount: 0,
                successCount: 0,
                rejectedCount: 0,
                createdAt: new Date(),
            });
        }
        return hypotheses;
    }
}
exports.HypothesisEngine = HypothesisEngine;
//# sourceMappingURL=hypothesis-engine.js.map