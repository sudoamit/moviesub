import { IDatasetSample } from './dataset-manager';
import { TradingExperience } from './types';
export interface IScaleParameters {
    mean: number;
    std: number;
    min: number;
    max: number;
}
export declare class TemporalFeatureScaler {
    private featureStats;
    /**
     * Fits normalization parameters (mean, std, min, max) EXCLUSIVELY on the training fold.
     * Ensures zero future-data leakage into scaling parameters.
     */
    fit(trainingData: (IDatasetSample | TradingExperience)[]): void;
    /**
     * Transforms feature values using pre-computed training parameters.
     * Standardizes values (z-score: (x - mean) / std).
     */
    transformValue(featureName: string, rawValue: number): number;
    /**
     * Transforms a map of features using pre-computed training parameters.
     */
    transform(features: Record<string, number>): Record<string, number>;
    getParams(featureName: string): IScaleParameters | undefined;
}
