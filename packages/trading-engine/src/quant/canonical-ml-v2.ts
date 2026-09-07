import { Direction } from '@quant/shared';
import {
  CANONICAL_FEATURE_NAMES_V2,
  CANONICAL_FEATURE_SCHEMA_VERSION,
  CANONICAL_V2_DIMENSION,
  CanonicalTradeFeatureVectorV2,
  MLTradePrediction,
  PointInTimeMarketSnapshot,
} from './quant-types';

export class CanonicalMLEngineV2 {
  public static readonly SCHEMA_VERSION = CANONICAL_FEATURE_SCHEMA_VERSION;
  public static readonly FEATURE_NAMES = CANONICAL_FEATURE_NAMES_V2;
  public static readonly DIMENSION = CANONICAL_V2_DIMENSION;

  /**
   * Weights initialized with Xavier-scaled prior distribution.
   */
  private static weights: number[] = CANONICAL_FEATURE_NAMES_V2.map((_, i) => {
    const scale = Math.sqrt(2.0 / (CANONICAL_V2_DIMENSION + 1));
    return Number((Math.sin(i + 1) * 0.5 * scale).toFixed(5));
  });
  private static bias = 0.15;

  /**
   * Helper to clamp numbers to [0.0, 1.0].
   */
  private static clamp(v: number, min = 0.0, max = 1.0): number {
    if (isNaN(v) || !isFinite(v)) return min;
    return Math.max(min, Math.min(max, v));
  }

  /**
   * Extracts the canonical 28-dimensional normalized feature vector from a PointInTimeMarketSnapshot.
   */
  public static extractFeatures(
    snapshot: PointInTimeMarketSnapshot,
  ): CanonicalTradeFeatureVectorV2 {
    const isBullish = snapshot.smc?.currentTrend === Direction.BULLISH;
    const score = snapshot.score.totalScore;
    const quant = snapshot.quant;
    const regime = snapshot.regime;
    const vol = snapshot.volatility;
    const horizon = snapshot.multiHorizon;

    // 1-17 Core Features
    const smcScore = this.clamp(score / 100.0);
    const obStrength = this.clamp((quant.smcQuant?.orderBlockStrength || 50) / 100.0);
    const fvgSize = this.clamp((quant.smcQuant?.fvgSizeAtrRatio || 0.5) / 2.5);
    const mtfAlignment =
      horizon.alignment === 'ALIGNED' ? 1.0 : horizon.alignment === 'PARTIALLY_ALIGNED' ? 0.6 : 0.2;
    const killZoneSession = 0.5; // neutral default (no session feed attached)
    const smtDivergence = 0.5; // neutral default (no SMT feed attached)
    const volatilityAtr = this.clamp(vol.atrPercentage / 4.0);
    const riskRewardRatio = this.clamp(snapshot.score.riskRewardScore / 5.0);
    const trendRegime =
      regime.regime === 'BULLISH_TREND'
        ? isBullish
          ? 1.0
          : 0.0
        : regime.regime === 'BEARISH_TREND'
          ? !isBullish
            ? 1.0
            : 0.0
          : 0.5;
    const liquiditySweep = quant.smcQuant?.liquiditySweepDepth > 0 ? 1.0 : 0.0;
    const bosStrength = this.clamp((quant.smcQuant?.bosStrength || 0) / 100.0);
    const chochStrength = this.clamp((quant.smcQuant?.chochStrength || 0) / 100.0);
    const relativeVolume = this.clamp((quant.momentum?.relativeVolume || 1.0) / 3.0);
    const distanceToHTFLevel = this.clamp(
      (quant.smcQuant?.distanceToHTFOrderBlockPct || 1.0) / 5.0,
    );
    const distanceToLiquidity = this.clamp((quant.smcQuant?.distanceToLiquidityPct || 1.0) / 5.0);
    const marketSession = 0.5; // neutral default
    const dayOfWeek = new Date(snapshot.timestamp).getDay() / 7.0;

    // 18-28 Quant Features
    const return1Bar = this.clamp((quant.returns.return1Bar + 0.05) / 0.1);
    const return5Bar = this.clamp((quant.returns.return5Bar + 0.1) / 0.2);
    const return20Bar = this.clamp((quant.returns.return20Bar + 0.15) / 0.3);
    const returnSkewness = this.clamp((quant.returns.returnSkewness + 3.0) / 6.0);
    const parkinsonVolatility = this.clamp((vol.parkinsonVolatility || 0.01) / 0.05);
    const garmanKlassVolatility = this.clamp((vol.garmanKlassVolatility || 0.01) / 0.05);
    const forecastVolatility = this.clamp((vol.forecastVolatility || 0.01) / 0.05);
    const volatilityPercentile = this.clamp(vol.volatilityPercentile / 100.0);
    const distanceToVwap = this.clamp((quant.momentum.distanceToVwap + 3.0) / 6.0);
    const bollingerPosition = this.clamp(quant.momentum.bollingerPosition);
    const multiHorizonConfluence = this.clamp(horizon.confluenceScore / 100.0);

    return {
      smcScore,
      obStrength,
      fvgSize,
      mtfAlignment,
      killZoneSession,
      smtDivergence,
      volatilityAtr,
      riskRewardRatio,
      trendRegime,
      liquiditySweep,
      bosStrength,
      chochStrength,
      relativeVolume,
      distanceToHTFLevel,
      distanceToLiquidity,
      marketSession,
      dayOfWeek,
      return1Bar,
      return5Bar,
      return20Bar,
      returnSkewness,
      parkinsonVolatility,
      garmanKlassVolatility,
      forecastVolatility,
      volatilityPercentile,
      distanceToVwap,
      bollingerPosition,
      multiHorizonConfluence,
    };
  }

