import { AILearningService, PredictTradeDto } from './ai-learning.service';
export declare class AILearningController {
    private readonly aiLearningService;
    constructor(aiLearningService: AILearningService);
    /**
     * 1. GET /api/ai-learning/model-state
     * Returns active model version, schema version, trained timestamp, metrics, and calibration.
     */
    getModelState(): Promise<{
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
        calibration: import("@quant/trading-engine").ICalibrationReport | null | undefined;
        featureCount: number;
        featureSchemaVersion: string;
        allVersions: {
            version: string;
            status: "ACTIVE" | "REJECTED" | "CANDIDATE" | "ARCHIVED";
            createdAt: Date;
            accuracy: number;
            logLoss: number;
        }[];
    }>;
    /**
     * 2. POST /api/ai-learning/retrain
     * Starts a non-blocking background training job.
     */
    startRetrainJob(): Promise<{
        jobId: string;
        status: string;
        message: string;
    }>;
    /**
     * 3. GET /api/ai-learning/retrain/:jobId
     * Returns status, progress percent, stage, and candidate metrics of a training job.
     */
    getRetrainJobStatus(jobId: string): Promise<import("./ai-learning.service").IRetrainJobStatus>;
    /**
     * 4. POST /api/ai-learning/predict
     * Evaluates a trade setup using genuine trading engine features.
     */
    predictTrade(dto: PredictTradeDto): Promise<any>;
    /**
     * 5. GET /api/ai-learning/insights
     * Returns feature importance, regime breakdowns, asset performance, and post-mortems.
     */
    getInsights(): Promise<any>;
}
