import { DiscoveredPattern, TradingExperience } from './types';
export interface IPatternDiscoveryOptions {
    minSampleSize?: number;
    minEffectSizeR?: number;
    confidenceLevel?: number;
}
export declare class PatternDiscoveryEngine {
    /**
     * Mines multi-factor condition combinations to extract high-confidence positive patterns and negative filter candidates.
     */
    static discover(experiences: TradingExperience[], options?: IPatternDiscoveryOptions): DiscoveredPattern[];
}
