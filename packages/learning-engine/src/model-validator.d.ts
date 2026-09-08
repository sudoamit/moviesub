import { ITrainedModelArtifact } from './model-trainer';
import { TradingExperience } from './types';
export interface IModelValidationMetrics {
    brierScore: number;
    logLoss: number;
    calibrationSlope: number;
    aucProxy: number;
    expectedValueMeanError: number;
    sampleCount: number;
    isCalibrated: boolean;
}
export declare class ModelValidator {
    /**
     * Evaluates model calibration, discrimination, and expected value prediction accuracy.
     */
    static validate(model: ITrainedModelArtifact, validationExperiences: TradingExperience[]): IModelValidationMetrics;
}
