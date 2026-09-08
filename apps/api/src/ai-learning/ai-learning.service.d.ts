import { OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { SignalsService } from '../signals/signals.service';
import { SMCService } from '../smc/smc.service';
import { AccuracyService } from '../accuracy/accuracy.service';
import { ICalibrationReport, EvaluationMetrics } from '@quant/trading-engine';
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
export declare class PredictTradeDto {
    symbol: string;
    timeframe?: string;
    signalId?: string;
}
export declare class AILearningService implements OnModuleInit {
    private readonly prisma;
    private readonly signalsService;
    private readonly smcService;
    private readonly accuracyService;
    private readonly logger;
    private readonly registry;
    private readonly retrainJobs;
    private retrainQueue;
    private readonly onlineLearningEngine;
    private recentPostMortems;
    constructor(prisma: PrismaService, signalsService: SignalsService, smcService: SMCService, accuracyService: AccuracyService);
    onModuleInit(): Promise<void>;
    /**
     * Initializes or bootstraps the active production model from the database.
     */
    private initializeModelRegistry;
    private bootstrapBaselineModelInMemory;
    private bootstrapBaselineModel;
    /**
     * 1. GET /api/ai-learning/model-state
     * Returns active model version, metrics, features count, schema version, and all registered model versions.
     */
    getModelState(): {
        modelVersion: string;
        status: string;
        isTrained: boolean;
        trainedAt: null;
        datasetStats: {
            trainingExamples: number;
            validationExamples: number;
            outOfSampleExamples: number;
            totalExamples: number;
        };
        metrics: null;
        calibration: null;
        featureCount: number;
        featureSchemaVersion: string;
        allVersions: {
            version: string;
            status: "ACTIVE" | "REJECTED" | "CANDIDATE" | "ARCHIVED";
            createdAt: Date;
            accuracy: number;
            logLoss: number;
        }[];
    } | {
        modelVersion: string;
        status: "ACTIVE" | "REJECTED" | "CANDIDATE" | "ARCHIVED";
        isTrained: boolean;
        trainedAt: Date;
        datasetStats: {
            trainingExamples: number;
            validationExamples: number;
            outOfSampleExamples: number;
            totalExamples: number;
        };
        metrics: {
            accuracy: number;
            precision: number;
            recall: number;
            f1Score: number;
            brierScore: number;
            logLoss: number;
            rocAuc: number;
            profitFactor: number;
            expectancyR: number;
        };
        calibration: ICalibrationReport | null | undefined;
        featureCount: number;
        featureSchemaVersion: string;
        allVersions: {
            version: string;
            status: "ACTIVE" | "REJECTED" | "CANDIDATE" | "ARCHIVED";
            createdAt: Date;
            accuracy: number;
            logLoss: number;
        }[];
    };
    /**
     * 2. POST /api/ai-learning/retrain (Enqueues job to BullMQ worker)
     */
    startRetrainJob(): Promise<{
        jobId: string;
        status: string;
        message: string;
    }>;
    /**
     * 3. GET /api/ai-learning/retrain/:jobId
     */
    getRetrainJobStatus(jobId: string): Promise<IRetrainJobStatus>;
    /**
     * Builds an authentic training dataset from multi-asset candles and completed trades.
     */
    private buildTrainingDataset;
    /**
     * 4. POST /api/ai-learning/predict
     * Strictly evaluates the authentic structured setup from the trading engine (never client arbitrary numbers).
     */
    predictTrade(dto: PredictTradeDto): Promise<any>;
    /**
     * 5. GET /api/ai-learning/insights
     */
    getInsights(): Promise<any>;
    /**
     * Retrieves recent trade-level post-mortem audit records from real database trades.
     */
    getRecentPostMortems(): Promise<any[]>;
    /**
     * 6. Live Trade Outcome Hook: Performs single-step online SGD learning & logs post-mortem using persisted snapshots.
     */
    recordTradeOutcomeAndOnlineUpdate(trade: {
        symbol: string;
        direction: 'BUY' | 'SELL' | 'BULLISH' | 'BEARISH';
        entryPrice: number;
        exitPrice: number;
        stopLoss?: number;
        target?: number;
        entryTimestamp: Date;
        exitTimestamp: Date;
        exitReason?: string;
        realizedR?: number;
        featureSnapshotJson?: any;
        outcomeSnapshotJson?: any;
    }): Promise<{
        updateResult: any;
        postMortem: any;
        skippedReason?: string;
    }>;
    /**
     * Loads a PaperTrade by ID and directly learns from its persisted snapshots without querying candles.
     */
    learnFromPersistedTrade(tradeId: string): Promise<{
        updateResult: any;
        postMortem: any;
    }>;
}
