import * as crypto from 'crypto';
import {
  CANONICAL_FEATURE_NAMES_V2,
  CANONICAL_V2_DIMENSION,
  CanonicalTradeFeatureVectorV2,
} from '@quant/trading-engine';

export {
  CANONICAL_FEATURE_NAMES_V2,
  CANONICAL_V2_DIMENSION,
  CanonicalTradeFeatureVectorV2,
};
import { NoTradePrediction, TradingExperience, TrainingExample } from './types';
import { IDatasetSample } from './dataset-manager';
import { TemporalFeatureScaler } from './feature-scaler';

import { canonicalJsonStringify } from './canonical-serializer';

export interface IModelTrainingOptions {
  epochs?: number;
  learningRate?: number;
  l2Lambda?: number;
  scaler?: TemporalFeatureScaler;
  seed?: number;
  featureNames?: readonly string[] | string[];
  trainedAt?: Date;
}

export interface ITrainedModelArtifact {
  modelId?: string;
  modelVersion: string;
  modelHash: string;
  weights: number[];
  bias: number;
  featureSchemaVersion: string;
  featureSchemaHash: string;
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
   * Computes authoritative SHA-256 hash over exact model parameters and scaler linkage.
   */
  public static computeModelHash(
    weights: readonly number[],
    bias: number,
    scalerHash: string = 'none',
    modelVersion?: string,
  ): string {
    const payload = canonicalJsonStringify({
      weights: weights.map((w) => (Number.isFinite(w) ? Number(w.toFixed(8)) : 0)),
      bias: Number.isFinite(bias) ? Number(bias.toFixed(8)) : 0,
      scalerHash: scalerHash || 'none',
      ...(modelVersion ? { modelVersion } : {}),
    });
    return crypto.createHash('sha256').update(payload).digest('hex');
  }

  /**
   * Computes authoritative SHA-256 hash over exact feature schema names, ordering, and version.
   */
  public static computeFeatureSchemaHash(
    featureNames: readonly string[],
    schemaVersion: string = '2.0',
  ): string {
    const payload = canonicalJsonStringify({
      schemaVersion,
      featureNames: [...featureNames],
      dimension: featureNames.length,
    });
    return crypto.createHash('sha256').update(payload).digest('hex');
  }

