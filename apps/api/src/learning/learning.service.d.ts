import { PrismaService } from '../common/prisma/prisma.service';
import { TradingExperience, StrategyCandidate } from '@quant/learning-engine';
export declare class LearningService {
    private readonly prisma;
    private readonly logger;
    constructor(prisma: PrismaService);
    /**
     * Returns system health, active models, active strategy, drift status, and high-level learning summary.
     */
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
    /**
     * Retrieves paginated trading experiences.
     */
    getExperiences(limit?: number, symbol?: string): Promise<TradingExperience[]>;
    /**
     * Generates real-time failure mode analysis and top loss drivers.
     */
    getErrorReport(): Promise<import("@quant/learning-engine").IErrorReport>;
    /**
     * Mines positive and negative confluence patterns from experiences.
     */
    getPatterns(): Promise<import("@quant/learning-engine").DiscoveredPattern[]>;
    /**
     * Retrieves active strategy candidates with shadow metrics and validation results.
     */
    getCandidates(): Promise<StrategyCandidate[]>;
    /**
     * Executes a full self-improvement learning cycle.
     */
    triggerLearningCycle(autoPromote?: boolean): Promise<import("@quant/learning-engine").LearningRunReport>;
    /**
     * Manually promotes a strategy candidate.
     */
    promoteCandidate(candidateId: string): Promise<import("@quant/learning-engine").PromotionEvaluationResult>;
    /**
     * Executes deterministic rollback to previous stable version.
     */
    rollback(targetVersion?: string): Promise<{
        rolledBack: boolean;
        fromVersion: string | undefined;
        toVersion: string;
        executedAt: Date;
    }>;
}
