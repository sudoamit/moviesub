import { ICandle } from '@quant/shared';
import {
  CandidateMarketDataset,
  ExperienceDataset,
  FoldArtifact,
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

export { FoldArtifact };

export interface MarketExecutionWindow {
  warmupCandles: ICandle[];
  evaluationCandles: ICandle[];
  allCandles: ICandle[];
  warmupStartTimestamp: number;
  evaluationStartTimestamp: number;
  evaluationEndTimestamp: number;
}

export interface MarketFoldWindow {
  foldIndex: number;
  train: MarketExecutionWindow;
  validation: MarketExecutionWindow;
  oos: MarketExecutionWindow;
}

export const DEFAULT_LEARNING_SEED = 42;

export interface IWalkForwardOptions {
  experienceDataset: ExperienceDataset;
  marketDataset: CandidateMarketDataset;
  numFolds?: number;
  embargoDays?: number;
  embargoMs?: number;
  seed?: number;
  minFoldSize?: number;
  warmupBars?: number;
  trainModelOnExperienceDataset?: (experienceDataset: ExperienceDataset, foldIndex: number) => Promise<ITrainedModelArtifact> | ITrainedModelArtifact;
  fitCandidateParametersOnMarketDataset?: (candidate: StrategyCandidate, marketDataset: CandidateMarketDataset, foldIndex: number) => StrategyCandidate;
}

export function sliceContinuousMarketWindow(
  candles: ICandle[] | undefined,
  startTime: number,
  endTime: number,
  warmupBars: number = 40,
): MarketExecutionWindow {
  if (!candles || candles.length === 0) {
    throw new Error('MARKET_DATA_WINDOW_NOT_FOUND: No candles provided for market window slicing');
  }
  if (!Number.isInteger(warmupBars) || warmupBars < 0) {
    throw new Error(`INVALID_WARMUP_BARS:${warmupBars}`);
  }
  const firstTs = candles[0].timestamp instanceof Date ? candles[0].timestamp.getTime() : new Date(candles[0].timestamp).getTime();
  const lastTs = candles[candles.length - 1].timestamp instanceof Date ? candles[candles.length - 1].timestamp.getTime() : new Date(candles[candles.length - 1].timestamp).getTime();
  if (endTime < firstTs || startTime > lastTs) {
    throw new Error('MARKET_DATA_WINDOW_NOT_FOUND: Requested window falls completely outside available market candle timestamps');
  }

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
  const evaluationCandles = endIdx === -1 ? candles.slice(startIdx) : candles.slice(startIdx, endIdx);
  const warmupCandles = candles.slice(warmupStartIdx, startIdx);
  const allCandles = endIdx === -1 ? candles.slice(warmupStartIdx) : candles.slice(warmupStartIdx, endIdx);

  if (allCandles.length === 0 || evaluationCandles.length === 0) {
    throw new Error('EMPTY_MARKET_DATA_WINDOW');
  }

  const warmupStartTimestamp =
    warmupCandles.length > 0
      ? (warmupCandles[0].timestamp instanceof Date ? warmupCandles[0].timestamp.getTime() : new Date(warmupCandles[0].timestamp).getTime())
      : (evaluationCandles[0].timestamp instanceof Date ? evaluationCandles[0].timestamp.getTime() : new Date(evaluationCandles[0].timestamp).getTime());
  const evaluationStartTimestamp = evaluationCandles[0].timestamp instanceof Date ? evaluationCandles[0].timestamp.getTime() : new Date(evaluationCandles[0].timestamp).getTime();
  const evaluationEndTimestamp = evaluationCandles[evaluationCandles.length - 1].timestamp instanceof Date ? evaluationCandles[evaluationCandles.length - 1].timestamp.getTime() : new Date(evaluationCandles[evaluationCandles.length - 1].timestamp).getTime();

  return {
    warmupCandles,
    evaluationCandles,
    allCandles,
    warmupStartTimestamp,
    evaluationStartTimestamp,
    evaluationEndTimestamp,
  };
}

export function sliceContinuousCandles(
  candles: ICandle[] | undefined,
  startTime: number,
  endTime: number,
  warmupBars: number = 40,
): ICandle[] | undefined {
  if (!candles || candles.length === 0) return undefined;
  const window = sliceContinuousMarketWindow(candles, startTime, endTime, warmupBars);
  return window?.allCandles;
}

export class WalkForwardValidator {
  /**
   * Performs walk-forward validation with strict cryptographic dataset boundaries,
   * purged temporal cross-validation, and execution on continuous market datasets.
   */
  public static validate(
    candidate: StrategyCandidate,
    options: IWalkForwardOptions,
  ): WalkForwardValidationResult {
    // 0. Strict Dataset Boundary & Input Validation (Fail Closed)
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      throw new Error(
        'INVALID_WALK_FORWARD_OPTIONS: WalkForwardValidator requires an IWalkForwardOptions configuration object',
      );
    }
    if (!options.experienceDataset || !Array.isArray(options.experienceDataset.experiences)) {
      throw new Error('INVALID_EXPERIENCE_DATASET: options.experienceDataset with experiences array is required');
    }
    if (!options.marketDataset || !Array.isArray(options.marketDataset.executionCandles)) {
      throw new Error('INVALID_MARKET_DATASET: options.marketDataset with continuous executionCandles is required');
    }

    const numFolds = options.numFolds || 4;
    const embargoMs = options.embargoMs ?? (options.embargoDays !== undefined ? options.embargoDays * 24 * 60 * 60 * 1000 : 0);
    const warmupBars = options.warmupBars ?? 40;

    if (numFolds < 1) {
      throw new Error(`INVALID_NUM_FOLDS:${numFolds}`);
    }
    if (embargoMs < 0) {
      throw new Error(`INVALID_EMBARGO_DURATION:${embargoMs}`);
    }
    if (!Number.isInteger(warmupBars) || warmupBars < 0) {
      throw new Error(`INVALID_WARMUP_BARS:${warmupBars}`);
    }

    // Market dataset is authoritative for the entire temporal validation timeline
    const candles = options.marketDataset.executionCandles || [];
    const minFoldIntervalSize = 5;
    const minMarketCandlesRequired = Math.max(20, (numFolds + 2) * minFoldIntervalSize);
    if (candles.length < minMarketCandlesRequired) {
      throw new Error(
        `INSUFFICIENT_CONTINUOUS_MARKET_DATA: Market dataset requires at least ${minMarketCandlesRequired} continuous executionCandles for ${numFolds} folds (warmup and fold geometry), got ${candles.length}`,
      );
    }

    const experiences = options.experienceDataset.experiences || [];

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

    const expectedIntervalMs =
      options.marketDataset.expectedIntervalMs ||
      MarketDatasetValidator.resolveTimeframeIntervalMs(options.marketDataset.timeframe || '15m');

    const totalIntervals = candles.length;
    const foldIntervalSize = Math.floor(totalIntervals / (numFolds + 2)); // Divide into train, val, oos chunks
    if (foldIntervalSize < 1) {
      throw new Error('INSUFFICIENT_MARKET_DATA_FOR_FOLDS: Candle count is insufficient for fold partitioning');
    }

    const folds: WalkForwardFold[] = [];
    const foldArtifacts: FoldArtifact[] = [];

    let totalIS = 0;
    let totalOOS = 0;

    for (let f = 0; f < numFolds; f++) {
      // 1. Authoritative Market Timeline Partitioning
      const trainStartIdx = 0;
      const trainEndIdx = (f + 1) * foldIntervalSize;
      const valStartIdx = trainEndIdx;
      const valEndIdx = Math.min(totalIntervals, valStartIdx + Math.max(1, Math.floor(foldIntervalSize / 2)));
      const testStartIdx = valEndIdx;
      const testEndIdx = Math.min(totalIntervals, testStartIdx + foldIntervalSize);

      if (trainEndIdx > totalIntervals || valStartIdx >= totalIntervals) {
        throw new Error('TRAIN_MARKET_WINDOW_NOT_FOUND');
      }
      if (valEndIdx > totalIntervals) {
        throw new Error('VALIDATION_MARKET_WINDOW_NOT_FOUND');
      }
      if (testStartIdx >= totalIntervals || testEndIdx > totalIntervals) {
        throw new Error('OOS_MARKET_WINDOW_NOT_FOUND');
      }

      const trainStartTs = new Date(candles[trainStartIdx].timestamp).getTime();
      const trainEndTs = new Date(candles[trainEndIdx - 1].timestamp).getTime();
      const valStartTs = new Date(candles[valStartIdx].timestamp).getTime();
      const valEndTs = new Date(candles[valEndIdx - 1].timestamp).getTime();
      const testStartTs = new Date(candles[testStartIdx].timestamp).getTime();
      const testEndTs = new Date(candles[testEndIdx - 1].timestamp).getTime();

      // P1 #10: Apply warmup bars across train, validation, and OOS windows identically for equivalent indicator & state initialization
      const trainWindow = sliceContinuousMarketWindow(candles, trainStartTs, trainEndTs, warmupBars);
      const valWindow = sliceContinuousMarketWindow(candles, valStartTs, valEndTs, warmupBars);
      const testWindow = sliceContinuousMarketWindow(candles, testStartTs, testEndTs, warmupBars);

      if (!trainWindow || !trainWindow.allCandles || trainWindow.allCandles.length === 0) {
        throw new Error('TRAIN_MARKET_WINDOW_NOT_FOUND');
      }
      if (!valWindow || !valWindow.allCandles || valWindow.allCandles.length === 0) {
        throw new Error('VALIDATION_MARKET_WINDOW_NOT_FOUND');
      }
      if (!testWindow || !testWindow.allCandles || testWindow.allCandles.length === 0) {
        throw new Error('OOS_MARKET_WINDOW_NOT_FOUND');
      }

      const trainCandles = trainWindow.allCandles;
      const valCandles = valWindow.allCandles;
      const testCandles = testWindow.allCandles;

      // P1 #11: Validate sliced continuous market candles before setting isContinuous
      MarketDatasetValidator.validateCandles(trainCandles, options.marketDataset.timeframe || '15m', { expectedIntervalMs });
      MarketDatasetValidator.validateCandles(valCandles, options.marketDataset.timeframe || '15m', { expectedIntervalMs });
      MarketDatasetValidator.validateCandles(testCandles, options.marketDataset.timeframe || '15m', { expectedIntervalMs });

      const trainRange: [Date, Date] = [new Date(trainStartTs), new Date(trainEndTs)];
      const validateRange: [Date, Date] = [new Date(valStartTs), new Date(valEndTs)];
      const testRange: [Date, Date] = [new Date(testStartTs), new Date(testEndTs)];

      // 2. Join supervised experiences into authoritative market windows
      const trainSlice = sorted.filter((e) => {
        const t = new Date(e.timestamp).getTime();
        return t >= trainStartTs && t <= trainEndTs;
      });
      if (trainSlice.length === 0) {
        throw new Error('INSUFFICIENT_TRAINING_LABELS_FOR_MARKET_WINDOW');
      }

      const valRaw = sorted.filter((e) => {
        const t = new Date(e.timestamp).getTime();
        return t >= valStartTs && t <= valEndTs;
      });

      const testRaw = sorted.filter((e) => {
        const t = new Date(e.timestamp).getTime();
        return t >= testStartTs && t <= testEndTs;
      });

      // 3. Purge validation samples whose entry timestamp overlaps with active training labels + embargoMs
      let trainMaxLabelEnd = 0;
      for (const e of trainSlice) {
        if (e.labelEndTimestamp === undefined || e.labelEndTimestamp === null) {
          throw new Error('MISSING_LABEL_END_TIMESTAMP');
        }
        const endTs = e.labelEndTimestamp;
        if (endTs > trainMaxLabelEnd) trainMaxLabelEnd = endTs;
      }

      const valPurged = valRaw.filter((e) => new Date(e.timestamp).getTime() > trainMaxLabelEnd + embargoMs);
      if (valPurged.length === 0 && valRaw.length > 0) {
        throw new Error('INSUFFICIENT_PURGED_VALIDATION_DATA');
      }
      const valSlice = valPurged;

      // 4. Purge OOS samples whose entry timestamp overlaps with active validation labels + embargoMs
      let valMaxLabelEnd = trainMaxLabelEnd;
      for (const e of valSlice) {
        if (e.labelEndTimestamp === undefined || e.labelEndTimestamp === null) {
          throw new Error('MISSING_LABEL_END_TIMESTAMP');
        }
        const endTs = e.labelEndTimestamp;
        if (endTs > valMaxLabelEnd) valMaxLabelEnd = endTs;
      }

      const testPurged = testRaw.filter((e) => new Date(e.timestamp).getTime() > valMaxLabelEnd + embargoMs);
      if (testPurged.length === 0 && testRaw.length > 0) {
        throw new Error('INSUFFICIENT_PURGED_OOS_DATA');
      }
      const testSlice = testPurged;

      // 5. Genuine ML fold retraining: feature selection, scaler fit, and model training strictly on training labels
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
      if (!modelArtifact || !modelArtifact.modelVersion) {
        throw new Error('INVALID_MODEL_ARTIFACT: Model artifact must contain a valid modelVersion');
      }

      // 6. Distinct Cryptographic Hashes for Experience vs Market Datasets (P1 #15 & #16)
      const trainExpDatasetHash = DatasetManager.computeCanonicalDatasetHash(trainSlice);
      const valExpDatasetHash = valSlice.length > 0 ? DatasetManager.computeCanonicalDatasetHash(valSlice) : 'canonical_empty_exp_hash';
      const oosExpDatasetHash = testSlice.length > 0 ? DatasetManager.computeCanonicalDatasetHash(testSlice) : 'canonical_empty_exp_hash';

      // Market dataset hash represents complete market execution input (warmup + evaluation)
      const trainMarketDatasetHash = DatasetManager.computeCanonicalMarketDatasetHash(trainCandles, options.marketDataset.timeframe || '15m');
      const valMarketDatasetHash = DatasetManager.computeCanonicalMarketDatasetHash(valCandles, options.marketDataset.timeframe || '15m');
      const oosMarketDatasetHash = DatasetManager.computeCanonicalMarketDatasetHash(testCandles, options.marketDataset.timeframe || '15m');

      // Sliced datasets
      const trainExpDataset: ExperienceDataset = {
        experiences: trainSlice,
        datasetHash: trainExpDatasetHash,
        featureSchemaVersion: modelArtifact.featureSchemaVersion || '2.0',
        symbol: options.marketDataset.symbol || 'BTCUSDT',
        timeframe: options.marketDataset.timeframe || '15m',
        startTimestamp: new Date(trainSlice[0].timestamp).getTime(),
        endTimestamp: new Date(trainSlice[trainSlice.length - 1].timestamp).getTime(),
      };

      const trainMarketDataset: CandidateMarketDataset = {
        executionCandles: trainCandles,
        datasetHash: trainMarketDatasetHash,
        timeframe: options.marketDataset.timeframe || '15m',
        symbol: options.marketDataset.symbol || 'BTCUSDT',
        startTimestamp: new Date(trainCandles[0].timestamp).getTime(),
        endTimestamp: new Date(trainCandles[trainCandles.length - 1].timestamp).getTime(),
        isContinuous: true,
        expectedIntervalMs,
      };

      const valMarketDataset: CandidateMarketDataset = {
        executionCandles: valCandles,
        datasetHash: valMarketDatasetHash,
        timeframe: options.marketDataset.timeframe || '15m',
        symbol: options.marketDataset.symbol || 'BTCUSDT',
        startTimestamp: new Date(valCandles[0].timestamp).getTime(),
        endTimestamp: new Date(valCandles[valCandles.length - 1].timestamp).getTime(),
        isContinuous: true,
        expectedIntervalMs,
      };

      const oosMarketDataset: CandidateMarketDataset = {
        executionCandles: testCandles,
        datasetHash: oosMarketDatasetHash,
        timeframe: options.marketDataset.timeframe || '15m',
        symbol: options.marketDataset.symbol || 'BTCUSDT',
        startTimestamp: new Date(testCandles[0].timestamp).getTime(),
        endTimestamp: new Date(testCandles[testCandles.length - 1].timestamp).getTime(),
        isContinuous: true,
        expectedIntervalMs,
      };

      // Retrain candidate strategy on fold strictly using fold-specific market data (NO experiences in execution)
      let foldCandidate: StrategyCandidate;
      if (options.fitCandidateParametersOnMarketDataset) {
        foldCandidate = options.fitCandidateParametersOnMarketDataset(
          candidate,
          trainMarketDataset,
          f + 1,
        );
      } else {
        foldCandidate = this.retrainCandidateOnFold(
          trainMarketDataset,
          candidate,
          f + 1,
          modelArtifact,
          foldSelection.retainedFeatures,
        );
      }

      const candidateConfigHash = CandidateBacktestRunner.createExecutionConfig(foldCandidate, {
        symbol: options.marketDataset?.symbol || trainMarketDataset.symbol || foldCandidate.symbol || 'BTCUSDT',
      }).configHash;
      const scalerVersion = TemporalFeatureScaler.computeVersion(scalerParams);
      const trainingSeed = options.seed ?? DEFAULT_LEARNING_SEED;

      // Extract clean, deterministic primitive strategy parameters for canonical provenance
      const cleanStrategyParams: Record<string, string | number | boolean | null | undefined> = {};
      if (foldCandidate.change && typeof foldCandidate.change === 'object') {
        for (const [key, value] of Object.entries(foldCandidate.change)) {
          if (
            typeof value === 'string' ||
            typeof value === 'number' ||
            typeof value === 'boolean' ||
            value === null ||
            value === undefined
          ) {
            cleanStrategyParams[key] = value;
          }
        }
      }

      // Create and freeze immutable, real FoldArtifact with explicit hashes (no ambiguous legacy aliases)
      const foldArtifact: FoldArtifact = Object.freeze({
        foldIndex: f + 1,
        trainExperienceDatasetHash: trainExpDatasetHash,
        validationExperienceDatasetHash: valExpDatasetHash,
        oosExperienceDatasetHash: oosExpDatasetHash,
        trainMarketExecutionInputHash: trainMarketDatasetHash,
        validationMarketExecutionInputHash: valMarketDatasetHash,
        oosMarketExecutionInputHash: oosMarketDatasetHash,
        trainMarketDatasetHash,
        validationMarketDatasetHash: valMarketDatasetHash,
        oosMarketDatasetHash,
        featureSchemaVersion: modelArtifact.featureSchemaVersion || '2.0',
        selectedFeatures: foldSelection.retainedFeatures,
        scalerVersion,
        scalerParameters: scalerParams,
        modelVersion: modelArtifact.modelVersion,
        modelParameters: { weights: modelArtifact.weights, bias: modelArtifact.bias },
        strategyVersion: candidate.baseStrategyVersion || 'v2.0',
        candidateId: candidate.id,
        candidateVersion: foldCandidate.candidateVersion || foldCandidate.id,
        strategyParameters: cleanStrategyParams,
        candidateConfigHash,
        trainingSeed,
        createdAt: new Date(),
      });
      foldArtifacts.push(foldArtifact);

      // 7. Evaluate retrained candidate in-sample strictly on training fold market data (Fail Closed: No whole dataset fallback!)
      const isEval = CandidateEvaluator.evaluateCandidateOnMarketData(foldCandidate, {
        dataset: trainMarketDataset,
        candles: trainCandles,
        evaluationStartTimestamp: trainWindow.evaluationStartTimestamp,
        evaluationEndTimestamp: trainWindow.evaluationEndTimestamp,
      });

      // 8. Evaluate frozen retrained candidate strictly on validation fold market data
      const valEval = CandidateEvaluator.evaluateCandidateOnMarketData(foldCandidate, {
        dataset: valMarketDataset,
        candles: valCandles,
        evaluationStartTimestamp: valWindow.evaluationStartTimestamp,
        evaluationEndTimestamp: valWindow.evaluationEndTimestamp,
      });

      // 9. Evaluate frozen retrained candidate strictly out-of-sample on OOS fold market data
      const oosEval = CandidateEvaluator.evaluateCandidateOnMarketData(foldCandidate, {
        dataset: oosMarketDataset,
        candles: testCandles,
        evaluationStartTimestamp: testWindow.evaluationStartTimestamp,
        evaluationEndTimestamp: testWindow.evaluationEndTimestamp,
      });

      const isExp = isEval.candidateExpectancy;
      const oosExp = oosEval.candidateExpectancy;

      // Real OOS performance metrics derived from market execution replay
      const totalOosSimTrades = oosEval.totalSimulatedTrades;
      const oosSimWins = oosEval.simulatedRMultiples.filter((r) => r > 0).length;
      const winRate = totalOosSimTrades > 0
        ? Number(((oosSimWins / totalOosSimTrades) * 100).toFixed(1))
        : 50;

      const passed = oosExp > 0 && totalOosSimTrades > 0;

      folds.push({
        foldIndex: f + 1,
        trainRange,
        validateRange,
        testRange,
        inSampleExpectancy: isExp,
        outOfSampleExpectancy: oosExp,
        winRate,
        passed,
        simulatedTrades: oosEval.simulatedTrades || [],
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
   * Pure Market Data API: Accepts strictly market data (ICandle[] | CandidateMarketDataset) with no TradingExperience[] union.
   */
  public static retrainCandidateOnFold(
    trainMarketData: ICandle[] | CandidateMarketDataset | undefined,
    baseCandidate: StrategyCandidate,
    foldIndex: number,
    modelArtifact?: ITrainedModelArtifact,
    selectedFeatures?: string[],
    options?: {
      candles?: ICandle[];
      dataset?: CandidateMarketDataset;
    },
  ): StrategyCandidate {
    const marketCandles: ICandle[] | undefined = Array.isArray(trainMarketData)
      ? (trainMarketData as ICandle[])
      : options?.candles;
    const marketDataset: CandidateMarketDataset | undefined =
      trainMarketData && !Array.isArray(trainMarketData)
        ? (trainMarketData as CandidateMarketDataset)
        : options?.dataset;

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
      grid = [50, 55, 60, 65, 70, 75, 80];
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
        symbol: baseCandidate.symbol || marketDataset?.symbol || 'BTCUSDT',
        riskConfig:
          baseCandidate.riskConfig ||
          (baseCandidate.change as any)?.riskConfig || {
            initialCapital: 100000,
            maxRiskPerTrade: 0.01,
            partialExitPolicy: {
              tp1Ratio: 0.33,
              tp2Ratio: 0.33,
              tp3Ratio: 0.34,
              moveStopToBreakevenOnTp1: true,
              trailStopOnTp2: true,
              trailStopOffsetR: 1.0,
            },
          },
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
          dataset: marketDataset,
          candles: marketCandles,
        });
        if (evalRes.totalTrades > 0) {
          // Objective: Maximize trade expectancy penalized for low trade count
          const sampleCount = marketCandles?.length ?? 100;
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
      symbol: baseCandidate.symbol || marketDataset?.symbol || 'BTCUSDT',
      riskConfig:
        baseCandidate.riskConfig ||
        (baseCandidate.change as any)?.riskConfig || {
          initialCapital: 100000,
          maxRiskPerTrade: 0.01,
          partialExitPolicy: {
            tp1Ratio: 0.33,
            tp2Ratio: 0.33,
            tp3Ratio: 0.34,
            moveStopToBreakevenOnTp1: true,
            trailStopOnTp2: true,
            trailStopOffsetR: 1.0,
          },
        },
      candidateVersion: `${baseCandidate.candidateVersion || baseCandidate.id}-fold${foldIndex}`,
      change: {
        ...baseCandidate.change,
        fittedOnFold: foldIndex,
        fittedSampleCount: marketCandles?.length ?? 0,
        fittedValue: bestValue,
        fittedObjective: Number.isFinite(bestObjective) ? Number(bestObjective.toFixed(4)) : 0,
        modelArtifact: baseCandidate.type === 'MODEL' ? modelArtifact : baseCandidate.change?.modelArtifact,
        selectedFeatures,
      },
    };
  }
}
