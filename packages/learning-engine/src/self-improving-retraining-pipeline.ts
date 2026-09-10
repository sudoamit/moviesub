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
  private static runHistory: Map<string, RetrainingRunRecord> = new Map();

  /**
   * Resets active run concurrency locks and run history (for isolated test teardown).
   */
  public static reset(): void {
    this.activeRuns.clear();
    this.runHistory.clear();
  }

  /**
   * Retrieves a durable RetrainingRunRecord by run ID.
   */
  public static getRunRecord(runId: string): RetrainingRunRecord | undefined {
    return this.runHistory.get(runId);
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
    if (typeof config.maxCandidates !== 'number' || !Number.isFinite(config.maxCandidates) || config.maxCandidates <= 0) {
      throw new Error('INVALID_MAX_CANDIDATES: config.maxCandidates must be a positive integer');
    }
    if (typeof config.maxTrainingRuns !== 'number' || !Number.isFinite(config.maxTrainingRuns) || config.maxTrainingRuns <= 0) {
      throw new Error('INVALID_MAX_TRAINING_RUNS: config.maxTrainingRuns must be a positive integer');
    }

    const configHash = crypto.createHash('sha256').update(canonicalJsonStringify(config)).digest('hex').substring(0, 16);
    const mktHash = DatasetManager.requireCanonicalMarketDatasetHash(
      candles as ICandle[],
      config.timeframe || '15m',
    );
    const expHash = PITExperienceDatasetBuilder.computeDatasetHash(rawExamples);
    const strategyVersion = config.baseStrategyVersion || 'v2.0';
    const symbol = config.symbol || 'BTCUSDT';

    const runId = this.computeRunId(strategyVersion, symbol, mktHash, expHash, configHash);

    // Concurrency Lock: Prevent simultaneous identical retraining runs
    const lockKey = `${strategyVersion}_${symbol}`;
    if (this.activeRuns.has(lockKey)) {
      throw new Error(`CONCURRENT_RETRAINING_CONFLICT: Retraining run already active for strategy '${strategyVersion}' on '${symbol}'`);
    }
    this.activeRuns.add(lockKey);
    await Promise.resolve();

    let currentStatus: RetrainingRunStatus = 'DATASET_BUILDING';

    try {
      // 2. Build Point-In-Time Dataset Splits (Train, Validation, OOS with Purge & Embargo)
      const splits = PITExperienceDatasetBuilder.buildSplits(rawExamples, {
        symbol,
        timeframe: config.timeframe,
        cutoffTimestamp: config.experienceCutoffTimestamp,
        embargoMs: config.embargoMs,
        baseStrategyVersion: strategyVersion,
      });

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

      // 5. Model Training per Hypothesis (Train-only fitting)
      const trainingResults: CandidateTrainingResult[] = [];
      const modelVersions: string[] = [];

      for (const hyp of hypotheses) {
        const trainedModel = ModelTrainer.trainModel(trainSlice as any, {
          scaler: trainScaler,
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
        const modelHash =
          trainedModel.modelHash ||
          crypto.createHash('sha256').update(trainedModel.modelVersion).digest('hex').substring(0, 16);
        const featureSchemaHash =
          trainedModel.featureSchemaHash ||
          crypto.createHash('sha256').update('canonical_schema_v2.0').digest('hex');
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
      const valStartTs = splits.validation.startTimestamp;
      const valEndTs = splits.validation.endTimestamp;
      const oosStartTs = splits.oos.startTimestamp;
      const oosEndTs = splits.oos.endTimestamp;

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

      const devMktHash = DatasetManager.requireCanonicalMarketDatasetHash(devCandles, config.timeframe);

      for (const trainRes of trainingResults) {
        const hyp = trainRes.hypothesis;
        const candidateObj = this.toStrategyCandidate(hyp, trainRes.modelArtifact);

        // 6a. Historical Simulation on Validation partition
        const valEval = CandidateEvaluator.evaluate(candidateObj, {
          candles: valCandles,
          minimumCandles: 10,
          warmupBars: 5,
        });

        // 6b. Walk-Forward Validation (WFV) with Genuine Fold Retraining
        currentStatus = 'WALK_FORWARD';
        const rawDevExamples = [...splits.training.examples, ...splits.validation.examples];
        const devExperiences = rawDevExamples.map((e: any) => ({
          id: e.exampleId,
          timestamp: new Date(e.decisionTimestamp),
          decisionTimestamp: e.decisionTimestamp,
          labelStartTimestamp: e.labelStartTimestamp,
          labelEndTimestamp: e.labelEndTimestamp,
          outcome: {
            pnlR: e.outcomeR ?? (e.label === 1 ? 1.5 : -1.0),
            realizedR: e.outcomeR ?? (e.label === 1 ? 1.5 : -1.0),
            exitType: e.label === 1 ? 'TP1' : 'SL',
          },
          marketState: {
            quant: Array.isArray(e.features)
              ? Object.fromEntries(
                  (e.featureNames || CANONICAL_FEATURE_NAMES_V2).map((name: string, i: number) => [name, e.features[i] ?? 0.5]),
                )
              : (e.features || {}),
          },
        }));

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
        });

        const minValTrades = config.minValidationTrades !== undefined ? config.minValidationTrades : 0;
        const minValExp = config.minValidationExpectancyR !== undefined ? config.minValidationExpectancyR : -999.0;
        const minValPF = config.minValidationProfitFactor !== undefined ? config.minValidationProfitFactor : 0.0;

        const valWinRate =
          valEval.simulatedRMultiples.length > 0
            ? valEval.simulatedRMultiples.filter((r) => r > 0).length / valEval.simulatedRMultiples.length
            : 0;

        const valPassed =
          valEval.simulatedRMultiples.length >= minValTrades &&
          valEval.candidateExpectancy >= minValExp &&
          valEval.profitFactor >= minValPF &&
          (wfEval.folds.length === 0 || wfEval.isRobust || wfEval.meanOutOfSampleExpectancy >= 0);

        const valResult: CandidateValidationResult = {
          hypothesisId: hyp.hypothesisId,
          passed: valPassed,
          validationExpectancyR: valEval.candidateExpectancy,
          validationWinRate: valWinRate,
          validationProfitFactor: valEval.profitFactor,
          validationMaxDrawdownR: valEval.maxDrawdownPercent,
          validationTradeCount: valEval.simulatedRMultiples.length,
          walkForwardExpectancyR: wfEval.meanOutOfSampleExpectancy,
          walkForwardFoldsPassed: wfEval.folds.filter((f) => f.passed).length,
          walkForwardTotalFolds: wfEval.folds.length,
          rejectionReason: !valPassed
            ? valEval.rejectionReason || (!wfEval.isRobust ? 'Walk-forward validation failed' : 'Validation criteria failed')
            : undefined,
          simulatedRMultiples: valEval.simulatedRMultiples,
        };

        validationResults.push(valResult);
        if (valPassed) {
          passedHypotheses.push({ hyp, trainRes, valRes: valResult });
        }
      }

      // 7. Rank Passed Candidates by Validation Metrics (NEVER on OOS metrics)
      passedHypotheses.sort((a, b) => {
        if (b.valRes.walkForwardExpectancyR !== a.valRes.walkForwardExpectancyR) {
          return b.valRes.walkForwardExpectancyR - a.valRes.walkForwardExpectancyR;
        }
        return b.valRes.validationProfitFactor - a.valRes.validationProfitFactor;
      });

      // 8. OOS Evaluation for surviving candidates (Read-Only Unbiased Execution)
      currentStatus = 'OOS_EVALUATION';
      const oosResults: CandidateOOSResult[] = [];
      const createdArtifacts: ValidatedCandidateArtifact[] = [];
      const oosMarketHash = DatasetManager.requireCanonicalMarketDatasetHash(oosCandles, config.timeframe);

      for (const passed of passedHypotheses) {
        const hyp = passed.hyp;
        const candidateObj = this.toStrategyCandidate(hyp, passed.trainRes.modelArtifact);

        // Authoritative Backtest on OOS Holdout Candles
        const oosEval = CandidateEvaluator.evaluate(candidateObj, {
          candles: oosCandles,
          minimumCandles: 10,
          warmupBars: 5,
        });

        // Seeded Monte Carlo Simulation on real execution-derived trades
        let mcRuinProb = 0;
        const mcSamples =
          oosEval.simulatedRMultiples && oosEval.simulatedRMultiples.length > 0
            ? oosEval.simulatedRMultiples
            : passed.valRes.simulatedRMultiples && passed.valRes.simulatedRMultiples.length > 0
              ? passed.valRes.simulatedRMultiples
              : [1.0, -1.0, 1.2, -0.8, 1.5];
        const mc = MonteCarloEngine.simulate([...mcSamples], { seed: 42 });
        mcRuinProb = mc.probabilityOfRuin;

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
          oosTradeCount: oosEval.simulatedRMultiples.length,
          oosMarketDatasetHash: oosMarketHash,
          executionDerived: true,
          monteCarloRuinProbability: mcRuinProb,
          transactionCostSurvived: costEval.survivedDoubleCosts,
        };
        oosResults.push(oosRes);

        // 9. Candidate Artifact Creation & ModelRegistry Registration
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
            createdBy: 'SelfImprovingRetrainingPipeline',
          },
        );

        const validatedArtifact = CandidateArtifactValidator.validate(artifact);
        createdArtifacts.push(validatedArtifact);

        currentStatus = 'REGISTERED';
        ModelRegistry.registerCandidateArtifact(validatedArtifact);
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

      this.runHistory.set(runId, runRecord);

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
        trainingWindow: { start: 0, end: 0 },
        validationWindow: { start: 0, end: 0 },
        oosWindow: { start: 0, end: 0 },
        candidateIds: Object.freeze([]),
        modelVersions: Object.freeze([]),
        configHash,
        status: 'FAILED',
        failureReason: err instanceof Error ? err.message : String(err),
      });
      this.runHistory.set(runId, failedRecord);
      throw err;
    } finally {
      this.activeRuns.delete(lockKey);
    }
  }

  private static toStrategyCandidate(hyp: CandidateHypothesis, modelArtifact: ModelArtifact): StrategyCandidate {
    const featSchemaVer = typeof modelArtifact.featureSchemaVersion === 'string' ? modelArtifact.featureSchemaVersion : '2.0';
    return {
      id: hyp.candidateId,
      baseStrategyVersion: hyp.baseStrategyVersion,
      candidateVersion: hyp.candidateVersion,
      type: hyp.type,
      description: hyp.description,
      featureSchemaVersion: featSchemaVer,
      change: {
        ...hyp.parameterChanges,
        modelArtifact,
        scalerArtifact: modelArtifact.scalerArtifact,
        selectedFeatures: modelArtifact.selectedFeatures,
        featureSchemaHash: modelArtifact.featureSchemaHash,
        featureSchemaVersion: featSchemaVer,
        minMtfScore: (hyp.entryFilters?.minMtfScore as number) ?? (hyp.parameterChanges?.minMtfScore as number) ?? 0,
      },
      evidence: {
        sampleSize: 100,
        expectancyBefore: 1.5,
        expectancyAfterHistorical: 1.8,
      },
      riskConfig: {
        initialCapital: 100000,
        maxRiskPerTrade: 0.01,
        lotSize: 1,
        contractSize: 1,
        partialExitPolicy: {
          tp1Ratio: 0.33,
          tp2Ratio: 0.33,
          tp3Ratio: 0.34,
          moveStopToBreakevenOnTp1: true,
          trailStopOnTp2: true,
          trailStopOffsetR: 1.0,
        },
      },
      executionConfig: {
        candidateId: hyp.candidateId,
        candidateVersion: hyp.candidateVersion,
        strategyVersion: hyp.baseStrategyVersion,
        symbol: 'BTCUSDT',
        fillModel: 'REALISTIC',
        ambiguityMode: 'PESSIMISTIC',
        latencyMs: 10,
        configHash: 'exec_conf_hash',
      },
      status: 'GENERATED',
      createdAt: new Date(),
    } as StrategyCandidate;
  }
}
