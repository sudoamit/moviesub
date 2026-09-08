import { CanonicalTradeFeatureVectorV2, MLTradePrediction, PointInTimeMarketSnapshot } from './quant-types';
export declare class CanonicalMLEngineV2 {
    static readonly SCHEMA_VERSION = "2.0";
    static readonly FEATURE_NAMES: readonly ["smcScore", "obStrength", "fvgSize", "mtfAlignment", "killZoneSession", "smtDivergence", "volatilityAtr", "riskRewardRatio", "trendRegime", "liquiditySweep", "bosStrength", "chochStrength", "relativeVolume", "distanceToHTFLevel", "distanceToLiquidity", "marketSession", "dayOfWeek", "return1Bar", "return5Bar", "return20Bar", "returnSkewness", "parkinsonVolatility", "garmanKlassVolatility", "forecastVolatility", "volatilityPercentile", "distanceToVwap", "bollingerPosition", "multiHorizonConfluence"];
    static readonly DIMENSION: 28;
    /**
     * Weights initialized with Xavier-scaled prior distribution.
     */
    private static weights;
    private static bias;
    /**
     * Helper to clamp numbers to [0.0, 1.0].
     */
    private static clamp;
    /**
     * Extracts the canonical 28-dimensional normalized feature vector from a PointInTimeMarketSnapshot.
     */
    static extractFeatures(snapshot: PointInTimeMarketSnapshot): CanonicalTradeFeatureVectorV2;
    /**
     * Converts a feature vector object to array in strict canonical index order.
     */
    static toArray(vector: CanonicalTradeFeatureVectorV2): number[];
    /**
     * Evaluates the ML model to produce calibrated trade quality predictions and Expected Value.
     */
    static predict(features: CanonicalTradeFeatureVectorV2, expectedWinR?: number | null | undefined): MLTradePrediction;
}
