export interface IDatasetMetadata {
    datasetId: string;
    datasetVersion: string;
    dataHash: string;
    symbol: string;
    timeframe: string;
    startDate: string;
    endDate: string;
    featureVersion: string;
    labelVersion: string;
    strategyVersion: string;
    sampleCount: number;
    featuresList: string[];
}
export interface IDatasetSample {
    sampleId: string;
    timestamp: number;
    labelStartTimestamp?: number;
    labelEndTimestamp?: number;
    features: Record<string, number>;
    labelBinary: number;
    labelContinuousR: number;
    regime: string;
    volatilityBucket: string;
}
export interface IDatasetSplits {
    train: ReadonlyArray<IDatasetSample>;
    validation: ReadonlyArray<IDatasetSample>;
    outOfSample: ReadonlyArray<IDatasetSample>;
    metadata: IDatasetMetadata;
}
export declare class DatasetManager {
    private datasets;
    /**
     * Registers and hashes an immutable training dataset.
     * Rejects duplicate sample IDs and sorts strictly chronologically.
     */
    createDataset(symbol: string, timeframe: string, samples: IDatasetSample[], featureVersion?: string, strategyVersion?: string, randomSeed?: number): {
        metadata: IDatasetMetadata;
        samples: IDatasetSample[];
    };
    /**
     * Partitions a time-series dataset into strict sequential Train, Validation, and OOS splits
     * with label end timestamp purging and time-based embargo to prevent temporal overlap leakage.
     */
    splitDataset(datasetId: string, trainRatio?: number, valRatio?: number, oosRatio?: number, embargoMs?: number): IDatasetSplits;
    getDataset(datasetId: string): {
        metadata: IDatasetMetadata;
        samples: IDatasetSample[];
    } | undefined;
}
export declare const TemporalDatasetBuilder: typeof DatasetManager;
export type TemporalDatasetBuilder = DatasetManager;
