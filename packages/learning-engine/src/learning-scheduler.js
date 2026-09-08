"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LearningScheduler = void 0;
class LearningScheduler {
    static DEFAULT_CONFIG = {
        experienceIngestionIntervalMs: 5 * 60 * 1000,
        weeklyAnalysisIntervalMs: 7 * 24 * 60 * 60 * 1000,
        minNewExperiencesForRetraining: 50,
        autoPromotionEnabled: false,
    };
    static lastRunTimestamp = null;
    static processedExperienceCount = 0;
    /**
     * Checks if an automated self-improvement cycle is due based on time and new observations.
     */
    static isLearningCycleDue(currentExperienceCount, config = this.DEFAULT_CONFIG) {
        const newExperiences = currentExperienceCount - this.processedExperienceCount;
        if (newExperiences < config.minNewExperiencesForRetraining) {
            return false;
        }
        if (!this.lastRunTimestamp) {
            return true;
        }
        const elapsed = Date.now() - this.lastRunTimestamp.getTime();
        return (elapsed >= config.weeklyAnalysisIntervalMs ||
            newExperiences >= config.minNewExperiencesForRetraining * 2);
    }
    /**
     * Marks a learning cycle as completed.
     */
    static markCycleCompleted(totalExperiencesAtRun) {
        this.lastRunTimestamp = new Date();
        this.processedExperienceCount = totalExperiencesAtRun;
    }
    static getLastRunTimestamp() {
        return this.lastRunTimestamp;
    }
}
exports.LearningScheduler = LearningScheduler;
//# sourceMappingURL=learning-scheduler.js.map