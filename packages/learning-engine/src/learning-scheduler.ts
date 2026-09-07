export interface ISchedulerConfig {
  experienceIngestionIntervalMs: number; // e.g. 5 minutes
  weeklyAnalysisIntervalMs: number; // e.g. 7 days
  minNewExperiencesForRetraining: number; // e.g. 50
  autoPromotionEnabled: boolean;
}

export class LearningScheduler {
  public static readonly DEFAULT_CONFIG: ISchedulerConfig = {
    experienceIngestionIntervalMs: 5 * 60 * 1000,
    weeklyAnalysisIntervalMs: 7 * 24 * 60 * 60 * 1000,
    minNewExperiencesForRetraining: 50,
    autoPromotionEnabled: false,
  };

  private static lastRunTimestamp: Date | null = null;
  private static processedExperienceCount = 0;

  /**
   * Checks if an automated self-improvement cycle is due based on time and new observations.
   */
  public static isLearningCycleDue(
    currentExperienceCount: number,
    config: ISchedulerConfig = this.DEFAULT_CONFIG,
  ): boolean {
    const newExperiences = currentExperienceCount - this.processedExperienceCount;
    if (newExperiences < config.minNewExperiencesForRetraining) {
      return false;
    }

    if (!this.lastRunTimestamp) {
      return true;
    }

    const elapsed = Date.now() - this.lastRunTimestamp.getTime();
    return (
      elapsed >= config.weeklyAnalysisIntervalMs ||
      newExperiences >= config.minNewExperiencesForRetraining * 2
    );
  }

  /**
   * Marks a learning cycle as completed.
   */
  public static markCycleCompleted(totalExperiencesAtRun: number): void {
    this.lastRunTimestamp = new Date();
    this.processedExperienceCount = totalExperiencesAtRun;
  }

  public static getLastRunTimestamp(): Date | null {
    return this.lastRunTimestamp;
  }
}
