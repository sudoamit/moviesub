import * as crypto from 'crypto';
import {
  CandidateHypothesis,
  DiscoveredPattern,
  FeatureSelectionResult,
  IErrorReport,
  StrategyCandidateType,
  TrainingDataset,
} from './types';
import { canonicalJsonStringify } from './canonical-serializer';

export interface HypothesisGeneratorLimits {
  readonly maxCandidates: number;
  readonly maxTrainingRuns: number;
  readonly maxFeatureCombinations: number;
  readonly maxHyperparameterCombinations: number;
}

export interface CandidateHypothesisGeneratorInputs {
  readonly baseStrategyVersion: string;
  readonly trainingDataset: TrainingDataset;
  readonly limits: HypothesisGeneratorLimits;
  readonly featureSelection?: FeatureSelectionResult;
  readonly errorReport?: IErrorReport;
  readonly patterns?: readonly DiscoveredPattern[];
}

export class CandidateHypothesisGenerator {
  /**
   * Computes canonical deterministic SHA-256 hash for a candidate hypothesis.
   */
  public static computeHypothesisHash(hypothesis: Omit<CandidateHypothesis, 'hypothesisId' | 'hypothesisHash' | 'candidateId' | 'candidateVersion'>): string {
    const payload = {
      baseStrategyVersion: hypothesis.baseStrategyVersion,
      type: hypothesis.type,
      description: hypothesis.description,
      parameterChanges: hypothesis.parameterChanges,
      selectedFeatures: hypothesis.selectedFeatures ? [...hypothesis.selectedFeatures].sort() : undefined,
      modelType: hypothesis.modelType,
      modelHyperparameters: hypothesis.modelHyperparameters,
      regimeFilters: hypothesis.regimeFilters ? [...hypothesis.regimeFilters].sort() : undefined,
      entryFilters: hypothesis.entryFilters,
      exitOverrides: hypothesis.exitOverrides,
      sourceTrainWindow: hypothesis.sourceTrainWindow,
    };
    return crypto.createHash('sha256').update(canonicalJsonStringify(payload)).digest('hex').substring(0, 16);
  }

