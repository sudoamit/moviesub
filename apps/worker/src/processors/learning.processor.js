"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var LearningProcessor_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.LearningProcessor = void 0;
const bullmq_1 = require("@nestjs/bullmq");
const common_1 = require("@nestjs/common");
const shared_1 = require("@quant/shared");
const trading_engine_1 = require("@quant/trading-engine");
const prisma_service_1 = require("../prisma.service");
const redis_service_1 = require("../redis.service");
let LearningProcessor = LearningProcessor_1 = class LearningProcessor extends bullmq_1.WorkerHost {
    prisma;
    redis;
    logger = new common_1.Logger(LearningProcessor_1.name);
    constructor(prisma, redis) {
        super();
        this.prisma = prisma;
        this.redis = redis;
    }
    async process(job) {
        this.logger.log(`Processing async learning job ${job.id} [${job.name}]...`);
        switch (job.name) {
            case 'RETRAIN_MODEL': {
                const jobId = job.data?.jobId;
                const triggerReason = job.data?.triggerReason || 'MANUAL';
                return this.executeRetrainPipeline(jobId, triggerReason);
            }
            default:
                this.logger.warn(`Unknown job name '${job.name}' received in LearningProcessor`);
                return { status: 'IGNORED' };
        }
    }
    /**
     * Executes the full walk-forward supervised training pipeline inside the background worker.
     */
    async executeRetrainPipeline(jobId, triggerReason) {
        this.logger.log(`[LearningProcessor] Starting walk-forward retraining job ${jobId} (${triggerReason})...`);
        try {
            if (jobId) {
                await this.prisma.aIRetrainJob.update({
                    where: { id: jobId },
                    data: { status: 'RUNNING', startedAt: new Date() },
                });
            }
            // 1. Build authentic chronological training dataset from multi-asset candles
            const dataset = await this.buildTrainingDataset();
            if (dataset.length < 30) {
                throw new Error(`Insufficient historical observations (${dataset.length} < 30) to train model safely.`);
            }
            // 2. Chronological Split (Train 60%, Validation 20%, Out-of-Sample 20%)
            const splits = trading_engine_1.ChronologicalSplitter.split(dataset, {
                trainRatio: 0.6,
                validationRatio: 0.2,
                outOfSampleRatio: 0.2,
            });
            const candidateVersion = `v1.${Date.now().toString().slice(-4)}.0`;
            const candidateModel = new trading_engine_1.TradePredictionModel(candidateVersion, {
                learningRate: 0.08,
                batchSize: 16,
                maxEpochs: 70,
            });
            // 3. Train candidate model on train partition
            const trainMetrics = candidateModel.train(splits.train);
            // 4. Evaluate on out-of-sample partition
            const outOfSampleMetrics = candidateModel.evaluate(splits.outOfSample);
            // 5. Model Promotion Assessment
            const promotionDecision = trading_engine_1.ModelPromotionEngine.evaluatePromotion(candidateModel, splits.outOfSample, null, { minSampleSize: 15 });
            // 6. Compute calibration on validation + out of sample
            const evalData = [...splits.validation, ...splits.outOfSample];
            const calibrationItems = evalData.map((d) => ({
                predictedProb: candidateModel.predictProbability(d.features),
                actualLabel: d.label,
            }));
            const calibrationReport = trading_engine_1.ProbabilityCalibrationEngine.generateCalibrationReport(calibrationItems, 10);
            // 7. Persist completion in PostgreSQL
            if (jobId) {
                await this.prisma.aIRetrainJob.update({
                    where: { id: jobId },
                    data: {
                        status: 'COMPLETED',
                        samplesCount: dataset.length,
                        trainMetricsJson: trainMetrics,
                        validationMetricsJson: outOfSampleMetrics,
                        promoted: promotionDecision.isPromoted,
                        rejectionReason: promotionDecision.isPromoted
                            ? null
                            : promotionDecision.reasons.join('; '),
                        completedAt: new Date(),
                    },
                });
            }
            this.logger.log(`✓ [LearningProcessor] Retrain Job ${jobId} Completed. Candidate: ${candidateVersion} | Accuracy: ${(outOfSampleMetrics.accuracy * 100).toFixed(1)}% | Promoted: ${promotionDecision.isPromoted}`);
            return {
                jobId,
                candidateVersion,
                isPromoted: promotionDecision.isPromoted,
                trainMetrics,
                outOfSampleMetrics,
                calibrationReport,
            };
        }
        catch (err) {
            this.logger.error(`[LearningProcessor] Retrain Job ${jobId} Failed: ${err.message}`, err.stack);
            if (jobId) {
                try {
                    await this.prisma.aIRetrainJob.update({
                        where: { id: jobId },
                        data: {
                            status: 'FAILED',
                            errorMessage: err.message,
                            completedAt: new Date(),
                        },
                    });
                }
                catch { }
            }
            throw err;
        }
    }
    /**
     * Builds an authentic training dataset from multi-asset candles without lookahead bias.
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
};
exports.LearningProcessor = LearningProcessor;
exports.LearningProcessor = LearningProcessor = LearningProcessor_1 = __decorate([
    (0, bullmq_1.Processor)(shared_1.BULLMQ_QUEUES.LEARNING_TASKS),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        redis_service_1.RedisService])
], LearningProcessor);
//# sourceMappingURL=learning.processor.js.map