import {
  StrategyCandidate,
  TradingExperience,
  WalkForwardFold,
  WalkForwardValidationResult,
} from './types';
import { CandidateEvaluator } from './candidate-evaluator';
import { DatasetManager } from './dataset-manager';
import { FeatureSelector } from './feature-selector';
import { TemporalFeatureScaler } from './feature-scaler';
import { ModelTrainer, ITrainedModelArtifact } from './model-trainer';
import { CandidateBacktestRunner } from './candidate-backtest-runner';

export interface FoldArtifact {
  foldIndex: number;
  trainDatasetHash: string;
  validationDatasetHash: string;
  oosDatasetHash: string;
  featureSchemaVersion: string;
  selectedFeatures: string[];
  scalerVersion: string;
  scalerParameters: Record<string, { mean: number; std: number; min: number; max: number }>;
  modelVersion: string;
  modelParameters: { weights: number[]; bias: number };
  strategyVersion: string;
  strategyParameters: Record<string, any>;
  candidateId: string;
  candidateConfigHash: string;
  trainingSeed: number;
  createdAt: Date;
}

export const DEFAULT_LEARNING_SEED = 42;

export interface IWalkForwardOptions {
  numFolds?: number;
  embargoDays?: number;
  embargoMs?: number;
  seed?: number;
  retrainFn?: (
    trainSlice: TradingExperience[],
    baseCandidate: StrategyCandidate,
    foldIndex: number,
  ) => StrategyCandidate;
}

export class WalkForwardValidator {
  /**
   * Performs chronological purged and embargoed walk-forward validation with genuine candidate retraining per fold.
   */
  public static validate(
    candidate: StrategyCandidate,
    experiences: TradingExperience[],
    options: IWalkForwardOptions = {},
  ): WalkForwardValidationResult & { foldArtifacts?: ReadonlyArray<FoldArtifact> } {
    const numFolds = options.numFolds || 3;
    const embargoMs = options.embargoMs ?? (options.embargoDays ? options.embargoDays * 24 * 3600 * 1000 : 0);
    if (embargoMs < 0) {
      throw new Error(`INVALID_EMBARGO_DURATION:${embargoMs}`);
    }

    for (const exp of experiences) {
      if (exp.labelStartTimestamp === undefined || exp.labelStartTimestamp === null) {
        throw new Error('MISSING_LABEL_START_TIMESTAMP');
      }
      if (exp.labelEndTimestamp === undefined || exp.labelEndTimestamp === null) {
        throw new Error('MISSING_LABEL_END_TIMESTAMP');
      }
    }

    const n = experiences.length;

    if (n < numFolds * 6) {
      return {
        folds: [],
        meanInSampleExpectancy: 0,
        meanOutOfSampleExpectancy: 0,
        oosDegradationPct: 0,
        isRobust: false,
      };
    }

    // Sort chronologically
    const sorted = [...experiences].sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
    );

    const foldSize = Math.floor(n / (numFolds + 2)); // Divide into train, val, oos chunks
    const folds: WalkForwardFold[] = [];
    const foldArtifacts: FoldArtifact[] = [];

    let totalIS = 0;
    let totalOOS = 0;

