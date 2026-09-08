"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TemporalFeatureScaler = void 0;
class TemporalFeatureScaler {
    featureStats = new Map();
    /**
     * Fits normalization parameters (mean, std, min, max) EXCLUSIVELY on the training fold.
     * Ensures zero future-data leakage into scaling parameters.
     */
    fit(trainingData) {
        this.featureStats.clear();
        if (!trainingData || trainingData.length === 0)
            return;
        // Collect values per feature
        const featureValuesMap = new Map();
        for (const item of trainingData) {
            const feats = 'features' in item ? item.features : item.marketState?.quant;
            if (!feats || typeof feats !== 'object')
                continue;
            for (const [key, val] of Object.entries(feats)) {
                if (typeof val === 'number' && Number.isFinite(val)) {
                    if (!featureValuesMap.has(key)) {
                        featureValuesMap.set(key, []);
                    }
                    featureValuesMap.get(key).push(val);
                }
            }
        }
        // Compute stats per feature
        for (const [featureName, values] of featureValuesMap.entries()) {
            if (values.length === 0)
                continue;
            const n = values.length;
            const sum = values.reduce((a, b) => a + b, 0);
            const mean = sum / n;
            const variance = n > 1 ? values.reduce((acc, v) => acc + Math.pow(v - mean, 2), 0) / (n - 1) : 0;
            const std = Math.sqrt(variance) || 1e-6; // Avoid div zero
            let min = Infinity;
            let max = -Infinity;
            for (const v of values) {
                if (v < min)
                    min = v;
                if (v > max)
                    max = v;
            }
            this.featureStats.set(featureName, { mean, std, min, max });
        }
    }
    /**
     * Transforms feature values using pre-computed training parameters.
     * Standardizes values (z-score: (x - mean) / std).
     */
    transformValue(featureName, rawValue) {
        const stats = this.featureStats.get(featureName);
        if (!stats)
            return rawValue;
        return (rawValue - stats.mean) / stats.std;
    }
    /**
     * Transforms a map of features using pre-computed training parameters.
     */
    transform(features) {
        const scaled = {};
        for (const [key, val] of Object.entries(features)) {
            if (typeof val === 'number') {
                scaled[key] = this.transformValue(key, val);
            }
        }
        return scaled;
    }
    getParams(featureName) {
        return this.featureStats.get(featureName);
    }
}
exports.TemporalFeatureScaler = TemporalFeatureScaler;
//# sourceMappingURL=feature-scaler.js.map