import * as crypto from 'crypto';
import { ICandle } from '@quant/shared';
import { CANONICAL_FEATURE_NAMES_V2 } from '@quant/trading-engine';
import {
  CandidateHypothesis,
  CandidateMarketDataset,
  CandidateOOSResult,
  CandidateTrainingResult,
  CandidateValidationResult,
  ExperienceDataset,
  ModelArtifact,
  RetrainingRunConfig,
  RetrainingRunRecord,
  RetrainingRunStatus,
  ScalerArtifact,
  StrategyCandidate,
  TrainingDataset,
  TrainingExample,
  ValidatedCandidateArtifact,
} from './types';
import { PITExperienceDatasetBuilder, PITSplitsResult } from './pit-experience-dataset-builder';
import { CandidateHypothesisGenerator } from './candidate-hypothesis-generator';
import { TemporalFeatureScaler } from './feature-scaler';
import { FeatureSelector } from './feature-selector';
import { ModelTrainer } from './model-trainer';
import { CandidateEvaluator } from './candidate-evaluator';
import { WalkForwardValidator, sliceContinuousCandles, DEFAULT_LEARNING_SEED } from './walk-forward-validator';
import { MarketDatasetValidator } from './market-dataset-validator';
import { RobustnessEngine } from './robustness-engine';
import { MonteCarloEngine } from './monte-carlo-engine';
import { CandidateBacktestRunner } from './candidate-backtest-runner';
import { CandidateArtifactValidator } from './candidate-artifact-validator';
import { ModelRegistry } from './model-registry';
import { DatasetManager } from './dataset-manager';
import { canonicalJsonStringify } from './canonical-serializer';
import { RetrainingRunStore } from './retraining-run-store';

export interface PipelineExecutionResult {
  readonly runRecord: RetrainingRunRecord;
  readonly generatedCandidates: readonly CandidateHypothesis[];
  readonly validationResults: readonly CandidateValidationResult[];
  readonly oosResults: readonly CandidateOOSResult[];
  readonly createdArtifacts: readonly ValidatedCandidateArtifact[];
  readonly selectedCandidateId?: string;
}

export class SelfImprovingRetrainingPipeline {
  // STRICT SAFETY INVARIANTS: AUTONOMOUS LIVE PROMOTION / TRADING IS PERMANENTLY DISABLED
  public static readonly AUTOMATIC_LIVE_TRADING_ENABLED = false;
  public static readonly AUTOMATIC_LIVE_PROMOTION_ENABLED = false;
  public static readonly AUTOMATIC_LIVE_ROLLBACK_ENABLED = false;

  private static activeRuns: Set<string> = new Set();

  /**
   * Resets active run concurrency locks and run history (for isolated test teardown).
   */
  public static reset(): void {
    this.activeRuns.clear();
    RetrainingRunStore.reset();
  }

  /**
   * Sets or clears the durable persistence file path for retraining run history.
   */
  public static setPersistencePath(filePath: string | null): void {
    RetrainingRunStore.setPersistencePath(filePath);
  }

  /**
   * Returns current persistence file path for retraining run history.
   */
  public static getPersistencePath(): string | null {
    return RetrainingRunStore.getPersistencePath();
  }

  /**
   * Hydrates retraining run history from durable storage.
   */
  public static loadHistoryFromFile(filePath: string): void {
    RetrainingRunStore.loadFromFile(filePath);
  }

  /**
   * Retrieves a durable RetrainingRunRecord by run ID.
   */
  public static getRunRecord(runId: string): RetrainingRunRecord | undefined {
    return RetrainingRunStore.getRun(runId);
  }

  /**
   * Lists all durable RetrainingRunRecords in chronological order.
   */
  public static listRunRecords(): RetrainingRunRecord[] {
    return RetrainingRunStore.listRuns();
  }

  /**
   * Computes deterministic run ID from input dataset hashes and configuration.
   */
  public static computeRunId(
    strategyVersion: string,
    symbol: string,
    marketDatasetHash: string,
    experienceDatasetHash: string,
    configHash: string,
  ): string {
    const payload = `${strategyVersion}|${symbol}|${marketDatasetHash}|${experienceDatasetHash}|${configHash}`;
    const hash = crypto.createHash('sha256').update(payload).digest('hex').substring(0, 16);
    return `retrain_${strategyVersion}_${symbol}_${hash}`;
  }

