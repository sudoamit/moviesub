import { FeatureSelectionResult, TradingExperience } from './types';
export declare class FeatureSelector {
    /**
     * Evaluates feature subsets and prunes low-importance, noisy dimensions that do not contribute to out-of-sample expectancy.
     */
    static selectFeatures(experiences: TradingExperience[], minImportanceThreshold?: number): FeatureSelectionResult;
}
