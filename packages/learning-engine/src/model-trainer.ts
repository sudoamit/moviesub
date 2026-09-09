import * as crypto from 'crypto';
import {
  CANONICAL_FEATURE_NAMES_V2,
  CANONICAL_V2_DIMENSION,
  CanonicalTradeFeatureVectorV2,
} from '@quant/trading-engine';
import { NoTradePrediction, TradingExperience } from './types';
import { IDatasetSample } from './dataset-manager';
import { TemporalFeatureScaler } from './feature-scaler';

export interface IModelTrainingOptions {
  epochs?: number;
  learningRate?: number;
  l2Lambda?: number;
  scaler?: TemporalFeatureScaler;
  seed?: number;
}

export interface ITrainedModelArtifact {
  modelVersion: string;
  modelHash?: string;
  weights: number[];
  bias: number;
  featureSchemaVersion: string;
  featureSchemaHash?: string;
  selectedFeatures?: string[];
  selectedFeatureHash?: string;
  scalerHash?: string;
  trainingDatasetHash?: string;
  strategyVersion?: string;
  sampleCount: number;
  trainLoss: number;
  trainedAt: Date;
  scalerArtifact?: {
    scalerVersion: string;
    scalerHash?: string;
    scalerParameters: Record<string, { mean: number; std: number; min: number; max: number }>;
  };
}

export class ModelTrainer {
  /**
   * Trains a canonical 28-dimensional logistic model on an EXPLICIT temporal training dataset slice
   * consuming the fitted TemporalFeatureScaler to ensure normalized, leakage-free feature scaling.
   */
  public static trainModel(
    trainingDataset: (TradingExperience | IDatasetSample)[],
    optionsOrEpochs?: IModelTrainingOptions | number,
    learningRateParam = 0.05,
    l2LambdaParam = 0.01,
  ): ITrainedModelArtifact {
    const isOptionsObj = typeof optionsOrEpochs === 'object' && optionsOrEpochs !== null;
    const epochs = isOptionsObj ? (optionsOrEpochs.epochs ?? 50) : (optionsOrEpochs ?? 50);
    const learningRate = isOptionsObj ? (optionsOrEpochs.learningRate ?? 0.05) : learningRateParam;
    const l2Lambda = isOptionsObj ? (optionsOrEpochs.l2Lambda ?? 0.01) : l2LambdaParam;
    let scaler = isOptionsObj ? optionsOrEpochs.scaler : undefined;

    if (!trainingDataset || trainingDataset.length === 0) {
      const defaultWeights = CANONICAL_FEATURE_NAMES_V2.map((_, i) =>
        Number((Math.sin(i + 1) * 0.1).toFixed(4)),
      );
      return {
        modelVersion: 'ml-v2-empty',
        weights: defaultWeights,
        bias: 0.1,
        featureSchemaVersion: '2.0',
        sampleCount: 0,
        trainLoss: 0.693,
        trainedAt: new Date(0),
      };
    }

    // If no scaler provided, fit a temporal feature scaler on the training dataset
    if (!scaler) {
      scaler = new TemporalFeatureScaler();
      scaler.fit(trainingDataset);
    }

    const scalerParameters: Record<string, { mean: number; std: number; min: number; max: number }> = {};
    for (const name of CANONICAL_FEATURE_NAMES_V2) {
      const stats = scaler.getParams(name);
      if (stats) {
        scalerParameters[name] = { mean: stats.mean, std: stats.std, min: stats.min, max: stats.max };
      }
    }

    // Xavier / Glorot initialization for canonical dimension
    const scale = 1.0 / Math.sqrt(CANONICAL_V2_DIMENSION);
    const weights = CANONICAL_FEATURE_NAMES_V2.map((_, i) => {
      const r = Math.sin((i + 1) * 997) * 10000;
      const frac = r - Math.floor(r);
      return Number(((frac - 0.5) * 2 * scale).toFixed(5));
    });
    let bias = 0.0;

    // Transform training samples using the fitted scaler
    const samples: { features: number[]; label: number }[] = [];
    for (const exp of trainingDataset) {
      const featVector: number[] = [];
      const feats = 'features' in exp ? exp.features : exp.marketState?.quant;
      for (const name of CANONICAL_FEATURE_NAMES_V2) {
        const rawVal = feats?.[name] ?? 0.5;
        const numVal = typeof rawVal === 'number' ? rawVal : 0.5;
        const scaledVal = scaler ? scaler.transformValue(name, numVal) : numVal - 0.5;
        featVector.push(scaledVal);
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
          z += weights[j] * s.features[j];
        }

        const prob = 1.0 / (1.0 + Math.exp(-Math.max(-10, Math.min(10, z))));
        const err = prob - s.label;

        // Binary cross-entropy loss
        const loss =
          -s.label * Math.log(Math.max(1e-7, prob)) -
          (1 - s.label) * Math.log(Math.max(1e-7, 1 - prob));
        totalLoss += loss;

        for (let j = 0; j < CANONICAL_V2_DIMENSION; j++) {
          gradW[j] += err * s.features[j] + l2Lambda * weights[j];
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

    const roundedWeights = weights.map((w) => Number(w.toFixed(5)));
    const roundedBias = Number(bias.toFixed(5));

    const scalerHash = TemporalFeatureScaler.computeScalerHash(scalerParameters);
    const featureSchemaHash = crypto
      .createHash('sha256')
      .update('canonical_schema_v2.0_' + CANONICAL_FEATURE_NAMES_V2.join(','))
      .digest('hex');
    const selectedFeatureHash = crypto
      .createHash('sha256')
      .update(CANONICAL_FEATURE_NAMES_V2.join(','))
      .digest('hex');
    const trainingDatasetHash = crypto
      .createHash('sha256')
      .update(`dataset_${samples.length}_${samples[0]?.label ?? 0}`)
      .digest('hex');

    const modelContentStr = `samples:${samples.length}_w:${roundedWeights.join(',')}_b:${roundedBias}_loss:${finalLoss.toFixed(4)}_schema:2.0_scaler:${scalerHash}`;
    const fullModelHash = crypto.createHash('sha256').update(modelContentStr).digest('hex');
    const modelHashShort = fullModelHash.substring(0, 12);
    const modelVersion = `ml-v2-${modelHashShort}`;

    return {
      modelVersion,
      modelHash: fullModelHash,
      weights: roundedWeights,
      bias: roundedBias,
      featureSchemaVersion: '2.0',
      featureSchemaHash,
      selectedFeatures: [...CANONICAL_FEATURE_NAMES_V2],
      selectedFeatureHash,
      scalerHash,
      trainingDatasetHash,
      strategyVersion: 'v2.0',
      sampleCount: samples.length,
      trainLoss: Number(finalLoss.toFixed(4)),
      trainedAt: new Date(0),
      scalerArtifact: {
        scalerVersion: TemporalFeatureScaler.computeVersion(scalerParameters),
        scalerHash,
        scalerParameters,
      },
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