  /**
   * Executes the full authoritative self-improving retraining pipeline:
   * PIT Dataset -> Hypothesis Generation -> Train-Only Model Fitting ->
   * Validation Selection -> Walk-Forward Retraining -> OOS Evaluation ->
   * CandidateArtifact Creation -> ModelRegistry Registration.
   */
  public static async executeRetraining(
    rawExamples: readonly TrainingExample[],
    candles: readonly ICandle[],
    config: RetrainingRunConfig,
  ): Promise<PipelineExecutionResult> {
    const startedAt = Date.now();

    // 1. Validate Config & Establish Bounded Search Limits
    if (!config || typeof config !== 'object') {
      throw new Error('MISSING_RETRAINING_CONFIG: Retraining pipeline requires explicit RetrainingRunConfig');
    }
    if (!config.symbol || typeof config.symbol !== 'string' || config.symbol.trim().length === 0) {
      throw new Error('MISSING_SYMBOL: config.symbol must be a non-empty string');
    }
    if (!config.baseStrategyVersion || typeof config.baseStrategyVersion !== 'string' || config.baseStrategyVersion.trim().length === 0) {
      throw new Error('MISSING_STRATEGY_VERSION: config.baseStrategyVersion must be a non-empty string');
    }
    if (typeof config.maxCandidates !== 'number' || !Number.isFinite(config.maxCandidates) || config.maxCandidates <= 0) {
      throw new Error('INVALID_MAX_CANDIDATES: config.maxCandidates must be a positive integer');
    }
    if (typeof config.maxTrainingRuns !== 'number' || !Number.isFinite(config.maxTrainingRuns) || config.maxTrainingRuns <= 0) {
      throw new Error('INVALID_MAX_TRAINING_RUNS: config.maxTrainingRuns must be a positive integer');
    }

    // Strict validation of authoritative riskConfig
    if (!config.riskConfig || typeof config.riskConfig !== 'object') {
      throw new Error('MISSING_RISK_CONFIG: RetrainingRunConfig requires authoritative riskConfig');
    }
    const { initialCapital, maxRiskPerTrade, lotSize, contractSize, partialExitPolicy } = config.riskConfig;
    if (typeof initialCapital !== 'number' || !Number.isFinite(initialCapital) || initialCapital <= 0) {
      throw new Error('INVALID_RISK_CONFIG: riskConfig.initialCapital must be a positive finite number');
    }
    if (typeof maxRiskPerTrade !== 'number' || !Number.isFinite(maxRiskPerTrade) || maxRiskPerTrade <= 0 || maxRiskPerTrade > 1) {
      throw new Error('INVALID_RISK_CONFIG: riskConfig.maxRiskPerTrade must be between 0 and 1');
    }
    if (typeof lotSize !== 'number' || !Number.isFinite(lotSize) || lotSize <= 0) {
      throw new Error('INVALID_RISK_CONFIG: riskConfig.lotSize must be a positive finite number');
    }
    if (typeof contractSize !== 'number' || !Number.isFinite(contractSize) || contractSize <= 0) {
      throw new Error('INVALID_RISK_CONFIG: riskConfig.contractSize must be a positive finite number');
    }
    if (!partialExitPolicy || typeof partialExitPolicy !== 'object') {
      throw new Error('INVALID_RISK_CONFIG: riskConfig.partialExitPolicy must be an object');
    }
    const exitRatioSum = (partialExitPolicy.tp1Ratio || 0) + (partialExitPolicy.tp2Ratio || 0) + (partialExitPolicy.tp3Ratio || 0);
    if (Math.abs(exitRatioSum - 1.0) > 1e-4) {
      throw new Error(`INVALID_RISK_CONFIG: partialExitPolicy ratios must sum to 1.0, got ${exitRatioSum}`);
    }

    // Strict validation of authoritative executionConfig
    if (!config.executionConfig || typeof config.executionConfig !== 'object') {
      throw new Error('MISSING_EXECUTION_CONFIG: RetrainingRunConfig requires authoritative executionConfig');
    }
    if (!config.executionConfig.symbol || typeof config.executionConfig.symbol !== 'string') {
      throw new Error('INVALID_EXECUTION_CONFIG: executionConfig.symbol is required');
    }
    if (!config.executionConfig.fillModel || typeof config.executionConfig.fillModel !== 'string') {
      throw new Error('INVALID_EXECUTION_CONFIG: executionConfig.fillModel is required');
    }
    if (!config.executionConfig.ambiguityMode || typeof config.executionConfig.ambiguityMode !== 'string') {
      throw new Error('INVALID_EXECUTION_CONFIG: executionConfig.ambiguityMode is required');
    }
    if (!config.timeframe || typeof config.timeframe !== 'string' || config.timeframe.trim().length === 0) {
      throw new Error('MISSING_TIMEFRAME: config.timeframe must be a non-empty string');
    }

    // Strict validation of candidate validation acceptance criteria (FAIL CLOSED)
    if (config.minValidationTrades === undefined || typeof config.minValidationTrades !== 'number' || !Number.isFinite(config.minValidationTrades)) {
      throw new Error('MISSING_VALIDATION_ACCEPTANCE_CRITERIA: config.minValidationTrades must be an explicit finite number');
    }
    if (config.minValidationExpectancyR === undefined || typeof config.minValidationExpectancyR !== 'number' || !Number.isFinite(config.minValidationExpectancyR)) {
      throw new Error('MISSING_VALIDATION_ACCEPTANCE_CRITERIA: config.minValidationExpectancyR must be an explicit finite number');
    }
    if (config.minValidationProfitFactor === undefined || typeof config.minValidationProfitFactor !== 'number' || !Number.isFinite(config.minValidationProfitFactor)) {
      throw new Error('MISSING_VALIDATION_ACCEPTANCE_CRITERIA: config.minValidationProfitFactor must be an explicit finite number');
    }

    const configHash = crypto.createHash('sha256').update(canonicalJsonStringify(config)).digest('hex').substring(0, 16);
    const mktHash = DatasetManager.requireCanonicalMarketDatasetHash(
      candles as ICandle[],
      config.timeframe,
    );
    const expHash = PITExperienceDatasetBuilder.computeDatasetHash(rawExamples);
    const strategyVersion = config.baseStrategyVersion;
    const symbol = config.symbol;

    const runId = this.computeRunId(strategyVersion, symbol, mktHash, expHash, configHash);

    // Concurrency Lock: Prevent simultaneous identical retraining runs
    const lockKey = `${strategyVersion}_${symbol}`;
    if (this.activeRuns.has(lockKey)) {
      throw new Error(`CONCURRENT_RETRAINING_CONFLICT: Retraining run already active for strategy '${strategyVersion}' on '${symbol}'`);
    }
    this.activeRuns.add(lockKey);
    await Promise.resolve();

    let currentStatus: RetrainingRunStatus = 'DATASET_BUILDING';
    let activeSplits: { training?: any; validation?: any; oos?: any } | undefined;
    let activeHypotheses: CandidateHypothesis[] = [];
    let activeModelVersions: string[] = [];

    try {
      // 2. Build Point-In-Time Dataset Splits (Train, Validation, OOS with Purge & Embargo)
      const splits = PITExperienceDatasetBuilder.buildSplits(rawExamples, {
        symbol,
        timeframe: config.timeframe,
        cutoffTimestamp: config.experienceCutoffTimestamp,
        embargoMs: config.embargoMs,
        baseStrategyVersion: strategyVersion,
      });
      activeSplits = splits;

      currentStatus = 'DATASET_VALIDATED';

      // 3. Train-Only Feature Selection & Model Fitting
      currentStatus = 'TRAINING';
      const trainSlice = splits.training.examples;
      const trainScaler = new TemporalFeatureScaler();
      trainScaler.fit(trainSlice as any);

      // Feature selection on TRAIN partition ONLY
      const featureSelection = FeatureSelector.selectFeatures(trainSlice as any);
      const selectedFeatures = featureSelection.retainedFeatures;

      // 4. Generate Bounded Candidate Hypotheses from TRAIN data only
      const hypotheses = CandidateHypothesisGenerator.generateHypotheses({
        baseStrategyVersion: strategyVersion,
        trainingDataset: splits.training,
        limits: {
          maxCandidates: config.maxCandidates,
          maxTrainingRuns: config.maxTrainingRuns,
          maxFeatureCombinations: config.maxFeatureCombinations,
          maxHyperparameterCombinations: config.maxHyperparameterCombinations,
        },
        featureSelection,
      });
      activeHypotheses = hypotheses;

      // 5. Model Training per Hypothesis (Train-only fitting)
      const trainingResults: CandidateTrainingResult[] = [];
      const modelVersions: string[] = [];

      for (const hyp of hypotheses) {
        const trainedModel = ModelTrainer.trainModel(trainSlice as any, {
          scaler: trainScaler,
          featureNames: hyp.selectedFeatures ?? selectedFeatures,
          epochs: (hyp.modelHyperparameters?.epochs as number) ?? 50,
          learningRate: (hyp.modelHyperparameters?.learningRate as number) ?? 0.05,
          l2Lambda: (hyp.modelHyperparameters?.l2Lambda as number) ?? 0.01,
        });

        const scalerParams: Record<string, { mean: number; std: number; min: number; max: number }> = {};
        for (const f of hyp.selectedFeatures ?? selectedFeatures) {
          const stats = trainScaler.getParams(f);
          if (stats) scalerParams[f] = stats;
        }
        const scalerHash = TemporalFeatureScaler.computeScalerHash(scalerParams);
        const scalerArtifact: ScalerArtifact = { scalerParameters: scalerParams };
        const modelHash = trainedModel.modelHash;
        const featureSchemaHash = trainedModel.featureSchemaHash;
        const featureSchemaVersion = trainedModel.featureSchemaVersion || '2.0';
        const feats = hyp.selectedFeatures ? [...hyp.selectedFeatures] : [...selectedFeatures];
        const selectedFeatureHash = crypto
          .createHash('sha256')
          .update(feats.join(','))
          .digest('hex');

        const modelArtifact: ModelArtifact = {
          modelId: `model_${hyp.candidateId}`,
          modelVersion: trainedModel.modelVersion,
          weights: trainedModel.weights,
          bias: trainedModel.bias,
          featureSchemaVersion,
          featureSchemaHash,
          scalerArtifact,
          scalerHash,
          selectedFeatures: feats,
          selectedFeatureHash,
        };

        modelVersions.push(trainedModel.modelVersion);
        activeModelVersions.push(trainedModel.modelVersion);

        trainingResults.push({
          hypothesis: hyp,
          modelArtifact,
          scalerArtifact,
          modelHash,
          scalerHash,
          selectedFeatureHash,
          trainingLoss: trainedModel.trainLoss,
          trainingSampleCount: trainSlice.length,
          trainedAt: Date.now(),
        });
      }

      // 6. Validation Selection Pipeline (Evaluate Hypotheses on VALIDATION partition)
      currentStatus = 'VALIDATION';
      const validationResults: CandidateValidationResult[] = [];
      const passedHypotheses: { hyp: CandidateHypothesis; trainRes: CandidateTrainingResult; valRes: CandidateValidationResult }[] = [];

      // Partition Market Candles for Development (Train + Validation) vs OOS based on temporal dataset boundaries
      const trainStartTs = splits.training.startTimestamp;
      const trainEndTs = splits.training.endTimestamp;
      const valStartTs = splits.validation.startTimestamp;
      const valEndTs = splits.validation.endTimestamp;
      const oosStartTs = splits.oos.startTimestamp;
      const oosEndTs = splits.oos.endTimestamp;

      const trainCandles = (sliceContinuousCandles(candles as ICandle[], trainStartTs, trainEndTs, 40) ||
        candles.filter((c) => {
          const t = new Date(c.timestamp).getTime();
          return t >= trainStartTs && t <= trainEndTs;
        })) as ICandle[];

      const devCandles = (sliceContinuousCandles(candles as ICandle[], trainStartTs, valEndTs, 40) ||
        candles.filter((c) => {
          const t = new Date(c.timestamp).getTime();
          return t >= trainStartTs && t <= valEndTs;
        })) as ICandle[];

      const valCandles = (sliceContinuousCandles(candles as ICandle[], valStartTs, valEndTs, 40) ||
        candles.filter((c) => {
          const t = new Date(c.timestamp).getTime();
          return t >= valStartTs && t <= valEndTs;
        })) as ICandle[];

      const oosCandles = (sliceContinuousCandles(candles as ICandle[], oosStartTs, oosEndTs, 40) ||
        candles.filter((c) => {
          const t = new Date(c.timestamp).getTime();
          return t >= oosStartTs && t <= oosEndTs;
        })) as ICandle[];

      const trainMktHash = DatasetManager.requireCanonicalMarketDatasetHash(trainCandles, config.timeframe);
      const valMktHash = DatasetManager.requireCanonicalMarketDatasetHash(valCandles, config.timeframe);
      const oosMktHash = DatasetManager.requireCanonicalMarketDatasetHash(oosCandles, config.timeframe);
      const devMktHash = DatasetManager.requireCanonicalMarketDatasetHash(devCandles, config.timeframe);
      const canonicalV2SchemaHash = ModelTrainer.computeFeatureSchemaHash(CANONICAL_FEATURE_NAMES_V2, '2.0');

      // Baseline Champion Strategy Candidate for validation benchmarks
      const championCand: StrategyCandidate = {
        id: 'champion_baseline_benchmark',
        baseStrategyVersion: strategyVersion,
        candidateVersion: `${strategyVersion}-baseline`,
        type: 'BASELINE',
        description: 'Champion Baseline Benchmark Strategy Candidate',
        change: {
          symbol: config.symbol,
          minMtfScore: config.executionConfig.minMtfScore,
          stopLossAtrMultiplier: config.executionConfig.stopLossAtrMultiplier,
          sizingMultiplier: config.executionConfig.sizingMultiplier,
          fillModel: config.executionConfig.fillModel,
          ambiguityMode: config.executionConfig.ambiguityMode,
          latencyMs: config.executionConfig.latencyMs,
        },
        evidence: {
          sampleSize: trainSlice.length,
          expectancyBefore: 0,
          expectancyAfterHistorical: 0,
        },
        riskConfig: config.riskConfig,
        executionConfig: config.executionConfig,
        status: 'PROMOTED',
        createdAt: new Date(),
      };

      for (const trainRes of trainingResults) {
        const hyp = trainRes.hypothesis;
        const candidateObj = this.toStrategyCandidate(hyp, trainRes.modelArtifact, config, trainSlice.length, 0, 0);

        // 6a. Historical Simulation on Validation partition
        const valEval = CandidateEvaluator.evaluate(candidateObj, {
          baselineCandidate: championCand,
          candles: valCandles,
          minimumCandles: 10,
          warmupBars: 5,
          symbol,
          timeframe: config.timeframe,
          riskConfig: candidateObj.riskConfig,
          criteria: {
            minExpectancyDelta: 0.0,
            minProfitFactor: config.minValidationProfitFactor,
            minCandidateExpectancy: config.minValidationExpectancyR,
            minTrades: config.minValidationTrades,
          },
        });

        // 6b. Walk-Forward Validation (WFV) with Genuine Fold Retraining
        currentStatus = 'WALK_FORWARD';
        const rawDevExamples = [...splits.training.examples, ...splits.validation.examples];
        const devExperiences = rawDevExamples.map((e: TrainingExample) => {
          if (e.outcomeR === undefined || e.outcomeR === null || !Number.isFinite(e.outcomeR)) {
            throw new Error(`MISSING_OUTCOME_R_PROVENANCE: Training example '${e.exampleId}' lacks validated outcomeR for walk-forward validation`);
          }
          if (!e.exitType || typeof e.exitType !== 'string' || e.exitType.trim() === '') {
            throw new Error(`MISSING_EXIT_TYPE_PROVENANCE: Training example '${e.exampleId}' lacks validated exitType for walk-forward validation`);
          }

          let quantFeatures: Record<string, number>;
          if (Array.isArray(e.features)) {
            let names: readonly string[];
            if (e.featureNames && Array.isArray(e.featureNames) && e.featureNames.length === e.features.length) {
              names = e.featureNames;
            } else if (e.featureSchemaHash && e.features.length === CANONICAL_FEATURE_NAMES_V2.length) {
              const computed = ModelTrainer.computeFeatureSchemaHash(CANONICAL_FEATURE_NAMES_V2, '2.0');
              if (e.featureSchemaHash === computed) {
                names = CANONICAL_FEATURE_NAMES_V2;
              } else {
                throw new Error(`FEATURE_SCHEMA_MISMATCH: Example '${e.exampleId}' schema hash ${e.featureSchemaHash} does not match canonical 2.0 schema hash ${computed}`);
              }
            } else {
              throw new Error(`MISSING_FEATURE_NAMES_PROVENANCE: Example '${e.exampleId}' has array features without matching featureNames or valid canonical schema hash binding`);
            }

            quantFeatures = {};
            for (let i = 0; i < names.length; i++) {
              const val = e.features[i];
              if (val === undefined || val === null || typeof val !== 'number' || !Number.isFinite(val)) {
                throw new Error(`MISSING_FEATURE_VALUE: Example '${e.exampleId}' lacks valid finite value for feature '${names[i]}'`);
              }
              quantFeatures[names[i]] = val;
            }
          } else if (e.features && typeof e.features === 'object') {
            quantFeatures = {};
            for (const [k, v] of Object.entries(e.features as unknown as Record<string, unknown>)) {
              if (v === undefined || v === null || typeof v !== 'number' || !Number.isFinite(v)) {
                throw new Error(`MISSING_FEATURE_VALUE: Example '${e.exampleId}' lacks valid finite value for feature '${k}'`);
              }
              quantFeatures[k] = v;
            }
          } else {
            throw new Error(`MISSING_FEATURE_VALUE: Example '${e.exampleId}' has invalid features structure`);
          }

          return {
            id: e.exampleId,
            timestamp: new Date(e.decisionTimestamp),
            decisionTimestamp: e.decisionTimestamp,
            labelStartTimestamp: e.labelStartTimestamp,
            labelEndTimestamp: e.labelEndTimestamp,
            label: e.label,
            labelBinary: e.label,
            outcome: {
              pnlR: e.outcomeR,
              realizedR: e.outcomeR,
              exitType: e.exitType,
            },
            marketState: {
              quant: quantFeatures,
            },
          };
        });

        const devExpDataset: ExperienceDataset = {
          experiences: devExperiences as any,
          datasetHash: splits.training.datasetHash,
          featureSchemaVersion: '2.0',
          symbol,
          timeframe: config.timeframe,
          startTimestamp: splits.training.startTimestamp,
          endTimestamp: splits.validation.endTimestamp,
        };

        const devMarketDataset: CandidateMarketDataset = {
          executionCandles: devCandles,
          datasetHash: devMktHash,
          timeframe: config.timeframe,
          symbol,
          startTimestamp: new Date(devCandles[0].timestamp).getTime(),
          endTimestamp: new Date(devCandles[devCandles.length - 1].timestamp).getTime(),
          isContinuous: true,
        };

        const wfEval = WalkForwardValidator.validate(candidateObj, {
          experienceDataset: devExpDataset,
          marketDataset: devMarketDataset,
          embargoMs: config.embargoMs,
          numFolds: config.numFolds,
          warmupBars: config.warmupBars,
        });

        const minValTrades = config.minValidationTrades !== undefined ? config.minValidationTrades : 0;
        const minValExp = config.minValidationExpectancyR !== undefined ? config.minValidationExpectancyR : -999.0;
        const minValPF = config.minValidationProfitFactor !== undefined ? config.minValidationProfitFactor : 0.0;

        const valWinRate =
          valEval.simulatedRMultiples.length > 0
            ? valEval.simulatedRMultiples.filter((r) => r > 0).length / valEval.simulatedRMultiples.length
            : 0;

        const valPassed =
          valEval.passed &&
          valEval.simulatedRMultiples.length >= minValTrades &&
          valEval.candidateExpectancy >= minValExp &&
          valEval.profitFactor >= minValPF &&
          (wfEval.folds.length === 0 || wfEval.isRobust || wfEval.meanOutOfSampleExpectancy >= 0);

        const valRes: CandidateValidationResult = {
          hypothesisId: hyp.hypothesisId,
          passed: valPassed,
          validationExpectancyR: valEval.candidateExpectancy,
          validationWinRate: valWinRate,
          validationProfitFactor: valEval.profitFactor,
          validationMaxDrawdownR: valEval.maxDrawdownPercent,
          validationTradeCount: valEval.totalSimulatedTrades,
          walkForwardExpectancyR: wfEval.meanOutOfSampleExpectancy,
          walkForwardFoldsPassed: wfEval.folds.filter((f) => f.passed).length,
          walkForwardTotalFolds: wfEval.folds.length,
          rejectionReason: !valPassed
            ? valEval.rejectionReason || (!wfEval.isRobust ? 'Walk-forward validation failed' : 'Validation criteria failed')
            : undefined,
          simulatedRMultiples: valEval.simulatedRMultiples,
        };
        validationResults.push(valRes);

        if (valPassed) {
          passedHypotheses.push({ hyp, trainRes, valRes });
        }
      }

      // 7. Rejection Gate
      if (passedHypotheses.length === 0) {
        currentStatus = 'REJECTED';
      } else {
        currentStatus = 'OOS_EVALUATION';
      }

      // 8. OOS Holdout Evaluation strictly for passing hypotheses
      const oosResults: CandidateOOSResult[] = [];
      const createdArtifacts: ValidatedCandidateArtifact[] = [];

      for (const passed of passedHypotheses) {
        const hyp = passed.hyp;
        const candidateObj = this.toStrategyCandidate(
          hyp,
          passed.trainRes.modelArtifact,
          config,
          trainSlice.length,
          passed.valRes.validationExpectancyR,
          passed.valRes.walkForwardExpectancyR,
        );

        // Authoritative Backtest on OOS Holdout Candles
        const oosEval = CandidateEvaluator.evaluate(candidateObj, {
          baselineCandidate: championCand,
          candles: oosCandles,
          minimumCandles: 10,
          warmupBars: 5,
          symbol,
          timeframe: config.timeframe,
          riskConfig: candidateObj.riskConfig,
          criteria: {
            minExpectancyDelta: 0.0,
            minProfitFactor: config.minValidationProfitFactor,
            minCandidateExpectancy: config.minValidationExpectancyR,
            minTrades: config.minValidationTrades ?? 0,
          },
        });

        // Seeded Monte Carlo Simulation on real execution-derived trades only (ZERO synthetic fallback)
        let mcRuinProb: number | undefined = undefined;
        let isMonteCarloAvailable = false;
        const realTrades =
          oosEval.simulatedRMultiples && oosEval.simulatedRMultiples.length >= 5
            ? oosEval.simulatedRMultiples
            : passed.valRes.simulatedRMultiples && passed.valRes.simulatedRMultiples.length >= 5
              ? passed.valRes.simulatedRMultiples
              : null;

        if (realTrades && realTrades.length >= 5) {
          const mc = MonteCarloEngine.simulate([...realTrades], { seed: config.seed ?? DEFAULT_LEARNING_SEED });
          mcRuinProb = mc.probabilityOfRuin;
          isMonteCarloAvailable = true;
        }

        const costEval = RobustnessEngine.evaluateCosts(candidateObj, {
          candles: oosCandles,
        });

        const oosWinRate =
          oosEval.simulatedRMultiples.length > 0
            ? oosEval.simulatedRMultiples.filter((r) => r > 0).length / oosEval.simulatedRMultiples.length
            : 0;

        const oosRes: CandidateOOSResult = {
          hypothesisId: hyp.hypothesisId,
          oosExpectancyR: oosEval.candidateExpectancy,
          oosWinRate,
          oosProfitFactor: oosEval.profitFactor,
          oosMaxDrawdownPercent: oosEval.maxDrawdownPercent,
          oosTradeCount: oosEval.totalSimulatedTrades,
          oosMarketDatasetHash: oosMktHash,
          executionDerived: true,
          isMonteCarloAvailable,
          monteCarloRuinProbability: mcRuinProb,
          transactionCostSurvived: costEval.survivedDoubleCosts,
        };
        oosResults.push(oosRes);

        // 9. Candidate Artifact Creation
        currentStatus = 'CANDIDATE_ARTIFACT_CREATED';
        const candidateWithMetrics: StrategyCandidate = {
          ...candidateObj,
          status: 'SHADOW_PENDING',
          validationMetrics: {
            inSampleExpectancy: passed.valRes.validationExpectancyR,
            walkForwardExpectancy: passed.valRes.walkForwardExpectancyR,
            outOfSampleExpectancy: oosEval.candidateExpectancy,
            profitFactor: oosEval.profitFactor,
            maxDrawdownPercent: oosEval.maxDrawdownPercent,
            monteCarloRuinProb: mcRuinProb,
            transactionCostSurvived: costEval.survivedDoubleCosts,
          },
        };

        const artifact = CandidateBacktestRunner.createCandidateArtifact(
          candidateWithMetrics,
          devMktHash,
          config.seed ?? DEFAULT_LEARNING_SEED,
          {
            trainingDatasetHash: splits.training.datasetHash,
            validationDatasetHash: splits.validation.datasetHash,
            oosDatasetHash: splits.oos.datasetHash,
            marketDatasetHash: devMktHash,
            developmentMarketDatasetHash: devMktHash,
            trainingMarketDatasetHash: trainMktHash,
            validationMarketDatasetHash: valMktHash,
            oosMarketDatasetHash: oosMktHash,
            trainingExperienceDatasetHash: splits.training.datasetHash,
            validationExperienceDatasetHash: splits.validation.datasetHash,
            oosExperienceDatasetHash: splits.oos.datasetHash,
            createdBy: 'SelfImprovingRetrainingPipeline',
          },
        );

        const validatedArtifact = CandidateArtifactValidator.validate(artifact);
        createdArtifacts.push(validatedArtifact);
      }

      // 10. Atomic ModelRegistry & RetrainingRunStore Unified Transaction
      if (createdArtifacts.length > 0) {
        currentStatus = 'REGISTERED';
      }

      const selectedCandidateId = createdArtifacts.length > 0 ? createdArtifacts[0].candidateId : undefined;
      const completedAt = Date.now();
      const finalStatus: RetrainingRunStatus = createdArtifacts.length > 0 ? 'COMPLETED' : 'REJECTED';

      const resultPayload = {
        selectedCandidateId,
        createdArtifactCount: createdArtifacts.length,
        validationPassedCount: passedHypotheses.length,
        oosResultCount: oosResults.length,
      };
      const resultHash = crypto.createHash('sha256').update(canonicalJsonStringify(resultPayload)).digest('hex').substring(0, 16);

      const runRecord: RetrainingRunRecord = Object.freeze({
        runId,
        startedAt,
        completedAt,
        marketDatasetHash: mktHash,
        experienceDatasetHash: expHash,
        trainingWindow: { start: splits.training.startTimestamp, end: splits.training.endTimestamp },
        validationWindow: { start: splits.validation.startTimestamp, end: splits.validation.endTimestamp },
        oosWindow: { start: splits.oos.startTimestamp, end: splits.oos.endTimestamp },
        candidateIds: Object.freeze(hypotheses.map((h) => h.candidateId)),
        selectedCandidateId,
        modelVersions: Object.freeze(modelVersions),
        configHash,
        resultHash,
        status: finalStatus,
      });

      const runStoreSnapshot = RetrainingRunStore.createSnapshot();

      try {
        ModelRegistry.executeTransaction(
          () => {
            if (createdArtifacts.length > 0) {
              for (const artifact of createdArtifacts) {
                ModelRegistry.registerCandidateArtifact(artifact);
              }
            }
            RetrainingRunStore.saveRun(runRecord);
          },
          { requirePersistence: true },
        );
      } catch (txErr) {
        RetrainingRunStore.restoreSnapshot(runStoreSnapshot);
        throw txErr;
      }

      return {
        runRecord,
        generatedCandidates: Object.freeze(hypotheses),
        validationResults: Object.freeze(validationResults),
        oosResults: Object.freeze(oosResults),
        createdArtifacts: Object.freeze(createdArtifacts),
        selectedCandidateId,
      };
    } catch (err: unknown) {
      const failedRecord: RetrainingRunRecord = Object.freeze({
        runId,
        startedAt,
        completedAt: Date.now(),
        marketDatasetHash: mktHash,
        experienceDatasetHash: expHash,
        trainingWindow: activeSplits?.training
          ? { start: activeSplits.training.startTimestamp, end: activeSplits.training.endTimestamp }
          : { start: 0, end: 0 },
        validationWindow: activeSplits?.validation
          ? { start: activeSplits.validation.startTimestamp, end: activeSplits.validation.endTimestamp }
          : { start: 0, end: 0 },
        oosWindow: activeSplits?.oos
          ? { start: activeSplits.oos.startTimestamp, end: activeSplits.oos.endTimestamp }
          : { start: 0, end: 0 },
        candidateIds: Object.freeze(activeHypotheses.map((h) => h.candidateId)),
        modelVersions: Object.freeze([...activeModelVersions]),
        configHash,
        status: 'FAILED',
        failureReason: err instanceof Error ? err.message : String(err),
      });
      RetrainingRunStore.saveRun(failedRecord);
      throw err;
    } finally {
      this.activeRuns.delete(lockKey);
    }
  }