  /**
   * Systematically generates bounded, deduplicated candidate hypotheses strictly from TRAIN data.
   */
  public static generateHypotheses(inputs: CandidateHypothesisGeneratorInputs): CandidateHypothesis[] {
    const limits = inputs.limits;
    if (!limits || typeof limits !== 'object') {
      throw new Error('MISSING_GENERATOR_LIMITS: Candidate hypothesis generator requires explicit limits');
    }
    if (typeof limits.maxCandidates !== 'number' || !Number.isFinite(limits.maxCandidates) || limits.maxCandidates <= 0) {
      throw new Error('INVALID_MAX_CANDIDATES: maxCandidates must be a positive finite integer');
    }
    if (typeof limits.maxTrainingRuns !== 'number' || !Number.isFinite(limits.maxTrainingRuns) || limits.maxTrainingRuns <= 0) {
      throw new Error('INVALID_MAX_TRAINING_RUNS: maxTrainingRuns must be a positive finite integer');
    }
    if (typeof limits.maxFeatureCombinations !== 'number' || !Number.isFinite(limits.maxFeatureCombinations) || limits.maxFeatureCombinations <= 0) {
      throw new Error('INVALID_MAX_FEATURE_COMBINATIONS: maxFeatureCombinations must be a positive finite integer');
    }
    if (typeof limits.maxHyperparameterCombinations !== 'number' || !Number.isFinite(limits.maxHyperparameterCombinations) || limits.maxHyperparameterCombinations <= 0) {
      throw new Error('INVALID_MAX_HYPERPARAMETER_COMBINATIONS: maxHyperparameterCombinations must be a positive finite integer');
    }

    const baseVersion = inputs.baseStrategyVersion || 'v2.0';
    const trainDs = inputs.trainingDataset;
    const trainWindow = {
      startTimestamp: trainDs.startTimestamp,
      endTimestamp: trainDs.endTimestamp,
      trainingDatasetHash: trainDs.datasetHash,
    };

    const hypotheses: CandidateHypothesis[] = [];
    const seenHashes = new Set<string>();

    const addHypothesis = (
      type: StrategyCandidateType,
      description: string,
      parameterChanges: Record<string, unknown>,
      options: {
        selectedFeatures?: readonly string[] | string[];
        modelType?: 'LOGISTIC_V2' | 'GBM' | 'LINEAR';
        modelHyperparameters?: Record<string, unknown>;
        regimeFilters?: readonly string[] | string[];
        entryFilters?: Record<string, unknown>;
        exitOverrides?: Record<string, unknown>;
      } = {},
    ): boolean => {
      if (hypotheses.length >= limits.maxCandidates) {
        return false;
      }

      const rawHypothesis = {
        baseStrategyVersion: baseVersion,
        type,
        description,
        parameterChanges: Object.freeze(parameterChanges),
        selectedFeatures: options.selectedFeatures ? Object.freeze([...options.selectedFeatures].sort()) : undefined,
        modelType: options.modelType,
        modelHyperparameters: options.modelHyperparameters ? Object.freeze(options.modelHyperparameters) : undefined,
        regimeFilters: options.regimeFilters ? Object.freeze([...options.regimeFilters].sort()) : undefined,
        entryFilters: options.entryFilters ? Object.freeze(options.entryFilters) : undefined,
        exitOverrides: options.exitOverrides ? Object.freeze(options.exitOverrides) : undefined,
        sourceTrainWindow: trainWindow,
      };

      const hypHash = this.computeHypothesisHash(rawHypothesis);
      if (seenHashes.has(hypHash)) {
        return false; // Skip duplicate hypothesis
      }
      seenHashes.add(hypHash);

      const candidateId = `cand_hyp_${hypHash}`;
      const candidateVersion = `${baseVersion}-hyp-${hypHash.substring(0, 8)}`;

      hypotheses.push(
        Object.freeze({
          hypothesisId: `hyp_${hypHash}`,
          hypothesisHash: hypHash,
          candidateId,
          candidateVersion,
          ...rawHypothesis,
        }),
      );
      return true;
    };

    // 1. Model & Regularization Hypotheses
    const l2Values = [0.001, 0.01, 0.05, 0.1].slice(0, limits.maxHyperparameterCombinations);
    const lrValues = [0.01, 0.05].slice(0, limits.maxHyperparameterCombinations);
    const selectedFeats = inputs.featureSelection?.retainedFeatures ?? trainDs.featureNames;

    for (const l2 of l2Values) {
      for (const lr of lrValues) {
        addHypothesis(
          'MODEL',
          `Canonical ML logistic model with L2 regularization ${l2} and learning rate ${lr}`,
          { l2Lambda: l2, learningRate: lr },
          {
            modelType: 'LOGISTIC_V2',
            modelHyperparameters: { l2Lambda: l2, learningRate: lr, epochs: 50 },
            selectedFeatures: selectedFeats,
          },
        );
      }
    }

    // 2. Feature Subset Hypotheses (Train-Only)
    if (inputs.featureSelection && inputs.featureSelection.retainedFeatures.length > 0) {
      addHypothesis(
        'FEATURE',
        `Feature pruned subset containing ${inputs.featureSelection.retainedFeatures.length} optimized features`,
        { featurePruningEnabled: true, featureCount: inputs.featureSelection.retainedFeatures.length },
        {
          selectedFeatures: inputs.featureSelection.retainedFeatures,
          modelType: 'LOGISTIC_V2',
        },
      );
    }

    // 3. Negative Pattern & Error Driver Filter Hypotheses
    if (inputs.patterns) {
      const negativePatterns = inputs.patterns.filter((p) => p.type === 'NEGATIVE_FILTER');
      for (const pat of negativePatterns) {
        addHypothesis(
          'FILTER',
          `Reject loss-inducing pattern: [${pat.conditions.join(' AND ')}]`,
          {
            action: 'ADD_FILTER_RULE',
            conditionRules: pat.conditions,
            rejectWhenMatched: true,
            minMtfScore: 0,
          },
          {
            entryFilters: { conditions: pat.conditions, rejectWhenMatched: true },
          },
        );
      }
    }

    if (inputs.errorReport && inputs.errorReport.topLossDrivers) {
      for (const driver of inputs.errorReport.topLossDrivers) {
        if (driver.failureMode === 'HTF_CONFLICT') {
          addHypothesis(
            'FILTER',
            'Enforce high Multi-Timeframe score threshold (>= 12)',
            { parameter: 'minMtfScore', value: 12, minMtfScore: 12 },
            { entryFilters: { minMtfScore: 12 } },
          );
        } else if (driver.failureMode === 'VOLATILITY_MISREAD') {
          addHypothesis(
            'VOLATILITY',
            'Scale down position size during HIGH_VOLATILITY shocks by 50%',
            { parameter: 'highVolatilitySizingMultiplier', value: 0.5, minMtfScore: 0 },
            { regimeFilters: ['HIGH_VOLATILITY'] },
          );
        } else if (driver.failureMode === 'STOP_TOO_TIGHT') {
          addHypothesis(
            'EXIT',
            'Expand minimum structural stop buffer by 1.25x ATR',
            { parameter: 'stopLossAtrMultiplier', value: 1.25, minMtfScore: 0 },
            { exitOverrides: { stopLossAtrMultiplier: 1.25 } },
          );
        }
      }
    }

    // 4. Threshold Calibration Hypotheses
    const mtfThresholds = [10, 12, 14];
    for (const mtf of mtfThresholds) {
      addHypothesis(
        'THRESHOLD',
        `SMC multi-timeframe confirmation threshold tuned to ${mtf}`,
        { parameter: 'minMtfScore', value: mtf, minMtfScore: mtf },
        { entryFilters: { minMtfScore: mtf } },
      );
    }

    return hypotheses;
  }
}
