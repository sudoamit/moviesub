import { FeatureImportanceItem, TradingExperience } from './types';
export declare class FeatureAnalyzer {
    /**
     * Computes empirical feature correlation / importance against realized trade outcome R.
     */
    static analyze(experiences: TradingExperience[], historicalImportances?: Map<string, number>): FeatureImportanceItem[];
}