  private static toStrategyCandidate(
    hyp: CandidateHypothesis,
    modelArtifact: ModelArtifact | undefined,
    config: RetrainingRunConfig,
    sampleCount: number,
    baselineExpectancy?: number,
    historicalExpectancy?: number,
  ): StrategyCandidate {
    const featSchemaVer = (modelArtifact && typeof modelArtifact.featureSchemaVersion === 'string')
      ? modelArtifact.featureSchemaVersion
      : '2.0';

    const minMtf =
      (hyp.entryFilters?.minMtfScore as number) ??
      (hyp.parameterChanges?.minMtfScore as number) ??
      (hyp.parameterChanges?.minScore as number) ??
      config.executionConfig.minMtfScore;

    if (minMtf === undefined || !Number.isFinite(minMtf)) {
      throw new Error(`MISSING_MIN_MTF_SCORE: Candidate hypothesis '${hyp.candidateId}' lacks explicit minMtfScore`);
    }

    const stopLossMultiplier =
      (hyp.parameterChanges?.stopLossAtrMultiplier as number) ??
      (hyp.exitOverrides?.stopLossAtrMultiplier as number) ??
      config.executionConfig.stopLossAtrMultiplier;

    if (stopLossMultiplier === undefined || !Number.isFinite(stopLossMultiplier) || stopLossMultiplier <= 0) {
      throw new Error(`MISSING_STOP_LOSS_ATR_MULTIPLIER: Candidate hypothesis '${hyp.candidateId}' lacks explicit stopLossAtrMultiplier`);
    }

    const sizingMult =
      (hyp.parameterChanges?.sizingMultiplier as number) ??
      config.executionConfig.sizingMultiplier;

    if (sizingMult === undefined || !Number.isFinite(sizingMult) || sizingMult <= 0) {
      throw new Error(`MISSING_SIZING_MULTIPLIER: Candidate hypothesis '${hyp.candidateId}' lacks explicit sizingMultiplier`);
    }

    return {
      id: hyp.candidateId,
      baseStrategyVersion: hyp.baseStrategyVersion,
      candidateVersion: hyp.candidateVersion,
      type: hyp.type,
      description: hyp.description,
      featureSchemaVersion: featSchemaVer,
      change: {
        ...hyp.parameterChanges,
        ...(modelArtifact ? {
          modelArtifact,
          scalerArtifact: modelArtifact.scalerArtifact,
          selectedFeatures: modelArtifact.selectedFeatures,
          featureSchemaHash: modelArtifact.featureSchemaHash,
        } : {}),
        featureSchemaVersion: featSchemaVer,
        minMtfScore: minMtf,
        stopLossAtrMultiplier: stopLossMultiplier,
        sizingMultiplier: sizingMult,
        fillModel: config.executionConfig.fillModel,
        ambiguityMode: config.executionConfig.ambiguityMode,
        latencyMs: config.executionConfig.latencyMs,
        symbol: config.symbol,
      },
      evidence: {
        sampleSize: sampleCount,
        expectancyBefore: baselineExpectancy ?? 0,
        expectancyAfterHistorical: historicalExpectancy ?? 0,
      },
      riskConfig: {
        ...config.riskConfig,
        partialExitPolicy: { ...config.riskConfig.partialExitPolicy },
      },
      executionConfig: {
        ...config.executionConfig,
        candidateId: hyp.candidateId,
        candidateVersion: hyp.candidateVersion,
        strategyVersion: hyp.baseStrategyVersion,
        minMtfScore: minMtf,
        stopLossAtrMultiplier: stopLossMultiplier,
        sizingMultiplier: sizingMult,
      },
      status: 'GENERATED',
      createdAt: new Date(),
    } as StrategyCandidate;
  }
}
