export interface FeatureNormalizationMetadata {
    method: 'zscore' | 'percentile' | 'minmax' | 'robust' | 'expanding';
    window?: number;
    fittedUntil: Date;
}
export declare class NormalizationEngine {
    /**
     * Rolling Z-Score Normalization.
     * Only uses history <= current index to prevent look-ahead bias.
     */
    static rollingZScore(values: number[], window?: number, clampRange?: [number, number]): number;
    /**
     * Rolling Min-Max Normalization to [0.0, 1.0].
     */
    static rollingMinMax(values: number[], window?: number): number;
    /**
     * Rolling Percentile Rank Normalization to [0.0, 1.0].
     */
    static rollingPercentileRank(values: number[], window?: number): number;
    /**
     * Robust Scaling using Median and Interquartile Range (IQR).
     */
    static rollingRobustScale(values: number[], window?: number): number;
    /**
     * Normalizes a continuous value to [0.0, 1.0] using standard sigmoid / logistic curve.
     */
    static sigmoid(val: number, scale?: number): number;
}
