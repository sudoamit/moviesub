import { Injectable, Logger, OnModuleInit, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { SignalsService } from '../signals/signals.service';
import { SMCService } from '../smc/smc.service';
import { AccuracyService } from '../accuracy/accuracy.service';
import {
  FeatureVectorExtractor,
  TradePredictionModel,
  ModelRegistry,
  ModelPersistenceManager,
  ChronologicalSplitter,
  WalkForwardValidator,
  ModelPromotionEngine,
  ProbabilityCalibrationEngine,
  ExpectedValueEngine,
  TradeLabelGenerator,
  AmbiguousLabelPolicy,
  TrainingExample,
  TrainingDatasetBuilder,
  OnlineLearningEngine,
  PostMortemAnalyticsEngine,
  ITradePostMortemReport,
  IOnlineUpdateResult,
  FEATURE_SCHEMA_VERSION,
  ICalibrationReport,
  EvaluationMetrics,
  ITradePayoffStructure,
  SignalGenerator,
} from '@quant/trading-engine';
import { Timeframe, ICandle } from '@quant/shared';
import { IsString, IsOptional } from 'class-validator';
import * as crypto from 'crypto';

import { Queue } from 'bullmq';
import { BULLMQ_QUEUES } from '@quant/shared';

export interface IRetrainJobStatus {
  jobId: string;
  status: 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED';
  progressPercent: number;
  stage: string;
  candidateVersion?: string;
  isPromoted?: boolean;
  promotionDecision?: string;
  metrics?: EvaluationMetrics | null;
  error?: string;
  startedAt: Date;
  completedAt?: Date;
}

export class PredictTradeDto {
  @IsString()
  symbol!: string;

  @IsOptional()
  @IsString()
  timeframe?: string;

  @IsOptional()
  @IsString()
  signalId?: string;
}

@Injectable()
export class AILearningService implements OnModuleInit {
  private readonly logger = new Logger(AILearningService.name);
  private readonly registry = new ModelRegistry();
  private readonly retrainJobs = new Map<string, IRetrainJobStatus>();
  private retrainQueue: Queue | null = null;
  private readonly onlineLearningEngine = new OnlineLearningEngine({
    learningRate: 0.005,
    maxWeightChangeNorm: 0.05,
  });
  private recentPostMortems: ITradePostMortemReport[] = [];

  constructor(
    private readonly prisma: PrismaService,
    private readonly signalsService: SignalsService,
    private readonly smcService: SMCService,
    private readonly accuracyService: AccuracyService,
  ) {}

  async onModuleInit() {
    await this.initializeModelRegistry();
    try {
      const host = process.env.REDIS_HOST || 'localhost';
      const port = Number(process.env.REDIS_PORT) || 6380;
      const password = process.env.REDIS_PASSWORD || undefined;
      this.retrainQueue = new Queue(BULLMQ_QUEUES.LEARNING_TASKS, {
        connection: { host, port, password },
      });
      this.logger.log('BullMQ AI Retraining Queue connected.');
    } catch (e: any) {
      this.logger.warn(`BullMQ Queue init deferred: ${e.message}`);
    }
  }

  /**
   * Initializes or bootstraps the active production model from the database.
   */
  private async initializeModelRegistry() {
    try {
      // Find active model in database
      const dbModel = await this.prisma.aIModel.findFirst({
        where: { name: 'Institutional SMC Trade Predictor' },
        include: { activeVersion: true, versions: true },
      });

      if (dbModel && dbModel.activeVersion) {
        const v = dbModel.activeVersion;
        const weights = Array.isArray(v.weightsJson) ? (v.weightsJson as number[]) : [];
        const metrics = (v.metricsJson as any) || ({} as EvaluationMetrics);

        const activeModel = new TradePredictionModel(
          v.version,
          (v.hyperparametersJson as any) || {},
          weights,
          v.bias,
        );

        this.registry.registerVersion(
          ModelPersistenceManager.serialize(activeModel, {
            status: 'ACTIVE',
            metrics,
            trainingExampleCount: v.trainingExampleCount,
            validationExampleCount: v.validationExampleCount,
            outOfSampleExampleCount: v.outOfSampleExampleCount,
          }),
        );

        this.logger.log(`Hydrated active AI model version '${v.version}' from database.`);
        return;
      }

      // Initial Bootstrap: Seed Baseline v1.0.0
      await this.bootstrapBaselineModel();
    } catch (e) {
      this.logger.warn(
        `Database model initialization deferred, starting with in-memory baseline: ${e}`,
      );
      this.bootstrapBaselineModelInMemory();
    }
  }

  private bootstrapBaselineModelInMemory() {
    const baselineModel = new TradePredictionModel('v1.0.0-PROD');
    const state = ModelPersistenceManager.serialize(baselineModel, {
      status: 'CANDIDATE',
      metrics: null as any,
      trainingExampleCount: 0,
      validationExampleCount: 0,
      outOfSampleExampleCount: 0,
    });

    this.registry.registerVersion(state);
  }

  private async bootstrapBaselineModel() {
    const baselineModel = new TradePredictionModel('v1.0.0-PROD');
    const state = ModelPersistenceManager.serialize(baselineModel, {
      status: 'CANDIDATE',
      metrics: null as any,
      trainingExampleCount: 0,
      validationExampleCount: 0,
      outOfSampleExampleCount: 0,
    });

    this.registry.registerVersion(state);

    try {
      const parentModel = await this.prisma.aIModel.upsert({
        where: { name: 'Institutional SMC Trade Predictor' },
        create: {
          name: 'Institutional SMC Trade Predictor',
          description:
            'Supervised Logistic Regression predicting TP vs SL probability from SMC feature vectors.',
          algorithm: 'LOGISTIC_REGRESSION',
        },
        update: {},
      });

      const dbVersion = await this.prisma.aIModelVersion.upsert({
        where: {
          modelId_version: {
            modelId: parentModel.id,
            version: 'v1.0.0-PROD',
          },
        },
        create: {
          modelId: parentModel.id,
          version: 'v1.0.0-PROD',
          featureSchemaVersion: FEATURE_SCHEMA_VERSION,
          status: 'CANDIDATE',
          weightsJson: state.weights,
          bias: state.bias,
          hyperparametersJson: state.hyperparameters as any,
          metricsJson: null as any,
          trainingExampleCount: 0,
          validationExampleCount: 0,
          outOfSampleExampleCount: 0,
          trainingStartedAt: new Date(),
          trainingCompletedAt: new Date(),
        },
        update: {},
      });

      await this.prisma.aIModel.update({
        where: { id: parentModel.id },
        data: { activeVersionId: dbVersion.id },
      });

      this.logger.log(
        `Initialized baseline AI model version '${dbVersion.version}' in database as UNTRAINED.`,
      );
    } catch (e) {
      this.logger.warn(`Could not persist baseline model to Postgres: ${e}`);
    }
  }

  /**
   * 1. GET /api/ai-learning/model-state
   * Returns active model version, metrics, features count, schema version, and all registered model versions.
   */
  getModelState() {
    const activeModel = this.registry.getActiveModel();
    const activeVersionState = this.registry.getActiveVersionState();

    if (!activeModel || !activeVersionState || !activeVersionState.metrics) {
      return {
        modelVersion: 'v1.0.0-PROD',
        status: 'UNTRAINED',
        isTrained: false,
        trainedAt: null,
        datasetStats: {
          trainingExamples: 0,
          validationExamples: 0,
          outOfSampleExamples: 0,
          totalExamples: 0,
        },
        metrics: null,
        calibration: null,
        featureCount: 17,
        featureSchemaVersion: FEATURE_SCHEMA_VERSION,
        allVersions: this.registry.getAllVersions().map((v) => ({
          version: v.version,
          status: v.status,
          createdAt: v.createdAt,
          accuracy: v.metrics?.accuracy ?? null,
          logLoss: v.metrics?.logLoss ?? null,
        })),
      };
    }

    return {
      modelVersion: activeModel.modelVersion,
      status: activeVersionState.status,
      isTrained: true,
      trainedAt: activeVersionState.createdAt,
      datasetStats: {
        trainingExamples: activeVersionState.trainingExampleCount,
        validationExamples: activeVersionState.validationExampleCount,
        outOfSampleExamples: activeVersionState.outOfSampleExampleCount,
        totalExamples:
          activeVersionState.trainingExampleCount +
          activeVersionState.validationExampleCount +
          activeVersionState.outOfSampleExampleCount,
      },
      metrics: {
        accuracy: activeVersionState.metrics.accuracy,
        precision: activeVersionState.metrics.precision,
        recall: activeVersionState.metrics.recall,
        f1Score: activeVersionState.metrics.f1Score,
        brierScore: activeVersionState.metrics.brierScore,
        logLoss: activeVersionState.metrics.logLoss,
        rocAuc: activeVersionState.metrics.rocAuc,
        profitFactor: activeVersionState.metrics.profitFactor,
        expectancyR: activeVersionState.metrics.expectancyR,
      },
      calibration: activeVersionState.calibrationReport,
      featureCount: activeModel.getWeights().length,
      featureSchemaVersion: FEATURE_SCHEMA_VERSION,
      allVersions: this.registry.getAllVersions().map((v) => ({
        version: v.version,
        status: v.status,
        createdAt: v.createdAt,
        accuracy: v.metrics?.accuracy ?? null,
        logLoss: v.metrics?.logLoss ?? null,
      })),
    };
  }

  /**
   * 2. POST /api/ai-learning/retrain (Enqueues job to BullMQ worker)
   */
  async startRetrainJob(): Promise<{ jobId: string; status: string; message: string }> {
    const jobId = `job_${crypto.randomUUID().slice(0, 8)}`;
    const jobStatus: IRetrainJobStatus = {
      jobId,
      status: 'PENDING',
      progressPercent: 0,
      stage: 'Enqueued in BullMQ',
      startedAt: new Date(),
    };

    this.retrainJobs.set(jobId, jobStatus);

    try {
      await this.prisma.aIRetrainJob.create({
        data: {
          id: jobId,
          status: 'PENDING',
          triggerReason: 'MANUAL',
          startedAt: new Date(),
        },
      });
    } catch (e: any) {
      this.logger.warn(`Failed to create AIRetrainJob in DB: ${e.message}`);
    }

    // Offload execution to BullMQ worker
    try {
      if (this.retrainQueue) {
        await this.retrainQueue.add('RETRAIN_MODEL', { jobId, triggerReason: 'MANUAL' });
        this.logger.log(`Enqueued retrain job ${jobId} to BullMQ queue '${BULLMQ_QUEUES.LEARNING_TASKS}'`);
      }
    } catch (e: any) {
      this.logger.error(`Failed to push job to BullMQ queue: ${e.message}`);
    }

    return {
      jobId,
      status: 'PENDING',
      message:
        'Walk-forward training job initiated in BullMQ worker. Poll /api/ai-learning/retrain/:jobId for status.',
    };
  }

  /**
   * 3. GET /api/ai-learning/retrain/:jobId
   */
  async getRetrainJobStatus(jobId: string): Promise<IRetrainJobStatus> {
    const job = this.retrainJobs.get(jobId);
    if (job && job.status === 'RUNNING') return job;

    try {
      const dbJob = await this.prisma.aIRetrainJob.findUnique({ where: { id: jobId } });
      if (dbJob) {
        return {
          jobId: dbJob.id,
          status: dbJob.status as any,
          progressPercent: dbJob.status === 'COMPLETED' ? 100 : dbJob.status === 'FAILED' ? 0 : 50,
          stage: dbJob.status === 'COMPLETED' ? 'Completed' : dbJob.status === 'RUNNING' ? 'Running in Worker' : dbJob.status,
          isPromoted: dbJob.promoted,
          metrics: (dbJob.validationMetricsJson as any) || null,
          error: dbJob.errorMessage || undefined,
          startedAt: dbJob.startedAt || dbJob.createdAt,
          completedAt: dbJob.completedAt || undefined,
        };
      }
    } catch {}

    if (job) return job;

    return {
      jobId,
      status: 'FAILED',
      progressPercent: 0,
      stage: 'Unknown Job',
      error: `Retrain job '${jobId}' not found`,
      startedAt: new Date(),
    };
  }

  /**
   * Builds an authentic training dataset from multi-asset candles and completed trades.
   */
  private async buildTrainingDataset(): Promise<TrainingExample[]> {
    const symbols = ['NIFTY', 'BANKNIFTY', 'BTCUSDT', 'RELIANCE', 'HDFCBANK', 'INFY'];
    const examples: TrainingExample[] = [];

    for (const sym of symbols) {
      try {
        const inst = await this.prisma.instrument.findUnique({ where: { symbol: sym } });
        if (!inst) continue;

        const candles = await this.prisma.candle.findMany({
          where: { instrumentId: inst.id, timeframe: 'M15' as any },
          orderBy: { timestamp: 'asc' },
          take: 120,
        });

        if (candles.length < 35) continue;

        const parsedCandles: ICandle[] = candles.map((c) => ({
          timestamp: c.timestamp,
          open: Number(c.open),
          high: Number(c.high),
          low: Number(c.low),
          close: Number(c.close),
          volume: Number(c.volume || 1),
          isClosed: true,
        }));

        // Generate authentic deterministic SMC training examples across the historical time series
        for (let i = 25; i < parsedCandles.length - 6; i += 2) {
          const entryCandle = parsedCandles[i];
          const histCandles = parsedCandles.slice(0, i + 1);
          const subsequentCandles = parsedCandles.slice(i + 1);

          const realSignal = SignalGenerator.generateSignal({
            symbol: sym,
            executionCandles: histCandles,
            executionTimeframe: '15m',
            htf1Candles: histCandles,
          });

          if (realSignal.direction === 'NEUTRAL' || realSignal.score < 60) continue;

          const features = FeatureVectorExtractor.extract({
            signal: realSignal,
            candles: histCandles,
            asOfTimestamp: new Date(entryCandle.timestamp),
          });

          const outcome = TradeLabelGenerator.evaluateOutcome({
            direction: realSignal.direction as any,
            entryPrice: realSignal.entryZone.optimal,
            stopLoss: realSignal.stopLoss,
            targetPrice: realSignal.takeProfits.tp2,
            entryTimestamp: new Date(entryCandle.timestamp),
            subsequentCandles,
            ambiguousPolicy: AmbiguousLabelPolicy.AMBIGUOUS,
          });

          if (outcome && outcome.label !== null) {
            examples.push({
              id: `ex_${sym}_${i}`,
              symbol: sym,
              featureSchemaVersion: FEATURE_SCHEMA_VERSION,
              features,
              featureArray: FeatureVectorExtractor.toArray(features),
              label: outcome.label,
              outcomeR: outcome.realizedRMultiple,
              predictionTimestamp: new Date(entryCandle.timestamp),
              availableForTrainingAt: outcome.exitTimestamp,
            });
          }
        }
      } catch (e) {
        this.logger.warn(`Error compiling training data for ${sym}: ${e}`);
      }
    }

    return TrainingDatasetBuilder.sortChronologically(examples);
  }

  /**
   * 4. POST /api/ai-learning/predict
   * Strictly evaluates the authentic structured setup from the trading engine (never client arbitrary numbers).
   */
  async predictTrade(dto: PredictTradeDto): Promise<any> {
    const sym = (dto.symbol || 'NIFTY').toUpperCase();
    const tf = (dto.timeframe || '15m') as Timeframe;

    const signal = await this.signalsService.generateSignalForSymbol(sym, tf);
    const smc = await this.smcService.getSMCAnalysis(sym, tf);

    // Fetch candles point-in-time
    const inst = await this.prisma.instrument.findUnique({ where: { symbol: sym } });
    let candles: ICandle[] = [];
    if (inst) {
      const rows = await this.prisma.candle.findMany({
        where: { instrumentId: inst.id, timeframe: 'M15' as any },
        orderBy: { timestamp: 'desc' },
        take: 60,
      });
      candles = rows.reverse().map((r) => ({
        timestamp: r.timestamp,
        open: Number(r.open),
        high: Number(r.high),
        low: Number(r.low),
        close: Number(r.close),
        volume: Number(r.volume || 1),
        isClosed: true,
      }));
    }

    // 1. Extract point-in-time normalized feature vector
    const features = FeatureVectorExtractor.extract({
      signal,
      candles,
      smcAnalysis: smc,
      asOfTimestamp: signal.timestamp ? new Date(signal.timestamp) : new Date(),
    });

    // 2. Predict with Active Model
    const model = this.registry.getActiveModel() || new TradePredictionModel('v1.0.0-PROD');
    const predResult = model.predict(features);

    // 3. Expected Value & Recommendation
    const payoff: ITradePayoffStructure = {
      targetR: signal.riskRewardRatios?.rr2 || 2.0,
      lossR: 1.0,
    };

    const activeState = this.registry.getActiveVersionState();
    const supportingSampleSize = activeState?.metrics?.sampleSize ?? 0;
    const calibrationStatus = activeState?.calibrationReport?.status;

    const recommendationResult = ExpectedValueEngine.evaluateRecommendation({
      probability: predResult.probability,
      payoff,
      supportingSampleSize,
      calibrationStatus,
      minSampleSize: 25,
      modelVersion: model.modelVersion,
    });

    return {
      symbol: sym,
      timeframe: tf,
      deterministicScore: signal.score,
      deterministicGrade: signal.grade,
      direction: signal.direction,
      entryZone: signal.entryZone,
      stopLoss: signal.stopLoss,
      targets: signal.takeProfits,
      riskRewardRatios: signal.riskRewardRatios,
      aiPrediction: {
        winProbability: recommendationResult.winProbability,
        lossProbability: Number((1.0 - recommendationResult.winProbability).toFixed(4)),
        expectedValueR: recommendationResult.expectedValueR,
        averageWinR: recommendationResult.averageWinR,
        averageLossR: recommendationResult.averageLossR,
        recommendation: recommendationResult.recommendation,
        confidenceInterval: recommendationResult.confidenceInterval,
        confidenceStatus: recommendationResult.confidenceStatus,
        calibrationStatus: recommendationResult.calibrationStatus,
        supportingSampleSize: recommendationResult.supportingSampleSize,
        modelVersion: recommendationResult.modelVersion,
        reasons: recommendationResult.reasons,
      },
      featureVector: features,
      generatedAt: new Date().toISOString(),
      disclaimer:
        'Decision-support ML probability model. Does not determine position sizing or replace deterministic SMC invalidation levels.',
    };
  }

  /**
   * 5. GET /api/ai-learning/insights
   */
  async getInsights(): Promise<any> {
    const activeModel = this.registry.getActiveModel() || new TradePredictionModel('v1.0.0-PROD');
    const featureImportance = activeModel.getFeatureImportance();

    const activeState = this.registry.getActiveVersionState();
    const calibration = activeState?.calibrationReport || null;

    const completedTrades = await this.prisma.paperTrade.findMany({
      orderBy: { exitTime: 'desc' },
      take: 200,
    });

    const verifiedTrades = completedTrades.filter(
      (t) =>
        t.realizedR !== null &&
        t.entryPrice !== null &&
        t.entryTime !== null &&
        (t.outcomeSnapshotJson as any)?.executionDataComplete !== false &&
        (t.outcomeSnapshotJson as any)?.isLegacyExecutionData !== true,
    );

    if (verifiedTrades.length === 0) {
      return {
        status: 'NO_DATA',
        modelVersion: activeModel.modelVersion,
        featureImportance,
        performanceByRegime: [],
        performanceByAsset: [],
        performanceByTimeframe: [],
        postMortemPatterns: [],
        recentPostMortems: [],
        calibration,
      };
    }

    // Compute real performance by asset from verified database records
    const assetMap = new Map<string, { wins: number; total: number; totalR: number }>();
    for (const t of verifiedTrades) {
      const entry = assetMap.get(t.symbol) || { wins: 0, total: 0, totalR: 0 };
      entry.total += 1;
      const r = Number(t.realizedR);
      if (r > 0) entry.wins += 1;
      entry.totalR += r;
      assetMap.set(t.symbol, entry);
    }
    const performanceByAsset = Array.from(assetMap.entries()).map(([asset, data]) => ({
      asset,
      winRate: Number(((data.wins / data.total) * 100).toFixed(1)),
      trades: data.total,
      avgR: `${data.totalR >= 0 ? '+' : ''}${(data.totalR / data.total).toFixed(2)}R`,
    }));

    // Compute real performance by outcome classification from verified database records
    const regimeMap = new Map<string, { wins: number; total: number; totalR: number }>();
    for (const t of verifiedTrades) {
      const regime = t.outcomeClassification || 'STANDARD';
      const entry = regimeMap.get(regime) || { wins: 0, total: 0, totalR: 0 };
      entry.total += 1;
      const r = Number(t.realizedR);
      if (r > 0) entry.wins += 1;
      entry.totalR += r;
      regimeMap.set(regime, entry);
    }
    const performanceByRegime = Array.from(regimeMap.entries()).map(([regime, data]) => ({
      regime,
      winRate: Number(((data.wins / data.total) * 100).toFixed(1)),
      sampleSize: data.total,
      expectancyR: `${data.totalR >= 0 ? '+' : ''}${(data.totalR / data.total).toFixed(2)}R`,
    }));

    const recentPostMortems = await this.getRecentPostMortems();

    return {
      status: 'AUTHENTIC_DATA',
      modelVersion: activeModel.modelVersion,
      featureImportance,
      performanceByRegime,
      performanceByAsset,
      performanceByTimeframe: [],
      postMortemPatterns: [],
      recentPostMortems,
      calibration,
    };
  }

  /**
   * Retrieves recent trade-level post-mortem audit records from real database trades.
   */
  public async getRecentPostMortems(): Promise<any[]> {
    const trades = await this.prisma.paperTrade.findMany({
      where: {
        entryPrice: { not: null },
        entryTime: { not: null },
        realizedPnL: { not: null },
        realizedR: { not: null },
      },
      take: 20,
      orderBy: { exitTime: 'desc' },
    });

    const verifiedTrades = trades.filter(
      (t) =>
        (t.outcomeSnapshotJson as any)?.executionDataComplete !== false &&
        (t.outcomeSnapshotJson as any)?.isLegacyExecutionData !== true,
    );

    if (verifiedTrades.length === 0) {
      return [];
    }

    return verifiedTrades.map((t) => {
      const entryPrice = Number(t.entryPrice);
      const exitPrice = Number(t.exitPrice);
      const realizedR = Number(t.realizedR);
      const mfeR = Number(t.maxFavorableExcursion);
      const maeR = Number(t.maxAdverseExcursion);

      return {
        symbol: t.symbol,
        direction: t.direction,
        entryPrice,
        exitPrice,
        outcome: t.outcomeClassification || (realizedR > 0 ? 'TP_HIT' : 'SL_HIT'),
        realizedRMultiple: realizedR,
        mfeR,
        maeR,
        timeToResolutionMinutes: t.holdingDurationSeconds !== null ? Math.floor(t.holdingDurationSeconds / 60) : 0,
        exitTimestamp: t.exitTime,
        classification: t.outcomeClassification || (realizedR > 0 ? 'TARGET_ACHIEVED' : 'STOP_HIT'),
        classificationRationale: t.exitReason,
        marketRegime: 'AUTHENTIC',
        keyContributingFactors: [{ factor: 'Execution Outcome', impact: t.exitReason }],
      };
    });
  }

  /**
   * 6. Live Trade Outcome Hook: Performs single-step online SGD learning & logs post-mortem using persisted snapshots.
   */
  public async recordTradeOutcomeAndOnlineUpdate(trade: {
    symbol: string;
    direction: 'BUY' | 'SELL' | 'BULLISH' | 'BEARISH';
    entryPrice: number | null;
    exitPrice: number;
    stopLoss?: number | null;
    target?: number | null;
    entryTimestamp: Date | null;
    exitTimestamp: Date;
    exitReason?: string;
    realizedR?: number | null;
    featureSnapshotJson?: any;
    outcomeSnapshotJson?: any;
  }): Promise<{ updateResult: any; postMortem: any; skippedReason?: string }> {
    const isBull = trade.direction === 'BUY' || trade.direction === 'BULLISH';
    const sym = trade.symbol.toUpperCase();

    // Strict guard: NEVER learn from incomplete or legacy execution data
    const outcome = trade.outcomeSnapshotJson || {};
    const isIncompleteExecution =
      trade.entryPrice === null ||
      trade.entryPrice === undefined ||
      trade.entryTimestamp === null ||
      trade.entryTimestamp === undefined ||
      trade.realizedR === null ||
      trade.realizedR === undefined ||
      outcome.executionDataComplete === false ||
      outcome.isLegacyExecutionData === true;

    if (isIncompleteExecution) {
      const skippedReason = 'INCOMPLETE_OR_LEGACY_EXECUTION_DATA';
      this.logger.warn(
        `[OnlineLearning] Skipped online learning update for ${sym}: ${skippedReason} (entryPrice=${trade.entryPrice}, entryTime=${trade.entryTimestamp}, realizedR=${trade.realizedR})`,
      );
      return { updateResult: null, postMortem: null, skippedReason };
    }

    const activeModel = this.registry.getActiveModel() || new TradePredictionModel('v1.0.0-PROD');

    // Consume persisted feature snapshot directly without lookahead bias
    const features: any = trade.featureSnapshotJson;
    let updateResult: any = null;
    let skippedReason: string | undefined = undefined;

    const isWin =
      trade.outcomeSnapshotJson?.realizedPnL !== undefined && trade.outcomeSnapshotJson?.realizedPnL !== null
        ? trade.outcomeSnapshotJson.realizedPnL > 0
        : trade.realizedR! > 0;

    if (!features) {
      skippedReason = 'ONLINE_LEARNING_SKIPPED_MISSING_FEATURE_SNAPSHOT';
      this.logger.warn(
        `[OnlineLearning] Skipped online learning update for ${sym}: ${skippedReason}`,
      );
    } else {
      updateResult = this.onlineLearningEngine.updateModel(activeModel, {
        symbol: sym,
        features,
        featureSchemaVersion: FEATURE_SCHEMA_VERSION,
        actualLabel: isWin ? 1 : 0,
      });

      // Update in-memory registry with new model state
      const currentActiveState = this.registry.getActiveVersionState();
      if (currentActiveState) {
        currentActiveState.weights = activeModel.getWeights();
        currentActiveState.bias = activeModel.getBias();
        currentActiveState.updatedAt = new Date();
      }
    }

    const postMortem = {
      symbol: sym,
      direction: isBull ? 'BULLISH' : 'BEARISH',
      entryPrice: trade.entryPrice,
      exitPrice: trade.exitPrice,
      realizedR: trade.realizedR,
      outcome: isWin ? 'WIN_TP' : 'LOSS_SL',
      classification:
        trade.outcomeSnapshotJson?.outcomeClassification ||
        (isWin ? 'TARGET_ACHIEVED' : 'STOP_HIT'),
      exitReason: trade.exitReason || 'Closed',
    };

    this.recentPostMortems.unshift(postMortem as any);
    if (this.recentPostMortems.length > 20) this.recentPostMortems.pop();

    if (updateResult) {
      this.logger.log(
        `Online learning updated weights for ${sym} (${isWin ? 'WIN' : 'LOSS'}) from persisted snapshot - Delta Norm: ${updateResult.weightDeltaNorm}`,
      );
    }

    return { updateResult, postMortem, skippedReason };
  }

  /**
   * Loads a PaperTrade by ID and directly learns from its persisted snapshots without querying candles.
   */
  public async learnFromPersistedTrade(tradeId: string): Promise<{ updateResult: any; postMortem: any; skippedReason?: string }> {
    const trade = await this.prisma.paperTrade.findUnique({
      where: { id: tradeId },
    });
    if (!trade) {
      throw new NotFoundException(`PaperTrade '${tradeId}' not found`);
    }

    const outcome = (trade.outcomeSnapshotJson as any) || {};
    if (
      trade.entryPrice === null ||
      trade.entryTime === null ||
      trade.realizedR === null ||
      outcome.executionDataComplete === false ||
      outcome.isLegacyExecutionData === true
    ) {
      const skippedReason = 'INCOMPLETE_OR_LEGACY_EXECUTION_DATA';
      this.logger.warn(
        `[AI LEARNING SKIPPED] Trade '${tradeId}' has incomplete/legacy execution data; excluding from model updates`,
      );
      return { updateResult: null, postMortem: null, skippedReason };
    }

    return this.recordTradeOutcomeAndOnlineUpdate({
      symbol: trade.symbol,
      direction: trade.direction === 'BULLISH' ? 'BUY' : 'SELL',
      entryPrice: Number(trade.entryPrice),
      exitPrice: Number(trade.exitPrice),
      entryTimestamp: trade.entryTime,
      exitTimestamp: trade.exitTime,
      exitReason: trade.exitReason,
      realizedR: Number(trade.realizedR),
      featureSnapshotJson: trade.featureSnapshotJson,
      outcomeSnapshotJson: trade.outcomeSnapshotJson,
    });
  }
}
