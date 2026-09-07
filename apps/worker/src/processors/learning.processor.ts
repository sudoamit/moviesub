import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { BULLMQ_QUEUES, ICandle } from '@quant/shared';
import {
  TradePredictionModel,
  ChronologicalSplitter,
  ModelPromotionEngine,
  ProbabilityCalibrationEngine,
  FeatureVectorExtractor,
  TradeLabelGenerator,
  AmbiguousLabelPolicy,
  TrainingExample,
  TrainingDatasetBuilder,
  FEATURE_SCHEMA_VERSION,
  SignalGenerator,
} from '@quant/trading-engine';
import { PrismaService } from '../prisma.service';
import { RedisService } from '../redis.service';

@Processor(BULLMQ_QUEUES.LEARNING_TASKS)
export class LearningProcessor extends WorkerHost {
  private readonly logger = new Logger(LearningProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {
    super();
  }

  async process(job: Job<any, any, string>): Promise<any> {
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
  private async executeRetrainPipeline(jobId: string, triggerReason: string) {
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
        throw new Error(
          `Insufficient historical observations (${dataset.length} < 30) to train model safely.`,
        );
      }

      // 2. Chronological Split (Train 60%, Validation 20%, Out-of-Sample 20%)
      const splits = ChronologicalSplitter.split(dataset, {
        trainRatio: 0.6,
        validationRatio: 0.2,
        outOfSampleRatio: 0.2,
      });

      const candidateVersion = `v1.${Date.now().toString().slice(-4)}.0`;
      const candidateModel = new TradePredictionModel(candidateVersion, {
        learningRate: 0.08,
        batchSize: 16,
        maxEpochs: 70,
      });

      // 3. Train candidate model on train partition
      const trainMetrics = candidateModel.train(splits.train);

      // 4. Evaluate on out-of-sample partition
      const outOfSampleMetrics = candidateModel.evaluate(splits.outOfSample);

      // 5. Model Promotion Assessment
      const promotionDecision = ModelPromotionEngine.evaluatePromotion(
        candidateModel,
        splits.outOfSample,
        null,
        { minSampleSize: 15 },
      );

      // 6. Compute calibration on validation + out of sample
      const evalData = [...splits.validation, ...splits.outOfSample];
      const calibrationItems = evalData.map((d) => ({
        predictedProb: candidateModel.predictProbability(d.features),
        actualLabel: d.label,
      }));
      const calibrationReport = ProbabilityCalibrationEngine.generateCalibrationReport(
        calibrationItems,
        10,
      );

      // 7. Persist completion in PostgreSQL
      if (jobId) {
        await this.prisma.aIRetrainJob.update({
          where: { id: jobId },
          data: {
            status: 'COMPLETED',
            samplesCount: dataset.length,
            trainMetricsJson: trainMetrics as any,
            validationMetricsJson: outOfSampleMetrics as any,
            promoted: promotionDecision.isPromoted,
            rejectionReason: promotionDecision.isPromoted
              ? null
              : promotionDecision.reasons.join('; '),
            completedAt: new Date(),
          },
        });
      }

      this.logger.log(
        `✓ [LearningProcessor] Retrain Job ${jobId} Completed. Candidate: ${candidateVersion} | Accuracy: ${(outOfSampleMetrics.accuracy * 100).toFixed(1)}% | Promoted: ${promotionDecision.isPromoted}`,
      );

      return {
        jobId,
        candidateVersion,
        isPromoted: promotionDecision.isPromoted,
        trainMetrics,
        outOfSampleMetrics,
        calibrationReport,
      };
    } catch (err: any) {
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
        } catch {}
      }
      throw err;
    }
  }

  /**
   * Builds an authentic training dataset from multi-asset candles without lookahead bias.
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
}

