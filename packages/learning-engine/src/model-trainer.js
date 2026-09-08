"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.ModelTrainer = void 0;
const crypto = __importStar(require("crypto"));
const trading_engine_1 = require("@quant/trading-engine");
class ModelTrainer {
    /**
     * Trains a canonical 28-dimensional logistic model on an EXPLICIT temporal training dataset slice.
     */
    static trainModel(trainingDataset, epochs = 50, learningRate = 0.05, l2Lambda = 0.01) {
        const weights = trading_engine_1.CANONICAL_FEATURE_NAMES_V2.map((_, i) => Number((Math.sin(i + 1) * 0.1).toFixed(4)));
        let bias = 0.1;
        if (!trainingDataset || trainingDataset.length === 0) {
            return {
                modelVersion: 'ml-v2-empty',
                weights,
                bias,
                featureSchemaVersion: '2.0',
                sampleCount: 0,
                trainLoss: 0.693,
                trainedAt: new Date(0),
            };
        }
        const samples = [];
        for (const exp of trainingDataset) {
            const featVector = [];
            const feats = 'features' in exp ? exp.features : exp.marketState?.quant;
            for (const name of trading_engine_1.CANONICAL_FEATURE_NAMES_V2) {
                const val = feats?.[name] ?? 0.5;
                featVector.push(typeof val === 'number' ? val : 0.5);
            }
            const label = 'labelBinary' in exp ? exp.labelBinary : (exp.outcome?.status === 'WIN' ? 1.0 : 0.0);
            samples.push({ features: featVector, label });
        }
        let finalLoss = 0.693;
        for (let epoch = 0; epoch < epochs; epoch++) {
            let totalLoss = 0;
            const gradW = new Array(trading_engine_1.CANONICAL_V2_DIMENSION).fill(0);
            let gradB = 0;
            for (const s of samples) {
                let z = bias;
                for (let j = 0; j < trading_engine_1.CANONICAL_V2_DIMENSION; j++) {
                    z += weights[j] * (s.features[j] - 0.5);
                }
                const prob = 1.0 / (1.0 + Math.exp(-Math.max(-10, Math.min(10, z))));
                const err = prob - s.label;
                // Binary cross-entropy loss
                const loss = -s.label * Math.log(Math.max(1e-7, prob)) -
                    (1 - s.label) * Math.log(Math.max(1e-7, 1 - prob));
                totalLoss += loss;
                for (let j = 0; j < trading_engine_1.CANONICAL_V2_DIMENSION; j++) {
                    gradW[j] += err * (s.features[j] - 0.5) + l2Lambda * weights[j];
                }
                gradB += err;
            }
            const n = samples.length;
            finalLoss = totalLoss / n;
            for (let j = 0; j < trading_engine_1.CANONICAL_V2_DIMENSION; j++) {
                weights[j] -= (learningRate * gradW[j]) / n;
            }
            bias -= (learningRate * gradB) / n;
        }
        const roundedWeights = weights.map((w) => Number(w.toFixed(5)));
        const roundedBias = Number(bias.toFixed(5));
        const modelContentStr = `samples:${samples.length}_w:${roundedWeights.join(',')}_b:${roundedBias}_loss:${finalLoss.toFixed(4)}_schema:2.0`;
        const modelHash = crypto
            .createHash('sha256')
            .update(modelContentStr)
            .digest('hex')
            .substring(0, 12);
        const modelVersion = `ml-v2-${modelHash}`;
        return {
            modelVersion,
            weights: roundedWeights,
            bias: roundedBias,
            featureSchemaVersion: '2.0',
            sampleCount: samples.length,
            trainLoss: Number(finalLoss.toFixed(4)),
            trainedAt: new Date(0),
        };
    }
    /**
     * Dedicated NO_TRADE model predicting probability of bad setup / failure.
     */
    static predictNoTrade(features, modelArtifact) {
        const smcScore = features.smcScore ?? 0.5;
        const mtfAlignment = features.mtfAlignment ?? 0.5;
        const volAtr = features.volatilityAtr ?? 0.5;
        // High risk when MTF is conflicted or volatility is extreme
        let riskLogit = 0.0;
        if (mtfAlignment < 0.4)
            riskLogit += 1.5;
        if (volAtr > 0.8)
            riskLogit += 1.2;
        if (smcScore < 0.6)
            riskLogit += 1.0;
        const rawProb = 1.0 / (1.0 + Math.exp(-riskLogit));
        const probabilityBadSetup = Number(rawProb.toFixed(3));
        const expectedLossR = Number((probabilityBadSetup * 1.0).toFixed(2));
        const confidence = Math.round(Math.abs(probabilityBadSetup - 0.5) * 200);
        let primaryRiskReason;
        if (mtfAlignment < 0.4)
            primaryRiskReason = 'Higher timeframe order flow conflict detected.';
        else if (volAtr > 0.8)
            primaryRiskReason = 'Extreme volatility shock percentile.';
        return {
            probabilityBadSetup,
            expectedLossR,
            confidence,
            primaryRiskReason,
        };
    }
}
exports.ModelTrainer = ModelTrainer;
//# sourceMappingURL=model-trainer.js.map