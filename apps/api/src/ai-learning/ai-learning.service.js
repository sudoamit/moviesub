"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var AILearningService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.AILearningService = exports.PredictTradeDto = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../common/prisma/prisma.service");
const signals_service_1 = require("../signals/signals.service");
const smc_service_1 = require("../smc/smc.service");
const accuracy_service_1 = require("../accuracy/accuracy.service");
const trading_engine_1 = require("@quant/trading-engine");
const class_validator_1 = require("class-validator");
const crypto = __importStar(require("crypto"));
const bullmq_1 = require("bullmq");
const shared_1 = require("@quant/shared");
class PredictTradeDto {
    symbol;
    timeframe;
    signalId;
}
exports.PredictTradeDto = PredictTradeDto;
__decorate([
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], PredictTradeDto.prototype, "symbol", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], PredictTradeDto.prototype, "timeframe", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], PredictTradeDto.prototype, "signalId", void 0);
let AILearningService = AILearningService_1 = class AILearningService {
    prisma;
    signalsService;
    smcService;
    accuracyService;
    logger = new common_1.Logger(AILearningService_1.name);
    registry = new trading_engine_1.ModelRegistry();
    retrainJobs = new Map();
    retrainQueue = null;
    onlineLearningEngine = new trading_engine_1.OnlineLearningEngine({
        learningRate: 0.005,
        maxWeightChangeNorm: 0.05,
    });
    recentPostMortems = [];
    constructor(prisma, signalsService, smcService, accuracyService) {
        this.prisma = prisma;
        this.signalsService = signalsService;
        this.smcService = smcService;
        this.accuracyService = accuracyService;
    }
    async onModuleInit() {
        await this.initializeModelRegistry();
        try {
            const host = process.env.REDIS_HOST || 'localhost';
            const port = Number(process.env.REDIS_PORT) || 6380;
            const password = process.env.REDIS_PASSWORD || undefined;
            this.retrainQueue = new bullmq_1.Queue(shared_1.BULLMQ_QUEUES.LEARNING_TASKS, {
                connection: { host, port, password },
            });
            this.logger.log('BullMQ AI Retraining Queue connected.');
        }
        catch (e) {
            this.logger.warn(`BullMQ Queue init deferred: ${e.message}`);
        }
    }
    /**
     * Initializes or bootstraps the active production model from the database.
     */
    async initializeModelRegistry() {
        try {
            // Find active model in database
            const dbModel = await this.prisma.aIModel.findFirst({
                where: { name: 'Institutional SMC Trade Predictor' },
                include: { activeVersion: true, versions: true },
            });
            if (dbModel && dbModel.activeVersion) {
                const v = dbModel.activeVersion;
                const weights = Array.isArray(v.weightsJson) ? v.weightsJson : [];
                const metrics = v.metricsJson || {};
                const activeModel = new trading_engine_1.TradePredictionModel(v.version, v.hyperparametersJson || {}, weights, v.bias);
                this.registry.registerVersion(trading_engine_1.ModelPersistenceManager.serialize(activeModel, {
                    status: 'ACTIVE',
                    metrics,
                    trainingExampleCount: v.trainingExampleCount,
                    validationExampleCount: v.validationExampleCount,
                    outOfSampleExampleCount: v.outOfSampleExampleCount,
                }));
                this.logger.log(`Hydrated active AI model version '${v.version}' from database.`);
                return;
            }
            // Initial Bootstrap: Seed Baseline v1.0.0
            await this.bootstrapBaselineModel();
        }
        catch (e) {
            this.logger.warn(`Database model initialization deferred, starting with in-memory baseline: ${e}`);
            this.bootstrapBaselineModelInMemory();
        }
    }
    bootstrapBaselineModelInMemory() {
        const baselineModel = new trading_engine_1.TradePredictionModel('v1.0.0-PROD');
        const state = trading_engine_1.ModelPersistenceManager.serialize(baselineModel, {
            status: 'CANDIDATE',
            metrics: null,
            trainingExampleCount: 0,
            validationExampleCount: 0,
            outOfSampleExampleCount: 0,
        });
        this.registry.registerVersion(state);
    }
    async bootstrapBaselineModel() {
        const baselineModel = new trading_engine_1.TradePredictionModel('v1.0.0-PROD');
        const state = trading_engine_1.ModelPersistenceManager.serialize(baselineModel, {
            status: 'CANDIDATE',
            metrics: null,
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
                    description: 'Supervised Logistic Regression predicting TP vs SL probability from SMC feature vectors.',
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
                    featureSchemaVersion: trading_engine_1.FEATURE_SCHEMA_VERSION,
                    status: 'CANDIDATE',
                    weightsJson: state.weights,
                    bias: state.bias,
                    hyperparametersJson: state.hyperparameters,
                    metricsJson: null,
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
            this.logger.log(`Initialized baseline AI model version '${dbVersion.version}' in database as UNTRAINED.`);
        }
        catch (e) {
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
                featureSchemaVersion: trading_engine_1.FEATURE_SCHEMA_VERSION,
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
                totalExamples: activeVersionState.trainingExampleCount +
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
            featureSchemaVersion: trading_engine_1.FEATURE_SCHEMA_VERSION,
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
    async startRetrainJob() {
        const jobId = `job_${crypto.randomUUID().slice(0, 8)}`;
        const jobStatus = {
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
        }
        catch (e) {
            this.logger.warn(`Failed to create AIRetrainJob in DB: ${e.message}`);
        }
        // Offload execution to BullMQ worker
        try {
            if (this.retrainQueue) {
                await this.retrainQueue.add('RETRAIN_MODEL', { jobId, triggerReason: 'MANUAL' });
                this.logger.log(`Enqueued retrain job ${jobId} to BullMQ queue '${shared_1.BULLMQ_QUEUES.LEARNING_TASKS}'`);
            }
        }
        catch (e) {
            this.logger.error(`Failed to push job to BullMQ queue: ${e.message}`);
        }
        return {
            jobId,
            status: 'PENDING',
            message: 'Walk-forward training job initiated in BullMQ worker. Poll /api/ai-learning/retrain/:jobId for status.',
        };
    }
    /**
     * 3. GET /api/ai-learning/retrain/:jobId
     */
    async getRetrainJobStatus(jobId) {
        const job = this.retrainJobs.get(jobId);
        if (job && job.status === 'RUNNING')
            return job;
        try {
            const dbJob = await this.prisma.aIRetrainJob.findUnique({ where: { id: jobId } });
            if (dbJob) {
                return {
                    jobId: dbJob.id,
                    status: dbJob.status,
                    progressPercent: dbJob.status === 'COMPLETED' ? 100 : dbJob.status === 'FAILED' ? 0 : 50,
                    stage: dbJob.status === 'COMPLETED' ? 'Completed' : dbJob.status === 'RUNNING' ? 'Running in Worker' : dbJob.status,
                    isPromoted: dbJob.promoted,
                    metrics: dbJob.validationMetricsJson || null,
                    error: dbJob.errorMessage || undefined,
                    startedAt: dbJob.startedAt || dbJob.createdAt,
                    completedAt: dbJob.completedAt || undefined,
                };
            }
        }
        catch { }
        if (job)
            return job;
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
    async buildTrainingDataset() {
        const symbols = ['NIFTY', 'BANKNIFTY', 'BTCUSDT', 'RELIANCE', 'HDFCBANK', 'INFY'];
        const examples = [];
        for (const sym of symbols) {
            try {
                const inst = await this.prisma.instrument.findUnique({ where: { symbol: sym } });
                if (!inst)
                    continue;
                const candles = await this.prisma.candle.findMany({
                    where: { instrumentId: inst.id, timeframe: 'M15' },
                    orderBy: { timestamp: 'asc' },
                    take: 120,
                });
                if (candles.length < 35)
                    continue;
                const parsedCandles = candles.map((c) => ({
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
                    const realSignal = trading_engine_1.SignalGenerator.generateSignal({
                        symbol: sym,
                        executionCandles: histCandles,
                        executionTimeframe: '15m',
                        htf1Candles: histCandles,
                    });
                    if (realSignal.direction === 'NEUTRAL' || realSignal.score < 60)
                        continue;
                    const features = trading_engine_1.FeatureVectorExtractor.extract({
                        signal: realSignal,
                        candles: histCandles,
                        asOfTimestamp: new Date(entryCandle.timestamp),
                    });
                    const outcome = trading_engine_1.TradeLabelGenerator.evaluateOutcome({
                        direction: realSignal.direction,
                        entryPrice: realSignal.entryZone.optimal,
                        stopLoss: realSignal.stopLoss,
                        targetPrice: realSignal.takeProfits.tp2,
                        entryTimestamp: new Date(entryCandle.timestamp),
                        subsequentCandles,
                        ambiguousPolicy: trading_engine_1.AmbiguousLabelPolicy.AMBIGUOUS,
                    });
                    if (outcome && outcome.label !== null) {
                        examples.push({
                            id: `ex_${sym}_${i}`,
                            symbol: sym,
                            featureSchemaVersion: trading_engine_1.FEATURE_SCHEMA_VERSION,
                            features,
                            featureArray: trading_engine_1.FeatureVectorExtractor.toArray(features),
                            label: outcome.label,
                            outcomeR: outcome.realizedRMultiple,
                            predictionTimestamp: new Date(entryCandle.timestamp),
                            availableForTrainingAt: outcome.exitTimestamp,
                        });
                    }
                }
            }
            catch (e) {
                this.logger.warn(`Error compiling training data for ${sym}: ${e}`);
            }
        }
        return trading_engine_1.TrainingDatasetBuilder.sortChronologically(examples);
    }
    /**
     * 4. POST /api/ai-learning/predict
     * Strictly evaluates the authentic structured setup from the trading engine (never client arbitrary numbers).
     */
    async predictTrade(dto) {
        const sym = (dto.symbol || 'NIFTY').toUpperCase();
        const tf = (dto.timeframe || '15m');
        const signal = await this.signalsService.generateSignalForSymbol(sym, tf);
        const smc = await this.smcService.getSMCAnalysis(sym, tf);
        // Fetch candles point-in-time
        const inst = await this.prisma.instrument.findUnique({ where: { symbol: sym } });
        let candles = [];
        if (inst) {
            const rows = await this.prisma.candle.findMany({
                where: { instrumentId: inst.id, timeframe: 'M15' },
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
        const features = trading_engine_1.FeatureVectorExtractor.extract({
            signal,
            candles,
            smcAnalysis: smc,
            asOfTimestamp: signal.timestamp ? new Date(signal.timestamp) : new Date(),
        });
        // 2. Predict with Active Model
        const model = this.registry.getActiveModel() || new trading_engine_1.TradePredictionModel('v1.0.0-PROD');
        const predResult = model.predict(features);
        // 3. Expected Value & Recommendation
        const payoff = {
            targetR: signal.riskRewardRatios?.rr2 || 2.0,
            lossR: 1.0,
        };
        const activeState = this.registry.getActiveVersionState();
        const supportingSampleSize = activeState?.metrics?.sampleSize ?? 0;
        const calibrationStatus = activeState?.calibrationReport?.status;
        const recommendationResult = trading_engine_1.ExpectedValueEngine.evaluateRecommendation({
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
            disclaimer: 'Decision-support ML probability model. Does not determine position sizing or replace deterministic SMC invalidation levels.',
        };
    }
    /**
     * 5. GET /api/ai-learning/insights
     */
    async getInsights() {
        const activeModel = this.registry.getActiveModel() || new trading_engine_1.TradePredictionModel('v1.0.0-PROD');
        const featureImportance = activeModel.getFeatureImportance();
        const activeState = this.registry.getActiveVersionState();
        const calibration = activeState?.calibrationReport || null;
        const completedTrades = await this.prisma.paperTrade.findMany({
            orderBy: { exitTime: 'desc' },
            take: 200,
        });
        if (completedTrades.length === 0) {
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
        // Compute real performance by asset from actual database records
        const assetMap = new Map();
        for (const t of completedTrades) {
            const entry = assetMap.get(t.symbol) || { wins: 0, total: 0, totalR: 0 };
            entry.total += 1;
            const r = Number(t.realizedR);
            if (r > 0)
                entry.wins += 1;
            entry.totalR += r;
            assetMap.set(t.symbol, entry);
        }
        const performanceByAsset = Array.from(assetMap.entries()).map(([asset, data]) => ({
            asset,
            winRate: Number(((data.wins / data.total) * 100).toFixed(1)),
            trades: data.total,
            avgR: `${data.totalR >= 0 ? '+' : ''}${(data.totalR / data.total).toFixed(2)}R`,
        }));
        // Compute real performance by outcome classification from actual database records
        const regimeMap = new Map();
        for (const t of completedTrades) {
            const regime = t.outcomeClassification || 'STANDARD';
            const entry = regimeMap.get(regime) || { wins: 0, total: 0, totalR: 0 };
            entry.total += 1;
            const r = Number(t.realizedR);
            if (r > 0)
                entry.wins += 1;
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
    async getRecentPostMortems() {
        const trades = await this.prisma.paperTrade.findMany({
            take: 20,
            orderBy: { exitTime: 'desc' },
        });
        if (trades.length === 0) {
            return [];
        }
        return trades.map((t) => {
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
                timeToResolutionMinutes: Math.floor(t.holdingDurationSeconds / 60),
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
    async recordTradeOutcomeAndOnlineUpdate(trade) {
        const isBull = trade.direction === 'BUY' || trade.direction === 'BULLISH';
        const sym = trade.symbol.toUpperCase();
        const activeModel = this.registry.getActiveModel() || new trading_engine_1.TradePredictionModel('v1.0.0-PROD');
        // 1. Consume persisted feature snapshot directly without lookahead bias
        const features = trade.featureSnapshotJson;
        let updateResult = null;
        let skippedReason = undefined;
        const isWin = trade.outcomeSnapshotJson?.realizedPnL !== undefined
            ? trade.outcomeSnapshotJson.realizedPnL > 0
            : trade.realizedR !== undefined
                ? trade.realizedR > 0
                : isBull
                    ? trade.exitPrice > trade.entryPrice
                    : trade.entryPrice > trade.exitPrice;
        if (!features) {
            skippedReason = 'ONLINE_LEARNING_SKIPPED_MISSING_FEATURE_SNAPSHOT';
            this.logger.warn(`[OnlineLearning] Skipped online learning update for ${sym}: ${skippedReason}`);
        }
        else {
            updateResult = this.onlineLearningEngine.updateModel(activeModel, {
                symbol: sym,
                features,
                featureSchemaVersion: trading_engine_1.FEATURE_SCHEMA_VERSION,
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
            realizedR: trade.realizedR ?? trade.outcomeSnapshotJson?.realizedR ?? 0.0,
            outcome: isWin ? 'WIN_TP' : 'LOSS_SL',
            classification: trade.outcomeSnapshotJson?.outcomeClassification ||
                (isWin ? 'TARGET_ACHIEVED' : 'STOP_HIT'),
            exitReason: trade.exitReason || 'Closed',
        };
        this.recentPostMortems.unshift(postMortem);
        if (this.recentPostMortems.length > 20)
            this.recentPostMortems.pop();
        if (updateResult) {
            this.logger.log(`Online learning updated weights for ${sym} (${isWin ? 'WIN' : 'LOSS'}) from persisted snapshot - Delta Norm: ${updateResult.weightDeltaNorm}`);
        }
        return { updateResult, postMortem, skippedReason };
    }
    /**
     * Loads a PaperTrade by ID and directly learns from its persisted snapshots without querying candles.
     */
    async learnFromPersistedTrade(tradeId) {
        const trade = await this.prisma.paperTrade.findUnique({
            where: { id: tradeId },
        });
        if (!trade) {
            throw new common_1.NotFoundException(`PaperTrade '${tradeId}' not found`);
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
};
exports.AILearningService = AILearningService;
exports.AILearningService = AILearningService = AILearningService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        signals_service_1.SignalsService,
        smc_service_1.SMCService,
        accuracy_service_1.AccuracyService])
], AILearningService);
//# sourceMappingURL=ai-learning.service.js.map