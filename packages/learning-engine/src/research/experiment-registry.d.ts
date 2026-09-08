import { ExperimentStatus, ResearchExperiment } from './types';
export declare class ExperimentRegistry {
    private static experiments;
    /**
     * Generates a deterministic SHA-256 hash identifying the exact experiment configuration.
     * Ensures identical parameters, datasets, and period windows produce the exact same hash.
     */
    static computeExperimentHash(config: {
        datasetVersion: string;
        strategyVersion: string;
        featureSchemaVersion: string;
        instrument: string;
        timeframe: string;
        parameters: Record<string, unknown>;
        trainingPeriod: {
            start: Date;
            end: Date;
        };
        validationPeriod: {
            start: Date;
            end: Date;
        };
        testPeriod: {
            start: Date;
            end: Date;
        };
        holdoutPeriod?: {
            start: Date;
            end: Date;
        };
    }): string;
    /**
     * Registers a new research experiment into the immutable registry.
     */
    static registerExperiment(experiment: ResearchExperiment): ResearchExperiment;
    /**
     * Finds an existing experiment by its deterministic configuration hash.
     */
    static findExperimentByHash(hash: string): ResearchExperiment | undefined;
    static getExperiment(id: string): ResearchExperiment | undefined;
    static listExperiments(limit?: number): ResearchExperiment[];
    static getExperimentsByStatus(status: ExperimentStatus): ResearchExperiment[];
    static updateExperiment(id: string, updates: Partial<ResearchExperiment>): ResearchExperiment;
    static clear(): void;
}
