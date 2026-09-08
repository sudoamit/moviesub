"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.FeatureSelector = void 0;
const feature_analysis_1 = require("./feature-analysis");
class FeatureSelector {
    /**
     * Evaluates feature subsets and prunes low-importance, noisy dimensions that do not contribute to out-of-sample expectancy.
     */
    static selectFeatures(experiences, minImportanceThreshold = 0.02) {
        const importances = feature_analysis_1.FeatureAnalyzer.analyze(experiences);
        const n = experiences.length;
        const totalR = experiences.reduce((sum, e) => sum + e.outcome.pnlR, 0);
        const baselineExpectancy = n > 0 ? Number((totalR / n).toFixed(2)) : 0;
        const retainedFeatures = [];
        const prunedFeatures = [];
        for (const item of importances) {
            if (item.importanceScore >= minImportanceThreshold) {
                retainedFeatures.push(item.featureName);
            }
            else {
                prunedFeatures.push(item.featureName);
            }
        }
        // Always preserve core SMC features even if current sample is small
        const coreMustRetain = ['smcScore', 'mtfAlignment', 'obStrength', 'liquiditySweep'];
        for (const core of coreMustRetain) {
            if (!retainedFeatures.includes(core)) {
                retainedFeatures.push(core);
                const pIdx = prunedFeatures.indexOf(core);
                if (pIdx >= 0)
                    prunedFeatures.splice(pIdx, 1);
            }
        }
        // Evaluate feature subset performance experimentally on retained dimensions
        const evaluatedRetained = experiences.filter((e) => {
            // Check if all core retained features meet signal quality criteria
            const quant = e.marketState?.quant || {};
            return retainedFeatures.every((fName) => {
                const val = quant[fName];
                return val === undefined || typeof val !== 'number' || val >= 0.35;
            });
        });
        const evaluatedSumR = evaluatedRetained.reduce((sum, e) => sum + e.outcome.pnlR, 0);
        const optimizedExpectancy = evaluatedRetained.length > 0
            ? Number((evaluatedSumR / evaluatedRetained.length).toFixed(2))
            : baselineExpectancy;
        const deltaR = Number((optimizedExpectancy - baselineExpectancy).toFixed(2));
        return {
            retainedFeatures,
            prunedFeatures,
            baselineExpectancy,
            optimizedExpectancy,
            deltaR,
        };
    }
}
exports.FeatureSelector = FeatureSelector;
//# sourceMappingURL=feature-selector.js.map