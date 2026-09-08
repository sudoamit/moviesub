export interface ISchedulerConfig {
    experienceIngestionIntervalMs: number;
    weeklyAnalysisIntervalMs: number;
    minNewExperiencesForRetraining: number;
    autoPromotionEnabled: boolean;
}
export declare class LearningScheduler {
    static readonly DEFAULT_CONFIG: ISchedulerConfig;
    private static lastRunTimestamp;
    private static processedExperienceCount;
    /**
     * Checks if an automated self-improvement cycle is due based on time and new observations.
     */
    static isLearningCycleDue(currentExperienceCount: number, config?: ISchedulerConfig): boolean;
    /**
     * Marks a learning cycle as completed.
     */
    static markCycleCompleted(totalExperiencesAtRun: number): void;
    static getLastRunTimestamp(): Date | null;
}
