import {
  CANONICAL_FEATURE_NAMES_V2,
  CANONICAL_V2_DIMENSION,
  CanonicalTradeFeatureVectorV2,
} from '@quant/trading-engine';
import { NoTradePrediction, TradingExperience } from './types';

export interface ITrainedModelArtifact {
  modelVersion: string;
  weights: number[];
  bias: number;
  featureSchemaVersion: string;
  sampleCount: number;
  trainLoss: number;
  trainedAt: Date;
}

import { IDatasetSample } from './dataset-manager';

export class ModelTrainer {
  /**
   * Trains a canonical 28-dimensional logistic model on an EXPLICIT temporal training dataset slice.
   */
  public static trainModel(
    trainingDataset: (TradingExperience | IDatasetSample)[],
    epochs = 50,
    learningRate = 0.05,
    l2Lambda = 0.01,
  ): ITrainedModelArtifact {
    const weights = CANONICAL_FEATURE_NAMES_V2.map((_, i) =>
      Number((Math.sin(i + 1) * 0.1).toFixed(4)),
    );
    let bias = 0.1;

    if (!trainingDataset || trainingDataset.length === 0) {
      return {
        modelVersion: `ml-v2-${Date.now()}`,
        weights,
        bias,
        featureSchemaVersion: '2.0',
        sampleCount: 0,
        trainLoss: 0.693,
        trainedAt: new Date(),
      };
    }

    const samples: { features: number[]; label: number }[] = [];
    for (const exp of trainingDataset) {
      const featVector: number[] = [];
      const feats = 'features' in exp ? exp.features : exp.marketState?.quant;
      for (const name of CANONICAL_FEATURE_NAMES_V2) {
        const val = feats?.[name] ?? 0.5;
        featVector.push(typeof val === 'number' ? val : 0.5);
      }
      const label = 'labelBinary' in exp ? exp.labelBinary : (exp.outcome?.status === 'WIN' ? 1.0 : 0.0);
      samples.push({ features: featVector, label });
    }

    let finalLoss = 0.693;

    for (let epoch = 0; epoch < epochs; epoch++) {
      let totalLoss = 0;
      const gradW = new Array(CANONICAL_V2_DIMENSION).fill(0);
      let gradB = 0;

      for (const s of samples) {
        let z = bias;
        for (let j = 0; j < CANONICAL_V2_DIMENSION; j++) {
          z += weights[j] * (s.features[j] - 0.5);
        }

        const prob = 1.0 / (1.0 + Math.exp(-Math.max(-10, Math.min(10, z))));
        const err = prob - s.label;

        // Binary cross-entropy loss
        const loss =
          -s.label * Math.log(Math.max(1e-7, prob)) -
          (1 - s.label) * Math.log(Math.max(1e-7, 1 - prob));
        totalLoss += loss;

        for (let j = 0; j < CANONICAL_V2_DIMENSION; j++) {
          gradW[j] += err * (s.features[j] - 0.5) + l2Lambda * weights[j];
        }
        gradB += err;
      }

      const n = samples.length;
      finalLoss = totalLoss / n;

      for (let j = 0; j < CANONICAL_V2_DIMENSION; j++) {
        weights[j] -= (learningRate * gradW[j]) / n;
      }
      bias -= (learningRate * gradB) / n;
    }

    return {
      modelVersion: `ml-v2-${Date.now()}`,
      weights: weights.map((w) => Number(w.toFixed(5))),
      bias: Number(bias.toFixed(5)),
      featureSchemaVersion: '2.0',
      sampleCount: samples.length,
      trainLoss: Number(finalLoss.toFixed(4)),
      trainedAt: new Date(),
    };
  }

  /**
   * Dedicated NO_TRADE model predicting probability of bad setup / failure.
   */
  public static predictNoTrade(
    features: CanonicalTradeFeatureVectorV2,
    modelArtifact?: ITrainedModelArtifact,
  ): NoTradePrediction {
    const smcScore = features.smcScore ?? 0.5;
    const mtfAlignment = features.mtfAlignment ?? 0.5;
    const volAtr = features.volatilityAtr ?? 0.5;

    // High risk when MTF is conflicted or volatility is extreme
    let riskLogit = 0.0;
    if (mtfAlignment < 0.4) riskLogit += 1.5;
    if (volAtr > 0.8) riskLogit += 1.2;
    if (smcScore < 0.6) riskLogit += 1.0;

    const rawProb = 1.0 / (1.0 + Math.exp(-riskLogit));
    const probabilityBadSetup = Number(rawProb.toFixed(3));
    const expectedLossR = Number((probabilityBadSetup * 1.0).toFixed(2));
    const confidence = Math.round(Math.abs(probabilityBadSetup - 0.5) * 200);

    let primaryRiskReason: string | undefined;
    if (mtfAlignment < 0.4) primaryRiskReason = 'Higher timeframe order flow conflict detected.';
    else if (volAtr > 0.8) primaryRiskReason = 'Extreme volatility shock percentile.';

    return {
      probabilityBadSetup,
      expectedLossR,
      confidence,
      primaryRiskReason,
    };
  }
}