    for (let f = 0; f < numFolds; f++) {
      const trainStart = 0;
      const trainEnd = (f + 1) * foldSize;
      const valStart = trainEnd;
      const valEnd = Math.min(n, valStart + Math.max(1, Math.floor(foldSize / 2)));
      const testStart = valEnd;
      const testEnd = Math.min(n, testStart + foldSize);

      const trainSlice = sorted.slice(trainStart, trainEnd);
      const valRaw = sorted.slice(valStart, valEnd);
      const testRaw = sorted.slice(testStart, testEnd);

      if (trainSlice.length === 0 || testRaw.length === 0) continue;

      // Calculate label end timestamp purge boundary for training fold
      let trainMaxLabelEnd = 0;
      for (const e of trainSlice) {
        if (e.labelEndTimestamp === undefined || e.labelEndTimestamp === null) {
          throw new Error('MISSING_LABEL_END_TIMESTAMP');
        }
        const endTs = e.labelEndTimestamp;
        if (endTs > trainMaxLabelEnd) trainMaxLabelEnd = endTs;
      }

      // Purge validation samples whose entry timestamp overlaps with active training labels + embargoMs
      const valPurged = valRaw.filter((e) => new Date(e.timestamp).getTime() > trainMaxLabelEnd + embargoMs);
      if (valPurged.length === 0 && valRaw.length > 0) {
        throw new Error('INSUFFICIENT_PURGED_VALIDATION_DATA');
      }
      const valSlice = valPurged;

      // Calculate label end timestamp purge boundary for validation fold
      let valMaxLabelEnd = trainMaxLabelEnd;
      for (const e of valSlice) {
        if (e.labelEndTimestamp === undefined || e.labelEndTimestamp === null) {
          throw new Error('MISSING_LABEL_END_TIMESTAMP');
        }
        const endTs = e.labelEndTimestamp;
        if (endTs > valMaxLabelEnd) valMaxLabelEnd = endTs;
      }

      // Purge OOS samples whose entry timestamp overlaps with active validation labels + embargoMs
      const testPurged = testRaw.filter((e) => new Date(e.timestamp).getTime() > valMaxLabelEnd + embargoMs);
      if (testPurged.length === 0 && testRaw.length > 0) {
        throw new Error('INSUFFICIENT_PURGED_OOS_DATA');
      }
      const testSlice = testPurged;

      // Genuine ML fold retraining: feature selection, scaler fit, and model training on fold
      const foldSelection = FeatureSelector.selectFeatures(trainSlice);
      const scaler = new TemporalFeatureScaler();
      scaler.fit(trainSlice);
      const scalerParams: Record<string, { mean: number; std: number; min: number; max: number }> = {};
      for (const feat of foldSelection.retainedFeatures) {
        const stats = scaler.getParams(feat);
        if (stats) {
          scalerParams[feat] = { mean: stats.mean, std: stats.std, min: stats.min, max: stats.max };
        }
      }
      const modelArtifact = ModelTrainer.trainModel(trainSlice, { scaler });

      const trainDatasetHash = DatasetManager.computeCanonicalDatasetHash(trainSlice);
      const valDatasetHash = DatasetManager.computeCanonicalDatasetHash(valSlice);
      const oosDatasetHash = DatasetManager.computeCanonicalDatasetHash(testSlice);

      // Retrain candidate strategy on fold using trained ML artifacts
      const foldCandidate = options.retrainFn
        ? options.retrainFn(trainSlice, candidate, f + 1)
        : this.retrainCandidateOnFold(trainSlice, candidate, f + 1, modelArtifact, foldSelection.retainedFeatures);

      const candidateConfigHash = CandidateBacktestRunner.createExecutionConfig(foldCandidate).configHash;
      const scalerVersion = TemporalFeatureScaler.computeVersion(scalerParams);
      const trainingSeed = options.seed ?? DEFAULT_LEARNING_SEED;

      // Create and freeze immutable, real FoldArtifact
      const foldArtifact: FoldArtifact = Object.freeze({
        foldIndex: f + 1,
        trainDatasetHash,
        validationDatasetHash: valDatasetHash,
        oosDatasetHash,
        featureSchemaVersion: modelArtifact.featureSchemaVersion || '2.0',
        selectedFeatures: foldSelection.retainedFeatures,
        scalerVersion,
        scalerParameters: scalerParams,
        modelVersion: modelArtifact.modelVersion,
        modelParameters: { weights: modelArtifact.weights, bias: modelArtifact.bias },
        strategyVersion: foldCandidate.candidateVersion || foldCandidate.id,
        strategyParameters: foldCandidate.change || {},
        candidateId: candidate.id,
        candidateConfigHash,
        trainingSeed,
        createdAt: new Date(),
      });
      foldArtifacts.push(foldArtifact);

      // 1. Evaluate retrained candidate in-sample on training fold
      const isEval = CandidateEvaluator.evaluate(foldCandidate, trainSlice);
      // 2. Evaluate frozen retrained candidate on validation fold
      const valEval = CandidateEvaluator.evaluate(foldCandidate, valSlice);
      // 3. Evaluate frozen retrained candidate out-of-sample on OOS fold
      const oosEval = CandidateEvaluator.evaluate(foldCandidate, testSlice);

      const isExp = isEval.candidateExpectancy;
      const oosExp = oosEval.candidateExpectancy;
      const wins = testSlice.filter((e) => e.outcome?.status === 'WIN').length;
      const winRate =
        testSlice.length > 0 ? Number(((wins / testSlice.length) * 100).toFixed(1)) : 50;

      const passed = oosExp > 0 && oosEval.totalSimulatedTrades > 0;

      folds.push({
        foldIndex: f + 1,
        trainRange: [
          new Date(trainSlice[0].timestamp),
          new Date(trainSlice[trainSlice.length - 1].timestamp),
        ],
        validateRange: [
          new Date(valSlice[0]?.timestamp || trainSlice[0].timestamp),
          new Date(valSlice[valSlice.length - 1]?.timestamp || trainSlice[trainSlice.length - 1].timestamp),
        ],
        testRange: [
          new Date(testSlice[0].timestamp),
          new Date(testSlice[testSlice.length - 1].timestamp),
        ],
        inSampleExpectancy: isExp,
        outOfSampleExpectancy: oosExp,
        winRate,
        passed,
      });

      totalIS += isExp;
      totalOOS += oosExp;
    }

