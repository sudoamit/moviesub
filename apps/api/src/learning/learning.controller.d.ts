import { LearningService } from './learning.service';
export declare class LearningController {
    private readonly learningService;
    constructor(learningService: LearningService);
    getSystemOverview(): Promise<{
        activeStrategy: import("@quant/learning-engine").IStrategyRegistryEntry | {
            strategyVersion: string;
            expectancyR: number;
            winRate: number;
        };
        activeModel: import("@quant/learning-engine").IModelRegistryEntry | {
            modelVersion: string;
            brierScore: number;
            expectedValueR: number;
        };
        totalExperiences: number;
        driftStatus: import("@quant/learning-engine").DriftReport;
        activeShadowCount: number;
        provenPatternsCount: number;
        rejectedHypothesesCount: number;
        lastCycleAt: Date;
    }>;
    getExperiences(limit?: string, symbol?: string): Promise<import("@quant/learning-engine").TradingExperience[]>;
    getErrorReport(): Promise<import("@quant/learning-engine").IErrorReport>;
    getPatterns(): Promise<import("@quant/learning-engine").DiscoveredPattern[]>;
    getCandidates(): Promise<import("@quant/learning-engine").StrategyCandidate[]>;
    runLearningCycle(body: {
        autoPromote?: boolean;
    }): Promise<import("@quant/learning-engine").LearningRunReport>;
    promoteCandidate(id: string): Promise<import("@quant/learning-engine").PromotionEvaluationResult>;
    rollback(body: {
        targetVersion?: string;
    }): Promise<{
        rolledBack: boolean;
        fromVersion: string | undefined;
        toVersion: string;
        executedAt: Date;
    }>;
}
