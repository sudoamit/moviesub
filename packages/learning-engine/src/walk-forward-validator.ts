import { ICandle } from '@quant/shared';
import {
  CandidateMarketDataset,
  ExperienceDataset,
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

  MarketDatasetValidator.validateCandles(allCandles);

  const warmupStartTimestamp = (warmupCandles[0]?.timestamp || evaluationCandles[0].timestamp) instanceof Date
    ? ((warmupCandles[0]?.timestamp || evaluationCandles[0].timestamp) as Date).getTime()
    : new Date(warmupCandles[0]?.timestamp || evaluationCandles[0].timestamp).getTime();
  const evaluationStartTimestamp = evaluationCandles[0].timestamp instanceof Date
    ? evaluationCandles[0].timestamp.getTime()
    : new Date(evaluationCandles[0].timestamp).getTime();
  const evaluationEndTimestamp = evaluationCandles[evaluationCandles.length - 1].timestamp instanceof Date
    ? evaluationCandles[evaluationCandles.length - 1].timestamp.getTime()
    : new Date(evaluationCandles[evaluationCandles.length - 1].timestamp).getTime();

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
   * Performs chronological purged and embargoed walk-forward validation with genuine candidate retraining per fold.
   * STRICT DATASET BOUNDARY: Exclusively accepts (candidate, options: IWalkForwardOptions).
   */
  public static validate(
    candidate: StrategyCandidate,
    options: IWalkForwardOptions,
  ): WalkForwardValidationResult & { foldArtifacts?: ReadonlyArray<FoldArtifact> } {
    if (!options || !options.experienceDataset || !options.marketDataset) {
      throw new Error('INVALID_WALK_FORWARD_OPTIONS: WalkForwardValidator strictly requires experienceDataset and marketDataset');
    }

    const experiences = options.experienceDataset.experiences || [];
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

    const candles = options.marketDataset.executionCandles || [];
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

      let trainWindow: MarketExecutionWindow | undefined;
      let valWindow: MarketExecutionWindow | undefined;
      let testWindow: MarketExecutionWindow | undefined;

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

        trainWindow = sliceContinuousMarketWindow(candles, trainStartTs, trainEndTs, 0);
        valWindow = sliceContinuousMarketWindow(candles, valStartTs, valEndTs, 40);
        testWindow = sliceContinuousMarketWindow(candles, testStartTs, testEndTs, 40);

        trainCandles = trainWindow?.allCandles;
        valCandles = valWindow?.allCandles;
        testCandles = testWindow?.allCandles;

        trainRange = [new Date(trainStartTs), new Date(trainEndTs)];
        validateRange = [new Date(valStartTs), new Date(valEndTs)];
        testRange = [new Date(testStartTs), new Date(testEndTs)];

        // Supervised labels / experiences within corresponding market windows
        trainSlice = sorted.filter((e) => {
          const t = new Date(e.timestamp).getTime();
          return t >= trainStartTs && t <= trainEndTs;
        });
        if (trainSlice.length === 0) {
          throw new Error('INSUFFICIENT_TRAINING_LABELS_FOR_MARKET_WINDOW');
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

      // Genuine ML fold retraining: feature selection, scaler fit, and model training strictly on training labels
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

        trainCandles = sliceContinuousCandles(candles, trainStartTime, trainEndTime, 40);
        valCandles = sliceContinuousCandles(candles, valStartTime, valEndTime, 40);
        testCandles = sliceContinuousCandles(candles, testStartTime, testEndTime, 40);
      }

      const trainExpStart = new Date(trainSlice[0].timestamp).getTime();
      const trainExpEnd = new Date(trainSlice[trainSlice.length - 1].timestamp).getTime();

      // Build train experience dataset for ML model training and metadata
      const trainExpDataset: ExperienceDataset = {
        experiences: trainSlice,
        datasetHash: trainDatasetHash,
        featureSchemaVersion: modelArtifact.featureSchemaVersion || '2.0',
        symbol: options.marketDataset.symbol || 'BTCUSDT',
        timeframe: options.marketDataset.timeframe || '15m',
        startTimestamp: trainExpStart,
        endTimestamp: trainExpEnd,
      };

      const trainCandlesSlice = trainCandles || candles;
      const trainMarketDataset: CandidateMarketDataset = {
        executionCandles: trainCandlesSlice,
        datasetHash: trainDatasetHash,
        timeframe: options.marketDataset.timeframe || '15m',
        symbol: options.marketDataset.symbol || 'BTCUSDT',
        startTimestamp: trainCandlesSlice.length > 0 ? new Date(trainCandlesSlice[0].timestamp).getTime() : 0,
        endTimestamp: trainCandlesSlice.length > 0 ? new Date(trainCandlesSlice[trainCandlesSlice.length - 1].timestamp).getTime() : 0,
        isContinuous: true,
        expectedIntervalMs: options.marketDataset.expectedIntervalMs || 15 * 60 * 1000,
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
        modelVersion: modelArtifact.modelVersion || '2.0.0',
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

      // 1. Evaluate retrained candidate in-sample strictly on training fold market data
      const isEval = CandidateEvaluator.evaluateCandidateOnMarketData(foldCandidate, {
        dataset: trainMarketDataset,
        candles: trainCandles || candles,
        evaluationStartTimestamp: trainWindow?.evaluationStartTimestamp,
        evaluationEndTimestamp: trainWindow?.evaluationEndTimestamp,
      });

      // 2. Evaluate frozen retrained candidate strictly on validation fold market data
      const valCandlesSlice = valCandles || candles;
      const valMarketDataset: CandidateMarketDataset = {
        executionCandles: valCandlesSlice,
        datasetHash: valDatasetHash,
        timeframe: options.marketDataset.timeframe || '15m',
        symbol: options.marketDataset.symbol || 'BTCUSDT',
        startTimestamp: valCandlesSlice.length > 0 ? new Date(valCandlesSlice[0].timestamp).getTime() : 0,
        endTimestamp: valCandlesSlice.length > 0 ? new Date(valCandlesSlice[valCandlesSlice.length - 1].timestamp).getTime() : 0,
        isContinuous: true,
        expectedIntervalMs: options.marketDataset.expectedIntervalMs || 15 * 60 * 1000,
      };
      const valEval = CandidateEvaluator.evaluateCandidateOnMarketData(foldCandidate, {
        dataset: valMarketDataset,
        candles: valCandles || candles,
        evaluationStartTimestamp: valWindow?.evaluationStartTimestamp,
        evaluationEndTimestamp: valWindow?.evaluationEndTimestamp,
      });

      // 3. Evaluate frozen retrained candidate strictly out-of-sample on OOS fold market data
      const oosCandlesSlice = testCandles || candles;
      const oosMarketDataset: CandidateMarketDataset = {
        executionCandles: oosCandlesSlice,
        datasetHash: oosDatasetHash,
        timeframe: options.marketDataset.timeframe || '15m',
        symbol: options.marketDataset.symbol || 'BTCUSDT',
        startTimestamp: oosCandlesSlice.length > 0 ? new Date(oosCandlesSlice[0].timestamp).getTime() : 0,
        endTimestamp: oosCandlesSlice.length > 0 ? new Date(oosCandlesSlice[oosCandlesSlice.length - 1].timestamp).getTime() : 0,
        isContinuous: true,
        expectedIntervalMs: options.marketDataset.expectedIntervalMs || 15 * 60 * 1000,
      };
      const oosEval = CandidateEvaluator.evaluateCandidateOnMarketData(foldCandidate, {
        dataset: oosMarketDataset,
        candles: testCandles || candles,
        evaluationStartTimestamp: testWindow?.evaluationStartTimestamp,
        evaluationEndTimestamp: testWindow?.evaluationEndTimestamp,
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
