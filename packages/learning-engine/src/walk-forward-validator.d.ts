import { StrategyCandidate, TradingExperience, WalkForwardValidationResult } from './types';
export interface FoldArtifact {
    foldIndex: number;
    trainDatasetHash: string;
    validationDatasetHash: string;
    oosDatasetHash: string;
    featureSchemaVersion: string;
    selectedFeatures: string[];
    scalerVersion: string;
    scalerParameters: Record<string, {
        mean: number;
        std: number;
        min: number;
        max: number;
    }>;
    modelVersion: string;
    modelParameters: {
        weights: number[];
        bias: number;
    };
    strategyVersion: string;
    strategyParameters: Record<string, any>;
    candidateId: string;
    candidateConfigHash: string;
    trainingSeed: number;
    createdAt: Date;
}
export interface IWalkForwardOptions {
    numFolds?: number;
    embargoDays?: number;
    embargoMs?: number;
    retrainFn?: (trainSlice: TradingExperience[], baseCandidate: StrategyCandidate, foldIndex: number) => StrategyCandidate;
}
export declare class WalkForwardValidator {
    /**
     * Performs chronological purged and embargoed walk-forward validation with genuine candidate retraining per fold.
     */
    static validate(candidate: StrategyCandidate, experiences: TradingExperience[], options?: IWalkForwardOptions): WalkForwardValidationResult & {
        foldArtifacts?: ReadonlyArray<FoldArtifact>;
    };
    /**
     * Fits candidate strategy parameters strictly on training fold data.
     */
    private static retrainCandidateOnFold;
}
