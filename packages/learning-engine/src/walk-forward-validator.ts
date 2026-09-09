import { ICandle } from '@quant/shared';
import {
  CandidateMarketDataset,
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
import { MarketDatasetValidator } from './market-dataset-validator';

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
  candidateId: string;
  candidateVersion: string;
  strategyParameters: Record<string, any>;
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
  candles?: ICandle[];
  dataset?: CandidateMarketDataset;
  retrainFn?: (
    trainSlice: TradingExperience[],
    baseCandidate: StrategyCandidate,
    foldIndex: number,
  ) => StrategyCandidate;
}

export function sliceContinuousCandles(
  candles: ICandle[] | undefined,
  startTime: number,
  endTime: number,
  warmupBars: number = 40,
): ICandle[] | undefined {
  if (!candles || candles.length === 0) return undefined;
  const startIdx = candles.findIndex(
    (c) => (c.timestamp instanceof Date ? c.timestamp.getTime() : new Date(c.timestamp).getTime()) >= startTime,
  );
  if (startIdx === -1) {
    throw new Error('MARKET_DATA_WINDOW_NOT_FOUND');
  }
  const warmupStartIdx = Math.max(0, startIdx - warmupBars);
  const endIdx = candles.findIndex(
    (c) => (c.timestamp instanceof Date ? c.timestamp.getTime() : new Date(c.timestamp).getTime()) > endTime,
  );
  const slice = endIdx === -1 ? candles.slice(warmupStartIdx) : candles.slice(warmupStartIdx, endIdx);
  if (slice.length === 0) {
    throw new Error('EMPTY_MARKET_DATA_WINDOW');
  }
  MarketDatasetValidator.validateCandles(slice);
  return slice;
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

    const candles = options.candles;
    const hasContinuousCandles = Boolean(candles && candles.length >= Math.max(20, (numFolds + 2) * 5));

    const totalIntervals = hasContinuousCandles ? candles!.length : n;
    const foldIntervalSize = Math.floor(totalIntervals / (numFolds + 2)); // Divide into train, val, oos chunks
    const folds: WalkForwardFold[] = [];
    const foldArtifacts: FoldArtifact[] = [];

    let totalIS = 0;
    let totalOOS = 0;

    for (let f = 0; f < numFolds; f++) {
      let trainCandles: ICandle[] | undefined;
      let valCandles: ICandle[] | undefined;
      let testCandles: ICandle[] | undefined;

      let trainSlice: TradingExperience[];
      let valRaw: TradingExperience[];
      let testRaw: TradingExperience[];

      let trainRange: [Date, Date];
      let validateRange: [Date, Date];
      let testRange: [Date, Date];

      if (hasContinuousCandles) {
        // Continuous Market-Data-First Partitioning: Folds are defined by the continuous market dataset windows
        const trainStartIdx = 0;
        const trainEndIdx = (f + 1) * foldIntervalSize;
        const valStartIdx = trainEndIdx;
        const valEndIdx = Math.min(totalIntervals, valStartIdx + Math.max(1, Math.floor(foldIntervalSize / 2)));
        const testStartIdx = valEndIdx;
        const testEndIdx = Math.min(totalIntervals, testStartIdx + foldIntervalSize);

        const trainStartTs = new Date(candles![trainStartIdx].timestamp).getTime();
        const trainEndTs = new Date(candles![trainEndIdx - 1].timestamp).getTime();
        const valStartTs = new Date(candles![valStartIdx].timestamp).getTime();
        const valEndTs = new Date(candles![valEndIdx - 1].timestamp).getTime();
        const testStartTs = new Date(candles![testStartIdx].timestamp).getTime();
        const testEndTs = new Date(candles![testEndIdx - 1].timestamp).getTime();

        trainCandles = candles!.slice(0, trainEndIdx);
        MarketDatasetValidator.validateCandles(trainCandles);
        valCandles = sliceContinuousCandles(candles, valStartTs, valEndTs, 40);
        testCandles = sliceContinuousCandles(candles, testStartTs, testEndTs, 40);

        trainRange = [new Date(trainStartTs), new Date(trainEndTs)];
        validateRange = [new Date(valStartTs), new Date(valEndTs)];
        testRange = [new Date(testStartTs), new Date(testEndTs)];

        // Supervised labels / experiences within corresponding market windows
        trainSlice = sorted.filter((e) => {
          const t = new Date(e.timestamp).getTime();
          return t >= trainStartTs && t <= trainEndTs;
        });
        if (trainSlice.length === 0) {
          const fallbackExpEnd = Math.max(1, Math.floor((f + 1) * (n / (numFolds + 2))));
          trainSlice = sorted.slice(0, fallbackExpEnd);
        }

        valRaw = sorted.filter((e) => {
          const t = new Date(e.timestamp).getTime();
          return t >= valStartTs && t <= valEndTs;
        });

        testRaw = sorted.filter((e) => {
          const t = new Date(e.timestamp).getTime();
          return t >= testStartTs && t <= testEndTs;
        });
      } else {
        const trainStart = 0;
        const trainEnd = (f + 1) * foldIntervalSize;
        const valStart = trainEnd;
        const valEnd = Math.min(n, valStart + Math.max(1, Math.floor(foldIntervalSize / 2)));
        const testStart = valEnd;
        const testEnd = Math.min(n, testStart + foldIntervalSize);

        trainSlice = sorted.slice(trainStart, trainEnd);
        valRaw = sorted.slice(valStart, valEnd);
        testRaw = sorted.slice(testStart, testEnd);

        trainRange = [
          new Date(trainSlice[0]?.timestamp || 0),
          new Date(trainSlice[trainSlice.length - 1]?.timestamp || 0),
        ];
        validateRange = [
          new Date(valRaw[0]?.timestamp || trainRange[1]),
          new Date(valRaw[valRaw.length - 1]?.timestamp || trainRange[1]),
        ];
        testRange = [
          new Date(testRaw[0]?.timestamp || validateRange[1]),
          new Date(testRaw[testRaw.length - 1]?.timestamp || validateRange[1]),
        ];
      }

      if (trainSlice.length === 0 || (!hasContinuousCandles && testRaw.length === 0)) continue;

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

      if (!hasContinuousCandles) {
        const trainStartTime = new Date(trainSlice[0].timestamp).getTime();
        const trainEndTime = new Date(trainSlice[trainSlice.length - 1].timestamp).getTime();
        const valStartTime = valSlice.length > 0 ? new Date(valSlice[0].timestamp).getTime() : trainEndTime;
        const valEndTime = valSlice.length > 0 ? new Date(valSlice[valSlice.length - 1].timestamp).getTime() : valStartTime;
        const testStartTime = testSlice.length > 0 ? new Date(testSlice[0].timestamp).getTime() : valEndTime;
        const testEndTime = testSlice.length > 0 ? new Date(testSlice[testSlice.length - 1].timestamp).getTime() : testStartTime;

        trainCandles = sliceContinuousCandles(options.candles, trainStartTime, trainEndTime, 40);
        valCandles = sliceContinuousCandles(options.candles, valStartTime, valEndTime, 40);
        testCandles = sliceContinuousCandles(options.candles, testStartTime, testEndTime, 40);
      }

      // Retrain candidate strategy on fold using trained ML artifacts and fold-specific market data
      const foldCandidate = options.retrainFn
        ? options.retrainFn(trainSlice, candidate, f + 1)
        : this.retrainCandidateOnFold(trainCandles || options.candles, candidate, f + 1, modelArtifact, foldSelection.retainedFeatures, {
            dataset: options.dataset,
            candles: trainCandles || options.candles,
            trainSlice,
          });

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
        strategyVersion: candidate.baseStrategyVersion || 'v2.0',
        candidateId: candidate.id,
        candidateVersion: foldCandidate.candidateVersion || foldCandidate.id,
        strategyParameters: foldCandidate.change || {},
        candidateConfigHash,
        trainingSeed,
        createdAt: new Date(),
      });
      foldArtifacts.push(foldArtifact);

      // 1. Evaluate retrained candidate in-sample on training fold market data
      const isEval = CandidateEvaluator.evaluateCandidateOnMarketData(foldCandidate, {
        dataset: options.dataset,
        candles: trainCandles || options.candles,
      });
      // 2. Evaluate frozen retrained candidate on validation fold market data
      const valEval = CandidateEvaluator.evaluateCandidateOnMarketData(foldCandidate, {
        dataset: options.dataset,
        candles: valCandles || options.candles,
      });
      // 3. Evaluate frozen retrained candidate out-of-sample on OOS fold market data
      const oosEval = CandidateEvaluator.evaluateCandidateOnMarketData(foldCandidate, {
        dataset: options.dataset,
        candles: testCandles || options.candles,
      });

      const isExp = isEval.candidateExpectancy;
      const oosExp = oosEval.candidateExpectancy;
      const wins = testSlice.filter((e) => e.outcome?.status === 'WIN').length;
      const winRate =
        testSlice.length > 0 ? Number(((wins / testSlice.length) * 100).toFixed(1)) : 50;

      const passed = oosExp > 0 && oosEval.totalSimulatedTrades > 0;

      folds.push({
        foldIndex: f + 1,
        trainRange,
        validateRange,
        testRange,
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
   * Empirically fits candidate strategy parameters through grid search and execution evaluation strictly on training fold market data.
   */
  public static retrainCandidateOnFold(
    trainData: ICandle[] | TradingExperience[] | undefined,
    baseCandidate: StrategyCandidate,
    foldIndex: number,
    modelArtifact?: ITrainedModelArtifact,
    selectedFeatures?: string[],
    options?: {
      candles?: ICandle[];
      dataset?: CandidateMarketDataset;
      trainSlice?: TradingExperience[];
    },
  ): StrategyCandidate {
    const isCandleArray = Array.isArray(trainData) && trainData.length > 0 && 'open' in (trainData[0] as any);
    const marketCandles: ICandle[] | undefined = isCandleArray
      ? (trainData as ICandle[])
      : options?.candles;
    const trainSlice: TradingExperience[] = !isCandleArray && Array.isArray(trainData)
      ? (trainData as TradingExperience[])
      : options?.trainSlice || [];

    const paramName =
      (baseCandidate.change as any)?.parameter ||
      (baseCandidate.type === 'THRESHOLD'
        ? 'minMtfScore'
        : baseCandidate.type === 'RISK'
          ? 'stopLossAtrMultiplier'
          : (baseCandidate.type as any) === 'PROBABILITY'
            ? 'minProbability'
            : 'minMtfScore');

    // 1. Build search grid based on parameter type
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

    // 2. Search parameter grid and evaluate each value strictly on continuous training market data
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
        const evalRes = CandidateBacktestRunner.runCandidateBacktest(trialCandidate, {
          dataset: options?.dataset,
          candles: marketCandles,
        });
        if (evalRes.totalTrades > 0) {
          // Objective: Maximize trade expectancy penalized for low trade count
          const sampleCount = trainSlice.length > 0 ? trainSlice.length : (marketCandles?.length ?? 100);
          const samplePenalty = Math.min(1.0, evalRes.totalTrades / Math.max(1, Math.floor(sampleCount / 3)));
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
        fittedSampleCount: trainSlice.length > 0 ? trainSlice.length : (marketCandles?.length ?? 0),
        fittedValue: bestValue,
        fittedObjective: Number.isFinite(bestObjective) ? Number(bestObjective.toFixed(4)) : 0,
        modelArtifact: baseCandidate.type === 'MODEL' ? modelArtifact : baseCandidate.change?.modelArtifact,
        selectedFeatures,
      },
    };
  }
}
