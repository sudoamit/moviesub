import { CanonicalTradeFeatureVectorV2 } from '@quant/trading-engine';
import { NoTradePrediction, TradingExperience } from './types';
import { IDatasetSample } from './dataset-manager';
export interface ITrainedModelArtifact {
    modelVersion: string;
    weights: number[];
    bias: number;
    featureSchemaVersion: string;
    sampleCount: number;
    trainLoss: number;
    trainedAt: Date;
}
export declare class ModelTrainer {
    /**
     * Trains a canonical 28-dimensional logistic model on an EXPLICIT temporal training dataset slice.
     */
    static trainModel(trainingDataset: (TradingExperience | IDatasetSample)[], epochs?: number, learningRate?: number, l2Lambda?: number): ITrainedModelArtifact;
    /**
     * Dedicated NO_TRADE model predicting probability of bad setup / failure.
     */
    static predictNoTrade(features: CanonicalTradeFeatureVectorV2, modelArtifact?: ITrainedModelArtifact): NoTradePrediction;
}