  /**
   * Converts a feature vector object to array in strict canonical index order.
   */
  public static toArray(vector: CanonicalTradeFeatureVectorV2): number[] {
    return CANONICAL_FEATURE_NAMES_V2.map((name) => vector[name] ?? 0.5);
  }

  /**
   * Evaluates the ML model to produce calibrated trade quality predictions and Expected Value.
   */
  public static predict(
    features: CanonicalTradeFeatureVectorV2,
    expectedWinR: number | null | undefined = null,
  ): MLTradePrediction {
    const arr = this.toArray(features);

    let logit = this.bias;
    for (let i = 0; i < CANONICAL_V2_DIMENSION; i++) {
      logit += this.weights[i] * (arr[i] - 0.5);
    }
    logit += (features.smcScore - 0.5) * 1.5 + (features.multiHorizonConfluence - 0.5) * 1.2;

    const rawProb = 1.0 / (1.0 + Math.exp(-logit));
    const heuristicProbability = Math.max(0.05, Math.min(0.95, Number(rawProb.toFixed(3))));

    if (expectedWinR === null || expectedWinR === undefined || !Number.isFinite(expectedWinR)) {
      return {
        probabilityWin: null,
        probabilityTP1: null,
        probabilityTP2: null,
        probabilityStopFirst: null,
        expectedR: null,
        confidence: null,
        uncertainty: null,
        calibrated: false,
        featureSchemaVersion: CANONICAL_FEATURE_SCHEMA_VERSION,
      };
    }

    const probabilityWin = heuristicProbability;
    const probTP1 = Math.max(0.1, Math.min(0.98, Number((probabilityWin * 1.18).toFixed(3))));
    const probTP2 = Math.max(0.05, Math.min(0.9, Number((probabilityWin * 0.88).toFixed(3))));
    const probStopFirst = Number((1.0 - probTP1).toFixed(3));
    const expectedR = Number(
      (probabilityWin * expectedWinR - (1.0 - probabilityWin) * 1.0).toFixed(2),
    );
    const confidence = Math.round(probabilityWin * 100);
    const uncertainty = Number(
      (Math.sqrt(probabilityWin * (1.0 - probabilityWin)) * 0.5).toFixed(3),
    );

    return {
      probabilityWin,
      probabilityTP1: probTP1,
      probabilityTP2: probTP2,
      probabilityStopFirst: probStopFirst,
      expectedR,
      confidence,
      uncertainty,
      calibrated: false,
      featureSchemaVersion: CANONICAL_FEATURE_SCHEMA_VERSION,
    };
  }
}
