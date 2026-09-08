import { ICandle, ISwingPoint, MarketRegimeType } from '@quant/shared';
import { RegimeState } from './quant-types';
export interface IClusteringFeatureVector {
    trendStrength: number;
    directionalBias: number;
    volatilityPercent: number;
    bollingerWidth: number;
    rsiMomentum: number;
    relativeVolume: number;
}
export declare class RegimeClusteringEngine {
    /**
     * K-Means clustering algorithm for unsupervised regime discovery.
     */
    static runKMeans(data: number[][], k?: number, maxIterations?: number): {
        centroids: number[][];
        assignments: number[];
    };
    /**
     * Deterministically maps a centroid vector to a semantic MarketRegimeType.
     * Features: [trendStrength (0-1), directionalBias (-1 to 1), volatilityPercent (0-1), bollingerWidth (0-1), rsiMomentum (-1 to 1), relativeVolume (0-1)]
     */
    static mapCentroidToRegime(centroid: number[]): MarketRegimeType;
    /**
     * Classifies market regime by running K-Means clustering over rolling multi-feature observations.
     */
    static classifyRegime(candles: ICandle[], swings?: ISwingPoint[]): RegimeState;
}