  /**
   * Trains a logistic model on an EXPLICIT temporal training dataset slice
   * consuming the fitted TemporalFeatureScaler to ensure normalized, leakage-free feature scaling.
   */
  public static trainModel(
    trainingDataset: (TradingExperience | IDatasetSample | TrainingExample)[],
    optionsOrEpochs?: IModelTrainingOptions | number,
    learningRateParam = 0.05,
    l2LambdaParam = 0.01,
  ): ITrainedModelArtifact {
    const isOptionsObj = typeof optionsOrEpochs === 'object' && optionsOrEpochs !== null;
    const epochs = isOptionsObj ? (optionsOrEpochs.epochs ?? 50) : (optionsOrEpochs ?? 50);
    const learningRate = isOptionsObj ? (optionsOrEpochs.learningRate ?? 0.05) : learningRateParam;
    const l2Lambda = isOptionsObj ? (optionsOrEpochs.l2Lambda ?? 0.01) : l2LambdaParam;
    let scaler = isOptionsObj ? optionsOrEpochs.scaler : undefined;
    const targetFeatures: readonly string[] =
      isOptionsObj && optionsOrEpochs.featureNames && optionsOrEpochs.featureNames.length > 0
        ? optionsOrEpochs.featureNames
        : CANONICAL_FEATURE_NAMES_V2;

    if (!trainingDataset || trainingDataset.length === 0) {
      const defaultWeights = targetFeatures.map((_, i) =>
        Number((Math.sin(i + 1) * 0.1).toFixed(4)),
      );
      const defaultBias = 0.1;
      const emptyModelHash = ModelTrainer.computeModelHash(defaultWeights, defaultBias, 'none');
      const emptyFeatureSchemaHash = ModelTrainer.computeFeatureSchemaHash(targetFeatures, '2.0');
      const emptySelectedFeatureHash = crypto
        .createHash('sha256')
        .update(targetFeatures.join(','))
        .digest('hex');

      return {
        modelId: 'empty-model',
        modelVersion: 'v2.0-empty',
        modelHash: emptyModelHash,
        weights: defaultWeights,
        bias: defaultBias,
        featureSchemaVersion: '2.0',
        featureSchemaHash: emptyFeatureSchemaHash,
        selectedFeatures: [...targetFeatures],
        selectedFeatureHash: emptySelectedFeatureHash,
        scalerHash: 'none',
        trainingDatasetHash: 'none',
        strategyVersion: 'v2.0',
        sampleCount: 0,
        trainLoss: 0,
        trainedAt: isOptionsObj && optionsOrEpochs.trainedAt ? optionsOrEpochs.trainedAt : new Date(),
        scalerArtifact: {
          scalerVersion: '1.0.0',
          scalerHash: 'none',
          scalerParameters: {},
        },
      };
    }

    // Explicit scaler requirement (FAIL CLOSED if not supplied)
    if (!scaler) {
      throw new Error('MISSING_TRAIN_SCALER: ModelTrainer.trainModel requires an explicit fitted TemporalFeatureScaler');
    }

    const scalerParameters: Record<string, { mean: number; std: number; min: number; max: number }> = {};
    for (const name of targetFeatures) {
      const p = scaler.getParams(name);
      if (!p) {
        throw new Error(`MISSING_SCALER_PARAMETER: TemporalFeatureScaler lacks fitted parameters for feature '${name}'`);
      }
      scalerParameters[name] = p;
    }

    // Extract exact numeric feature vectors and binary labels strictly (FAIL CLOSED on missing/corrupt values)
    const samples: { features: number[]; label: number }[] = [];
    for (const exp of trainingDataset) {
      const feats = (exp as any).features || (exp as any).marketState?.quant;
      const featVector: number[] = [];

      if (Array.isArray(feats)) {
        let names: readonly string[];
        if ('featureNames' in exp && Array.isArray((exp as any).featureNames) && (exp as any).featureNames.length === feats.length) {
          names = (exp as any).featureNames;
        } else if ((exp as any).featureSchemaHash && feats.length === CANONICAL_FEATURE_NAMES_V2.length) {
          const computed = ModelTrainer.computeFeatureSchemaHash(CANONICAL_FEATURE_NAMES_V2, '2.0');
          if ((exp as any).featureSchemaHash === computed) {
            names = CANONICAL_FEATURE_NAMES_V2;
          } else {
            throw new Error(`MISSING_FEATURE_NAMES_PROVENANCE: Training experience array features lacks valid schema hash binding`);
          }
        } else {
          throw new Error(`MISSING_FEATURE_NAMES_PROVENANCE: Training experience array features lacks valid featureNames provenance`);
        }

        for (const name of targetFeatures) {
          const idx = names.indexOf(name);
          const rawVal = idx >= 0 ? feats[idx] : undefined;
          if (rawVal === undefined || rawVal === null || typeof rawVal !== 'number' || !Number.isFinite(rawVal)) {
            throw new Error(
              `MISSING_FEATURE_VALUE: Training experience lacks valid finite value for feature '${name}'`,
            );
          }
          const scaledVal = scaler.transformValue(name, rawVal);
          featVector.push(scaledVal);
        }
      } else if (feats && typeof feats === 'object') {
        for (const name of targetFeatures) {
          const rawVal = (feats as any)[name];
          if (rawVal === undefined || rawVal === null || typeof rawVal !== 'number' || !Number.isFinite(rawVal)) {
            throw new Error(
              `MISSING_FEATURE_VALUE: Training experience lacks valid finite value for feature '${name}'`,
            );
          }
          const scaledVal = scaler.transformValue(name, rawVal);
          featVector.push(scaledVal);
        }
      } else {
        throw new Error('MISSING_FEATURE_VALUE: Training experience is missing features object');
      }

      let label: number;
      if (typeof (exp as any).label === 'number' && ((exp as any).label === 0 || (exp as any).label === 1)) {
        label = (exp as any).label;
      } else if (
        typeof (exp as any).labelBinary === 'number' &&
        ((exp as any).labelBinary === 0 || (exp as any).labelBinary === 1)
      ) {
        label = (exp as any).labelBinary;
      } else {
        throw new Error(`TRAINING_LABEL_MISSING: Training sample is missing explicit binary label (must be 0 or 1)`);
      }

      samples.push({ features: featVector, label });
    }

    const dim = targetFeatures.length;
    const weights = new Array(dim).fill(0).map((_, i) => Number((Math.sin(i + 1) * 0.1).toFixed(4)));
    let bias = 0.1;

    // Gradient descent
    let finalLoss = 0;
    for (let epoch = 0; epoch < epochs; epoch++) {
      let totalLoss = 0;
      const gradW = new Array(dim).fill(0);
      let gradB = 0;

      for (const s of samples) {
        let z = bias;
        for (let j = 0; j < dim; j++) {
          z += weights[j] * s.features[j];
        }
        const prob = 1.0 / (1.0 + Math.exp(-Math.max(-20, Math.min(20, z))));
        const err = prob - s.label;

        const loss =
          -s.label * Math.log(Math.max(1e-7, prob)) -
          (1 - s.label) * Math.log(Math.max(1e-7, 1 - prob));
        totalLoss += loss;

        for (let j = 0; j < dim; j++) {
          gradW[j] += err * s.features[j] + l2Lambda * weights[j];
        }
        gradB += err;
      }

      const n = samples.length;
      finalLoss = totalLoss / n;

      for (let j = 0; j < dim; j++) {
        weights[j] -= (learningRate * gradW[j]) / n;
      }
      bias -= (learningRate * gradB) / n;
    }

    const roundedWeights = weights.map((w) => Number(w.toFixed(5)));
    const roundedBias = Number(bias.toFixed(5));

    const scalerHash = TemporalFeatureScaler.computeScalerHash(scalerParameters);
    const featureSchemaHash = ModelTrainer.computeFeatureSchemaHash(targetFeatures, '2.0');
    const selectedFeatureHash = crypto
      .createHash('sha256')
      .update(targetFeatures.join(','))
      .digest('hex');

    // Authoritative dataset hash computed directly from sample feature values and labels
    const samplePayload = samples
      .map((s, idx) => `${idx}:${s.features.map((f) => f.toFixed(6)).join(',')}:${s.label}`)
      .join('\n');
    const trainingDatasetHash = crypto.createHash('sha256').update(samplePayload).digest('hex');

    const fullModelHash = ModelTrainer.computeModelHash(roundedWeights, roundedBias, scalerHash);
    const modelHashShort = fullModelHash.substring(0, 12);
    const modelVersion = `ml-v2-${modelHashShort}`;

    return {
      modelId: `model-${modelHashShort}`,
      modelVersion,
      modelHash: fullModelHash,
      weights: roundedWeights,
      bias: roundedBias,
      featureSchemaVersion: '2.0',
      featureSchemaHash,
      selectedFeatures: [...targetFeatures],
      selectedFeatureHash,
      scalerHash,
      trainingDatasetHash,
      strategyVersion: 'v2.0',
      sampleCount: samples.length,
      trainLoss: Number(finalLoss.toFixed(4)),
      trainedAt: isOptionsObj && optionsOrEpochs.trainedAt ? optionsOrEpochs.trainedAt : new Date(),
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
    if (!features || typeof features !== 'object') {
      throw new Error('MISSING_FEATURE_VALUE: predictNoTrade requires valid features object');
    }

    const smcScore = features.smcScore;
    if (smcScore === undefined || smcScore === null || typeof smcScore !== 'number' || !Number.isFinite(smcScore)) {
      throw new Error("MISSING_FEATURE_VALUE: predictNoTrade requires explicit finite 'smcScore'");
    }

    const mtfAlignment = features.mtfAlignment;
    if (mtfAlignment === undefined || mtfAlignment === null || typeof mtfAlignment !== 'number' || !Number.isFinite(mtfAlignment)) {
      throw new Error("MISSING_FEATURE_VALUE: predictNoTrade requires explicit finite 'mtfAlignment'");
    }

    const volAtr = features.volatilityAtr;
    if (volAtr === undefined || volAtr === null || typeof volAtr !== 'number' || !Number.isFinite(volAtr)) {
      throw new Error("MISSING_FEATURE_VALUE: predictNoTrade requires explicit finite 'volatilityAtr'");
    }

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