    const effectiveFolds = folds.length || 1;
    const meanIS = Number((totalIS / effectiveFolds).toFixed(2));
    const meanOOS = Number((totalOOS / effectiveFolds).toFixed(2));
    const degradation = meanIS > 0 ? Number((((meanIS - meanOOS) / meanIS) * 100).toFixed(1)) : 0;
    const isRobust =
      meanOOS > 0.05 && folds.filter((f) => f.passed).length >= Math.ceil(effectiveFolds * 0.65);

    return {
      folds,
      meanInSampleExpectancy: meanIS,
      meanOutOfSampleExpectancy: meanOOS,
      oosDegradationPct: Math.max(0, degradation),
      isRobust,
      foldArtifacts: Object.freeze(foldArtifacts),
    };
  }

  /**
   * Empirically fits candidate strategy parameters through grid search and execution evaluation strictly on training fold data.
   */
  private static retrainCandidateOnFold(
    trainSlice: TradingExperience[],
    baseCandidate: StrategyCandidate,
    foldIndex: number,
    modelArtifact?: ITrainedModelArtifact,
    selectedFeatures?: string[],
  ): StrategyCandidate {
    const paramName =
      (baseCandidate.change as any)?.parameter ||
      (baseCandidate.type === 'THRESHOLD'
        ? 'minMtfScore'
        : baseCandidate.type === 'RISK'
          ? 'stopLossAtrMultiplier'
          : (baseCandidate.type as any) === 'PROBABILITY'
            ? 'minProbability'
            : 'minMtfScore');

    // 1. Build search grid based on parameter type and training data
    let grid: number[] = [];

    if (paramName === 'minMtfScore') {
      const distinctScores = Array.from(
        new Set(
          trainSlice
            .map((e) => e.decision?.score)
            .filter((s): s is number => typeof s === 'number' && Number.isFinite(s)),
        ),
      );
      grid = Array.from(new Set([...distinctScores, 50, 55, 60, 65, 70, 75, 80])).sort((a, b) => a - b);
    } else if (paramName === 'stopLossAtrMultiplier') {
      grid = [0.75, 1.0, 1.25, 1.5, 1.75, 2.0];
    } else if (paramName === 'sizingMultiplier' || paramName === 'highVolatilitySizingMultiplier') {
      grid = [0.25, 0.5, 0.75, 1.0, 1.25];
    } else if (paramName === 'minProbability') {
      grid = [0.45, 0.50, 0.55, 0.60, 0.65, 0.70];
    } else if (typeof (baseCandidate.change as any)?.value === 'number') {
      const v = (baseCandidate.change as any).value;
      grid = [Number((v * 0.75).toFixed(2)), Number((v * 0.9).toFixed(2)), v, Number((v * 1.1).toFixed(2)), Number((v * 1.25).toFixed(2))];
    } else {
      grid = [55, 60, 65, 70, 75];
    }

    // 2. Search parameter grid and evaluate each value on training fold
    let bestValue =
      typeof (baseCandidate.change as any)?.value === 'number'
        ? (baseCandidate.change as any).value
        : grid[Math.floor(grid.length / 2)];
    let bestObjective = -Infinity;

    for (const val of grid) {
      const trialCandidate: StrategyCandidate = {
        ...baseCandidate,
        candidateVersion: `${baseCandidate.candidateVersion || baseCandidate.id}-trial-${val}`,
        change: {
          ...baseCandidate.change,
          parameter: paramName,
          value: val,
          fittedValue: val,
          modelArtifact: baseCandidate.type === 'MODEL' ? modelArtifact : baseCandidate.change?.modelArtifact,
          selectedFeatures,
        },
      };

      try {
        const evalRes = CandidateBacktestRunner.runCandidateBacktest(trialCandidate, trainSlice);
        if (evalRes.totalTrades > 0) {
          // Objective: Maximize trade expectancy penalized for low sample count
          const samplePenalty = Math.min(1.0, evalRes.totalTrades / Math.max(1, Math.floor(trainSlice.length / 3)));
          const objective = evalRes.expectancyR * samplePenalty + (evalRes.profitFactor >= 1.25 ? 0.2 : 0.0);
          if (objective > bestObjective) {
            bestObjective = objective;
            bestValue = val;
          }
        }
      } catch {
        // Continue search if trial evaluation fails
      }
    }

    return {
      ...baseCandidate,
      candidateVersion: `${baseCandidate.candidateVersion || baseCandidate.id}-fold${foldIndex}`,
      change: {
        ...baseCandidate.change,
        fittedOnFold: foldIndex,
        fittedSampleCount: trainSlice.length,
        fittedValue: bestValue,
        fittedObjective: Number.isFinite(bestObjective) ? Number(bestObjective.toFixed(4)) : 0,
        modelArtifact: baseCandidate.type === 'MODEL' ? modelArtifact : baseCandidate.change?.modelArtifact,
        selectedFeatures,
      },
    };
  }
}
