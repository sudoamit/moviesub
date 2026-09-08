import { LearningRunReport } from './types';
export interface ILearningCycleOptions {
    baseStrategyVersion?: string;
    autoPromote?: boolean;
}
export declare class LearningEngine {
    static readonly VERSION = "1.0.0";
    /**
     * Executes a complete, end-to-end self-improvement learning cycle across all modules.
     */
    static runLearningCycle(options?: ILearningCycleOptions): Promise<LearningRunReport>;
}
