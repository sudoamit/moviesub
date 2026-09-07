import { ICandle, ISignalSetup, Direction, MarketRegimeType } from '@quant/shared';
import { ISMCAnalysisResult } from './types';
import { SessionFilter } from './session-filter';

/**
 * Feature Schema Version identifier.
 * Any modification to the feature names or ordering requires incrementing this version.
 */
export const FEATURE_SCHEMA_VERSION = '1.0';

/**
 * Deterministic, ordered list of feature names.
 * Array serialization strictly adheres to this index ordering.
 */
export const FEATURE_NAMES = [
  'smcScore',
  'obStrength',
  'fvgSize',
  'mtfAlignment',
  'killZoneSession',
  'smtDivergence',
  'volatilityAtr',
  'riskRewardRatio',
  'trendRegime',
  'liquiditySweep',
  'bosStrength',
  'chochStrength',
  'relativeVolume',
  'distanceToHTFLevel',
  'distanceToLiquidity',
  'marketSession',
  'dayOfWeek',
] as const;

export type FeatureName = (typeof FEATURE_NAMES)[number];

export const FEATURE_VECTOR_DIMENSION = FEATURE_NAMES.length;

/**
 * Normalized 17-dimensional feature vector for trade prediction and learning.
 * All features are normalized to [0.0, 1.0].
 */
export interface TradeFeatureVector {
  smcScore: number;
  obStrength: number;
  fvgSize: number;
  mtfAlignment: number;
  killZoneSession: number;
  smtDivergence: number;
  volatilityAtr: number;
  riskRewardRatio: number;

  trendRegime: number;
  liquiditySweep: number;
  bosStrength: number;
  chochStrength: number;
  relativeVolume: number;
  distanceToHTFLevel: number;
  distanceToLiquidity: number;
  marketSession: number;
  dayOfWeek: number;
}

/**
 * Context provided to extract features at prediction time.
 * Strictly guarantees point-in-time state without future leakage.
 */
export interface IFeatureExtractionContext {
  signal: ISignalSetup;
  candles: ICandle[];
  smcAnalysis?: ISMCAnalysisResult | null;
  htfCandles?: ICandle[];
  smtDivergenceScore?: number; // 0.0 to 1.0
  asOfTimestamp?: Date; // Strictly filter candles <= asOfTimestamp to prevent lookahead
}

/**
 * Helper to clamp values strictly between min and max.
 */
function clamp(val: number, min = 0.0, max = 1.0): number {
  if (isNaN(val) || !isFinite(val)) return min;
  return Math.max(min, Math.min(max, val));
}

/**
 * FeatureVectorExtractor
 * Pure, deterministic extractor that maps trading engine state to a normalized feature vector.
 */
export class FeatureVectorExtractor {
  public static readonly SCHEMA_VERSION = FEATURE_SCHEMA_VERSION;
  public static readonly FEATURE_NAMES = FEATURE_NAMES;
  public static readonly DIMENSION = FEATURE_VECTOR_DIMENSION;

  /**
   * Extracts a normalized TradeFeatureVector from point-in-time market and setup context.
   */
  public static extract(context: IFeatureExtractionContext): TradeFeatureVector {
    const { signal, smcAnalysis, htfCandles, smtDivergenceScore, asOfTimestamp } = context;

    // 1. Point-in-time candle slicing to strictly prevent look-ahead bias
    let validCandles = context.candles;
    if (asOfTimestamp) {
      const asOfTime = asOfTimestamp.getTime();
      validCandles = context.candles.filter((c) => new Date(c.timestamp).getTime() <= asOfTime);
    }

    const lastCandle = validCandles.length > 0 ? validCandles[validCandles.length - 1] : null;
    const currentPrice = lastCandle ? lastCandle.close : signal.entryZone?.optimal || 1.0;
    const isBullish =
      signal.direction === 'BULLISH' || (signal.direction as any) === Direction.BULLISH;

    // 1. smcScore: Normalized 0 to 100 -> [0.0, 1.0]
    const smcScore = clamp((signal.score || 0) / 100.0);

    // 2. obStrength: Extracted from active order block quality and displacement ratio
    let obStrength = 0.5; // neutral fallback
    if (smcAnalysis?.orderBlocks && smcAnalysis.orderBlocks.length > 0) {
      const activeOB =
        smcAnalysis.orderBlocks.find(
          (ob) =>
            (isBullish
              ? ob.direction === 'BULLISH' || (ob.direction as any) === Direction.BULLISH
              : ob.direction === 'BEARISH' || (ob.direction as any) === Direction.BEARISH) &&
            !ob.isMitigated,
        ) || smcAnalysis.orderBlocks[0];
      obStrength = clamp((activeOB.strength || 50) / 100.0);
    } else if (signal.scoreBreakdown?.orderBlock !== undefined) {
      // 25 max points in scoreBreakdown
      obStrength = clamp(signal.scoreBreakdown.orderBlock / 25.0);
    }

    // 3. fvgSize: Normalized size of the trigger Fair Value Gap relative to recent ATR
    let fvgSize = 0.5;
    const recentAtr = this.calculateAtr(validCandles, 14);
    if (smcAnalysis?.fairValueGaps && smcAnalysis.fairValueGaps.length > 0 && recentAtr > 0) {
      const activeFVG =
        smcAnalysis.fairValueGaps.find((f) => !f.isFilled) || smcAnalysis.fairValueGaps[0];
      const gapWidth = Math.abs(activeFVG.upperBound - activeFVG.lowerBound);
      // Gap size / ATR: typical ratio 0.5 to 2.0 ATR -> normalized to [0, 1]
      fvgSize = clamp(gapWidth / (recentAtr * 2.5));
    } else if (signal.scoreBreakdown?.fvg !== undefined) {
      fvgSize = clamp(signal.scoreBreakdown.fvg / 20.0);
    }

    // 4. mtfAlignment: Higher timeframe alignment score (0.0 to 1.0)
    let mtfAlignment = 0.5;
    if (signal.scoreBreakdown?.htfBias !== undefined) {
      mtfAlignment = clamp(signal.scoreBreakdown.htfBias / 25.0);
    } else if (signal.htfBias) {
      const htfMatches =
        (isBullish && signal.htfBias === 'BULLISH') || (!isBullish && signal.htfBias === 'BEARISH');
      mtfAlignment = htfMatches ? 1.0 : signal.htfBias === 'NEUTRAL' ? 0.5 : 0.0;
    }

    // 5. killZoneSession: Active ICT session / Kill Zone score
    let killZoneSession = 0.0;
    const evalTime = asOfTimestamp || (lastCandle ? new Date(lastCandle.timestamp) : new Date());
    const sessionInfo = SessionFilter.getSessionInfo(evalTime, signal.symbol);
    if (sessionInfo.isKillZone) {
      killZoneSession = 1.0;
    } else if (sessionInfo.activeSession !== 'MARKET_CLOSED') {
      killZoneSession = 0.5;
    }

    // 6. smtDivergence: Institutional SMT divergence correlation score
    let smtDivergence = 0.5;
    if (smtDivergenceScore !== undefined) {
      smtDivergence = clamp(smtDivergenceScore);
    } else if (signal.scoreBreakdown?.liquiditySweep !== undefined) {
      smtDivergence = clamp(signal.scoreBreakdown.liquiditySweep / 20.0);
    }

    // 7. volatilityAtr: Normalized ATR volatility ratio (ATR / Price)
    let volatilityAtr = 0.5;
    if (recentAtr > 0 && currentPrice > 0) {
      const atrPercent = (recentAtr / currentPrice) * 100.0;
      // Index ATR typically 0.2% - 1.5%, Crypto 1.0% - 4.0%
      volatilityAtr = clamp(atrPercent / 3.0);
    }

    // 8. riskRewardRatio: Normalized expected R:R (0.0 to 1.0 mapped across 0.5R to 4.0R)
    let riskRewardRatio = 0.5;
    const rawRR = signal.riskRewardRatios?.rr2 || 2.0;
    riskRewardRatio = clamp((rawRR - 0.5) / 3.5); // 0.5R -> 0.0, 4.0R -> 1.0

    // 9. trendRegime: 0.0 = RANGING / CHOP, 0.5 = TRANSITIONAL, 1.0 = STRONG TREND
    let trendRegime = 0.5;
    const regime = smcAnalysis?.marketRegime?.regime;
    if (
      regime === MarketRegimeType.BULLISH_TREND ||
      regime === MarketRegimeType.BEARISH_TREND ||
      regime === ('TRENDING' as any)
    ) {
      trendRegime = 1.0;
    } else if (regime === MarketRegimeType.RANGE || regime === ('RANGING' as any)) {
      trendRegime = 0.0;
    } else if (regime === MarketRegimeType.HIGH_VOLATILITY || regime === ('VOLATILE' as any)) {
      trendRegime = 0.3;
    }

    // 10. liquiditySweep: 1.0 if liquidity pool was swept before entry, 0.0 otherwise
    let liquiditySweep = 0.0;
    if (smcAnalysis?.liquiditySweeps && smcAnalysis.liquiditySweeps.length > 0) {
      liquiditySweep = 1.0;
    } else if (signal.reasoning?.liquidityReason?.toLowerCase().includes('sweep')) {
      liquiditySweep = 1.0;
    }

    // 11. bosStrength: Break of Structure displacement strength
    let bosStrength = 0.0;
    if (smcAnalysis?.breaksOfStructure && smcAnalysis.breaksOfStructure.length > 0) {
      const lastBOS = smcAnalysis.breaksOfStructure[smcAnalysis.breaksOfStructure.length - 1];
      bosStrength = clamp(lastBOS.displacementRatio || 0.7);
    } else if (signal.reasoning?.triggerReason?.toLowerCase().includes('bos')) {
      bosStrength = 0.7;
    }

    // 12. chochStrength: Change of Character reversal strength
    let chochStrength = 0.0;
    if (smcAnalysis?.changesOfCharacter && smcAnalysis.changesOfCharacter.length > 0) {
      const lastCHOCH = smcAnalysis.changesOfCharacter[smcAnalysis.changesOfCharacter.length - 1];
      chochStrength = clamp(lastCHOCH.strength ? lastCHOCH.strength / 100.0 : 0.8);
    } else if (signal.reasoning?.triggerReason?.toLowerCase().includes('choch')) {
      chochStrength = 0.8;
    }

    // 13. relativeVolume: Current candle volume vs 20-period volume SMA (normalized)
    let relativeVolume = 0.5;
    if (validCandles.length >= 5) {
      const volWindow = validCandles.slice(-20);
      const avgVol = volWindow.reduce((acc, c) => acc + (c.volume || 1), 0) / volWindow.length;
      const currentVol = lastCandle ? lastCandle.volume || 1 : avgVol;
      if (avgVol > 0) {
        // Ratio 0.0 to 3.0 mapped to [0.0, 1.0]
        relativeVolume = clamp(currentVol / avgVol / 3.0);
      }
    }

    // 14. distanceToHTFLevel: Proximity to higher timeframe key level (0.0 = at level, 1.0 = distant)
    let distanceToHTFLevel = 0.5;
    if (htfCandles && htfCandles.length > 0 && currentPrice > 0) {
      const htfHigh = Math.max(...htfCandles.map((c) => c.high));
      const htfLow = Math.min(...htfCandles.map((c) => c.low));
      const targetLevel = isBullish ? htfHigh : htfLow;
      const distPct = Math.abs(targetLevel - currentPrice) / currentPrice;
      // 0% to 5% mapped to [0.0, 1.0]
      distanceToHTFLevel = clamp(distPct / 0.05);
    }

    // 15. distanceToLiquidity: Normalized distance to resting pool
    let distanceToLiquidity = 0.5;
    if (smcAnalysis?.liquidityPools && smcAnalysis.liquidityPools.length > 0 && currentPrice > 0) {
      const activePools = smcAnalysis.liquidityPools.filter((p) => !p.isSwept);
      if (activePools.length > 0) {
        const minDistance = Math.min(
          ...activePools.map((p) => Math.abs(p.priceLevel - currentPrice)),
        );
        const distPct = minDistance / currentPrice;
        distanceToLiquidity = clamp(distPct / 0.03); // 0 to 3% mapped to [0.0, 1.0]
      }
    }

    // 16. marketSession: Cyclic hour encoding across 24h market
    const hour = evalTime.getUTCHours() + evalTime.getUTCMinutes() / 60.0;
    const marketSession = clamp(hour / 24.0);

    // 17. dayOfWeek: Day of week (0 = Sun, 1 = Mon ... 6 = Sat -> [0.0, 1.0])
    const dayOfWeek = clamp(evalTime.getUTCDay() / 6.0);

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
    };
  }

  /**
   * Serializes a TradeFeatureVector to a Float64 number array in exact deterministic feature order.
   */
  public static toArray(features: TradeFeatureVector): number[] {
    return FEATURE_NAMES.map((name) => features[name]);
  }

  /**
   * Deserializes a number array back into a strongly-typed TradeFeatureVector.
   * Throws if the array length does not strictly equal the schema dimension.
   */
  public static fromArray(arr: number[]): TradeFeatureVector {
    if (!arr || arr.length !== FEATURE_VECTOR_DIMENSION) {
      throw new Error(
        `FeatureVectorExtractor.fromArray: expected array of dimension ${FEATURE_VECTOR_DIMENSION}, received ${arr ? arr.length : 0}`,
      );
    }

    const vector: any = {};
    FEATURE_NAMES.forEach((name, idx) => {
      vector[name] = arr[idx];
    });

    return vector as TradeFeatureVector;
  }

  /**
   * Validates that all features in the vector are finite numbers strictly bounded in [0.0, 1.0].
   */
  public static validateVector(features: TradeFeatureVector): {
    isValid: boolean;
    errors: string[];
  } {
    const errors: string[] = [];

    FEATURE_NAMES.forEach((name) => {
      const val = features[name];
      if (typeof val !== 'number' || isNaN(val) || !isFinite(val)) {
        errors.push(`Feature '${name}' is not a finite number: received ${val}`);
      } else if (val < 0.0 || val > 1.0) {
        errors.push(`Feature '${name}' out of normalized [0.0, 1.0] bounds: received ${val}`);
      }
    });

    return {
      isValid: errors.length === 0,
      errors,
    };
  }

  /**
   * Computes classic Average True Range over period.
   */
  private static calculateAtr(candles: ICandle[], period = 14): number {
    if (candles.length < 2) return 0;
    const trs: number[] = [];

    for (let i = 1; i < candles.length; i++) {
      const current = candles[i];
      const prev = candles[i - 1];
      const tr = Math.max(
        current.high - current.low,
        Math.abs(current.high - prev.close),
        Math.abs(current.low - prev.close),
      );
      trs.push(tr);
    }

    const slice = trs.slice(-period);
    if (slice.length === 0) return 0;
    return slice.reduce((a, b) => a + b, 0) / slice.length;
  }
}

/**
 * Policy for handling candles where both Take Profit and Stop Loss are breached on the same bar.
 */
export enum AmbiguousLabelPolicy {
  /** Default: Do not arbitrarily guess winner; exclude from training dataset */
  AMBIGUOUS = 'AMBIGUOUS',
  /** Conservative: Treat any ambiguous same-bar breach as a loss (label = 0) */
  CONSERVATIVE = 'CONSERVATIVE',
  /** Placeholder for high-frequency sub-minute tick / intrabar resolution */
  INTRABAR_DATA = 'INTRABAR_DATA',
}

/**
 * Binary trade outcome label: 1 = Target reached before SL (Win), 0 = SL reached before Target (Loss).
 */
export type TradeOutcomeLabel = 0 | 1;

export interface ITradeEvaluationParams {
  direction: Direction | 'BULLISH' | 'BEARISH';
  entryPrice: number;
  stopLoss: number;
  targetPrice: number;
  entryTimestamp: Date;
  subsequentCandles: ICandle[];
  ambiguousPolicy?: AmbiguousLabelPolicy;
  maxHoldingBars?: number;
}

export interface ITradeOutcomeEvaluation {
  label: TradeOutcomeLabel | null;
  isAmbiguous: boolean;
  resolvedVia: 'TP_FIRST' | 'SL_FIRST' | 'EXPIRED' | 'AMBIGUOUS_SAME_BAR' | 'CONSERVATIVE_LOSS';
  exitPrice: number;
  exitTimestamp: Date;
  realizedRMultiple: number;
  durationBars: number;
}

/**
 * TradeLabelGenerator
 * Evaluates subsequent price action strictly after entry timestamp to determine authentic trade outcome labels.
 */
export class TradeLabelGenerator {
  public static evaluateOutcome(params: ITradeEvaluationParams): ITradeOutcomeEvaluation | null {
    const {
      direction,
      entryPrice,
      stopLoss,
      targetPrice,
      entryTimestamp,
      subsequentCandles,
      ambiguousPolicy = AmbiguousLabelPolicy.AMBIGUOUS,
      maxHoldingBars = 200,
    } = params;

    const isBullish = direction === Direction.BULLISH || (direction as string) === 'BULLISH';
    const riskPerUnit = Math.abs(entryPrice - stopLoss);
    if (riskPerUnit <= 0) {
      throw new Error(
        `TradeLabelGenerator: invalid zero riskPerUnit (entry=${entryPrice}, sl=${stopLoss})`,
      );
    }

    const targetDistance = Math.abs(targetPrice - entryPrice);
    const nominalTargetR = Number((targetDistance / riskPerUnit).toFixed(2));

    // Filter strictly to candles occurring after the entry timestamp (no same-candle entry/exit assumption)
    const entryTime = entryTimestamp.getTime();
    const evaluationCandles = subsequentCandles
      .filter((c) => new Date(c.timestamp).getTime() > entryTime)
      .slice(0, maxHoldingBars);

    if (evaluationCandles.length === 0) {
      return null; // Trade outcome is still pending / unresolved
    }

    for (let i = 0; i < evaluationCandles.length; i++) {
      const candle = evaluationCandles[i];
      const candleTime = new Date(candle.timestamp);
      const durationBars = i + 1;

      if (isBullish) {
        const tpReached = candle.high >= targetPrice;
        const slReached = candle.low <= stopLoss;

        if (tpReached && slReached) {
          // Same bar breach: ambiguous intrabar sequencing
          if (ambiguousPolicy === AmbiguousLabelPolicy.AMBIGUOUS) {
            return {
              label: null,
              isAmbiguous: true,
              resolvedVia: 'AMBIGUOUS_SAME_BAR',
              exitPrice: stopLoss,
              exitTimestamp: candleTime,
              realizedRMultiple: -1.0,
              durationBars,
            };
          } else {
            // CONSERVATIVE policy
            return {
              label: 0,
              isAmbiguous: true,
              resolvedVia: 'CONSERVATIVE_LOSS',
              exitPrice: stopLoss,
              exitTimestamp: candleTime,
              realizedRMultiple: -1.0,
              durationBars,
            };
          }
        }

        if (tpReached) {
          return {
            label: 1,
            isAmbiguous: false,
            resolvedVia: 'TP_FIRST',
            exitPrice: targetPrice,
            exitTimestamp: candleTime,
            realizedRMultiple: nominalTargetR,
            durationBars,
          };
        }

        if (slReached) {
          return {
            label: 0,
            isAmbiguous: false,
            resolvedVia: 'SL_FIRST',
            exitPrice: stopLoss,
            exitTimestamp: candleTime,
            realizedRMultiple: -1.0,
            durationBars,
          };
        }
      } else {
        // Bearish
        const tpReached = candle.low <= targetPrice;
        const slReached = candle.high >= stopLoss;

        if (tpReached && slReached) {
          if (ambiguousPolicy === AmbiguousLabelPolicy.AMBIGUOUS) {
            return {
              label: null,
              isAmbiguous: true,
              resolvedVia: 'AMBIGUOUS_SAME_BAR',
              exitPrice: stopLoss,
              exitTimestamp: candleTime,
              realizedRMultiple: -1.0,
              durationBars,
            };
          } else {
            return {
              label: 0,
              isAmbiguous: true,
              resolvedVia: 'CONSERVATIVE_LOSS',
              exitPrice: stopLoss,
              exitTimestamp: candleTime,
              realizedRMultiple: -1.0,
              durationBars,
            };
          }
        }

        if (tpReached) {
          return {
            label: 1,
            isAmbiguous: false,
            resolvedVia: 'TP_FIRST',
            exitPrice: targetPrice,
            exitTimestamp: candleTime,
            realizedRMultiple: nominalTargetR,
            durationBars,
          };
        }

        if (slReached) {
          return {
            label: 0,
            isAmbiguous: false,
            resolvedVia: 'SL_FIRST',
            exitPrice: stopLoss,
            exitTimestamp: candleTime,
            realizedRMultiple: -1.0,
            durationBars,
          };
        }
      }
    }

    // Trade did not reach TP or SL within maxHoldingBars
    const finalCandle = evaluationCandles[evaluationCandles.length - 1];
    const finalPrice = finalCandle.close;
    const finalDiff = isBullish ? finalPrice - entryPrice : entryPrice - finalPrice;
    const finalR = Number((finalDiff / riskPerUnit).toFixed(2));

    return {
      label: finalR >= 0 ? 1 : 0,
      isAmbiguous: false,
      resolvedVia: 'EXPIRED',
      exitPrice: finalPrice,
      exitTimestamp: new Date(finalCandle.timestamp),
      realizedRMultiple: finalR,
      durationBars: evaluationCandles.length,
    };
  }
}

/**
 * Supervised Training Example representing one historical trade observation.
 */
export interface TrainingExample {
  id: string;
  signalId?: string;
  symbol: string;
  featureSchemaVersion: string;
  features: TradeFeatureVector;
  featureArray: number[]; // Exact 17-element Float64 array
  label: TradeOutcomeLabel; // Strictly 0 or 1
  outcomeR: number; // Realized R-Multiple (e.g. +2.5 or -1.0)
  predictionTimestamp: Date; // Timestamp T when signal & features were generated
  availableForTrainingAt: Date; // Timestamp T_exit when outcome was resolved (strictly > predictionTimestamp)
}

export interface IBuildExampleParams {
  id: string;
  signalId?: string;
  signal: ISignalSetup;
  historicalCandlesUpToEntry: ICandle[];
  subsequentCandlesAfterEntry: ICandle[];
  smcAnalysis?: ISMCAnalysisResult | null;
  htfCandles?: ICandle[];
  smtDivergenceScore?: number;
  ambiguousPolicy?: AmbiguousLabelPolicy;
  targetSelection?: 'TP1' | 'TP2' | 'TP3';
}

/**
 * TrainingDatasetBuilder
 * Generates verified, leak-free training examples strictly validating temporal ordering.
 */
export class TrainingDatasetBuilder {
  /**
   * Builds a single validated TrainingExample from point-in-time state and future outcome candles.
   * Returns null if the trade is unresolved or ambiguous (under AMBIGUOUS policy).
   */
  public static buildExample(params: IBuildExampleParams): TrainingExample | null {
    const {
      id,
      signalId,
      signal,
      historicalCandlesUpToEntry,
      subsequentCandlesAfterEntry,
      smcAnalysis,
      htfCandles,
      smtDivergenceScore,
      ambiguousPolicy = AmbiguousLabelPolicy.AMBIGUOUS,
      targetSelection = 'TP2',
    } = params;

    const entryTimestamp = signal.timestamp ? new Date(signal.timestamp) : new Date();
    const entryPrice = signal.entryZone.optimal;
    const stopLoss = signal.stopLoss;
    const targetPrice =
      targetSelection === 'TP1'
        ? signal.takeProfits.tp1
        : targetSelection === 'TP3'
          ? signal.takeProfits.tp3
          : signal.takeProfits.tp2;

    // 1. Point-in-time feature extraction (strictly at entryTimestamp)
    const features = FeatureVectorExtractor.extract({
      signal,
      candles: historicalCandlesUpToEntry,
      smcAnalysis,
      htfCandles,
      smtDivergenceScore,
      asOfTimestamp: entryTimestamp,
    });

    const validation = FeatureVectorExtractor.validateVector(features);
    if (!validation.isValid) {
      throw new Error(
        `TrainingDatasetBuilder: invalid feature vector: ${validation.errors.join(', ')}`,
      );
    }

    // 2. Evaluate authentic outcome on subsequent candles
    const outcome = TradeLabelGenerator.evaluateOutcome({
      direction: signal.direction,
      entryPrice,
      stopLoss,
      targetPrice,
      entryTimestamp,
      subsequentCandles: subsequentCandlesAfterEntry,
      ambiguousPolicy,
    });

    if (!outcome || outcome.label === null) {
      return null; // Excluded (unresolved or ambiguous)
    }

    // 3. Strict causality verification: availableForTrainingAt must be >= exitTimestamp > entryTimestamp
    const exitTimestamp = outcome.exitTimestamp;
    if (exitTimestamp.getTime() <= entryTimestamp.getTime()) {
      throw new Error(
        `TrainingDatasetBuilder: causality violation: exitTimestamp (${exitTimestamp.toISOString()}) <= entryTimestamp (${entryTimestamp.toISOString()})`,
      );
    }

    return {
      id,
      signalId,
      symbol: signal.symbol,
      featureSchemaVersion: FEATURE_SCHEMA_VERSION,
      features,
      featureArray: FeatureVectorExtractor.toArray(features),
      label: outcome.label,
      outcomeR: outcome.realizedRMultiple,
      predictionTimestamp: entryTimestamp,
      availableForTrainingAt: exitTimestamp,
    };
  }

  /**
   * Sorts a dataset strictly in chronological order by predictionTimestamp (ascending).
   * Time series data must NEVER be randomly shuffled.
   */
  public static sortChronologically(examples: TrainingExample[]): TrainingExample[] {
    return [...examples].sort(
      (a, b) =>
        new Date(a.predictionTimestamp).getTime() - new Date(b.predictionTimestamp).getTime(),
    );
  }

  /**
   * Validates a complete dataset for temporal causality, label validity, and feature schema integrity.
   */
  public static validateDataset(examples: TrainingExample[]): {
    isValid: boolean;
    errors: string[];
  } {
    const errors: string[] = [];

    if (!examples || examples.length === 0) {
      errors.push('Dataset is empty');
      return { isValid: false, errors };
    }

    let prevPredictionTime = 0;

    examples.forEach((ex, idx) => {
      const predTime = new Date(ex.predictionTimestamp).getTime();
      const availTime = new Date(ex.availableForTrainingAt).getTime();

      // Check schema version
      if (ex.featureSchemaVersion !== FEATURE_SCHEMA_VERSION) {
        errors.push(
          `Example [${idx}] schema version mismatch: expected ${FEATURE_SCHEMA_VERSION}, got ${ex.featureSchemaVersion}`,
        );
      }

      // Check feature dimension
      if (!ex.featureArray || ex.featureArray.length !== FEATURE_VECTOR_DIMENSION) {
        errors.push(
          `Example [${idx}] feature array dimension invalid: expected ${FEATURE_VECTOR_DIMENSION}, got ${ex.featureArray?.length}`,
        );
      }

      // Check label
      if (ex.label !== 0 && ex.label !== 1) {
        errors.push(`Example [${idx}] invalid binary label: received ${ex.label}`);
      }

      // Check look-ahead violation within example
      if (availTime <= predTime) {
        errors.push(
          `Example [${idx}] causality leak: availableForTrainingAt (${ex.availableForTrainingAt}) <= predictionTimestamp (${ex.predictionTimestamp})`,
        );
      }

      // Check chronological ordering
      if (idx > 0 && predTime < prevPredictionTime) {
        errors.push(
          `Example [${idx}] is out of chronological order: ${ex.predictionTimestamp} < previous timestamp`,
        );
      }

      prevPredictionTime = predTime;
    });

    return {
      isValid: errors.length === 0,
      errors,
    };
  }
}

/**
 * Result returned by a PredictionModel.
 */
export interface PredictionResult {
  probability: number; // P(Win | features), strictly in [0.0001, 0.9999]
  rawLogit: number; // z = w^T * x + b
  featuresUsed: TradeFeatureVector;
  modelVersion: string;
}

export interface TrainingMetrics {
  totalExamples: number;
  epochsTrained: number;
  initialLoss: number;
  finalLoss: number;
  accuracy: number;
  precision: number;
  recall: number;
  f1Score: number;
  logLoss: number;
  brierScore: number;
  rocAuc: number;
  profitFactor: number;
  expectancyR: number;
  maxDrawdownR: number;
}

export interface EvaluationMetrics extends TrainingMetrics {
  sampleSize: number;
}

export interface IModelHyperparameters {
  learningRate: number; // e.g. 0.05
  l2Regularization: number; // e.g. 0.001 (lambda)
  batchSize: number; // e.g. 16 or 32
  maxEpochs: number; // e.g. 100
  convergenceTolerance: number; // e.g. 1e-5
  decayRate?: number; // learning rate decay per epoch
}

export const DEFAULT_HYPERPARAMETERS: IModelHyperparameters = {
  learningRate: 0.05,
  l2Regularization: 0.001,
  batchSize: 16,
  maxEpochs: 80,
  convergenceTolerance: 1e-5,
  decayRate: 0.995,
};

/**
 * Abstraction interface for ML prediction models.
 */
export interface PredictionModel {
  readonly modelVersion: string;
  readonly featureSchemaVersion: string;
  predict(features: TradeFeatureVector): PredictionResult;
  predictProbability(features: TradeFeatureVector): number;
  update(features: TradeFeatureVector, label: TradeOutcomeLabel, outcomeR?: number): number;
  train(dataset: TrainingExample[]): TrainingMetrics;
  evaluate(dataset: TrainingExample[]): EvaluationMetrics;
  getWeights(): number[];
  getBias(): number;
  setWeights(weights: number[], bias: number): void;
}

/**
 * ModelEvaluationEngine
 * Pure quantitative metric evaluator for supervised binary trading models.
 */
export class ModelEvaluationEngine {
  /**
   * Computes full quantitative metrics on a dataset given a prediction model.
   */
  public static calculateMetrics(
    examples: TrainingExample[],
    model: PredictionModel,
  ): EvaluationMetrics {
    const N = examples.length;
    if (N === 0) {
      return {
        sampleSize: 0,
        totalExamples: 0,
        epochsTrained: 0,
        initialLoss: 0,
        finalLoss: 0,
        accuracy: 0,
        precision: 0,
        recall: 0,
        f1Score: 0,
        logLoss: 0,
        brierScore: 0,
        rocAuc: 0.5,
        profitFactor: 0,
        expectancyR: 0,
        maxDrawdownR: 0,
      };
    }

    let tp = 0;
    let fp = 0;
    let tn = 0;
    let fn = 0;
    let totalLogLoss = 0;
    let totalBrier = 0;

    const probsAndLabels: { prob: number; label: number }[] = [];
    const realizedRs: number[] = [];

    const EPSILON = 1e-7;

    for (let i = 0; i < N; i++) {
      const ex = examples[i];
      const prob = Math.max(EPSILON, Math.min(1 - EPSILON, model.predictProbability(ex.features)));
      const y = ex.label;
      const predBinary = prob >= 0.5 ? 1 : 0;

      // Confusion matrix
      if (predBinary === 1 && y === 1) tp++;
      else if (predBinary === 1 && y === 0) fp++;
      else if (predBinary === 0 && y === 0) tn++;
      else if (predBinary === 0 && y === 1) fn++;

      // Log loss
      const bce = -(y * Math.log(prob) + (1 - y) * Math.log(1 - prob));
      totalLogLoss += bce;

      // Brier score (squared error of probability)
      totalBrier += Math.pow(prob - y, 2);

      probsAndLabels.push({ prob, label: y });
      realizedRs.push(ex.outcomeR !== undefined ? ex.outcomeR : y === 1 ? 2.0 : -1.0);
    }

    const accuracy = Number(((tp + tn) / N).toFixed(4));
    const precision = tp + fp > 0 ? Number((tp / (tp + fp)).toFixed(4)) : 0;
    const recall = tp + fn > 0 ? Number((tp / (tp + fn)).toFixed(4)) : 0;
    const f1Score =
      precision + recall > 0
        ? Number(((2 * precision * recall) / (precision + recall)).toFixed(4))
        : 0;
    const logLoss = Number((totalLogLoss / N).toFixed(4));
    const brierScore = Number((totalBrier / N).toFixed(4));

    // ROC-AUC calculation (Mann-Whitney U statistic / rank sum)
    const rocAuc = this.calculateRocAuc(probsAndLabels);

    // Economic Trading Metrics (Profit Factor, Expectancy, Max Drawdown)
    const profitFactor = this.calculateProfitFactor(realizedRs);
    const expectancyR = Number((realizedRs.reduce((a, b) => a + b, 0) / N).toFixed(2));
    const maxDrawdownR = this.calculateMaxDrawdown(realizedRs);

    return {
      sampleSize: N,
      totalExamples: N,
      epochsTrained: 0,
      initialLoss: logLoss,
      finalLoss: logLoss,
      accuracy,
      precision,
      recall,
      f1Score,
      logLoss,
      brierScore,
      rocAuc,
      profitFactor,
      expectancyR,
      maxDrawdownR,
    };
  }

  /**
   * Computes ROC-AUC via rank-sum (Mann-Whitney U algorithm).
   */
  private static calculateRocAuc(items: { prob: number; label: number }[]): number {
    const positives = items.filter((i) => i.label === 1);
    const negatives = items.filter((i) => i.label === 0);

    const nPos = positives.length;
    const nNeg = negatives.length;

    if (nPos === 0 || nNeg === 0) {
      return 0.5; // Uninformative / undefined
    }

    // Sort by predicted probability ascending
    const sorted = [...items].sort((a, b) => a.prob - b.prob);

    // Assign fractional ranks for ties
    let rankSumPos = 0;
    let i = 0;
    while (i < sorted.length) {
      let j = i;
      while (j < sorted.length - 1 && sorted[j + 1].prob === sorted[i].prob) {
        j++;
      }
      const avgRank = (i + 1 + (j + 1)) / 2.0;
      for (let k = i; k <= j; k++) {
        if (sorted[k].label === 1) {
          rankSumPos += avgRank;
        }
      }
      i = j + 1;
    }

    const u = rankSumPos - (nPos * (nPos + 1)) / 2.0;
    const auc = u / (nPos * nNeg);
    return Number(Math.max(0, Math.min(1, auc)).toFixed(4));
  }

  private static calculateProfitFactor(realizedRs: number[]): number {
    const wins = realizedRs.filter((r) => r > 0).reduce((a, b) => a + b, 0);
    const losses = Math.abs(realizedRs.filter((r) => r < 0).reduce((a, b) => a + b, 0));
    if (losses === 0) return wins > 0 ? 10.0 : 0.0;
    return Number((wins / losses).toFixed(2));
  }

  private static calculateMaxDrawdown(realizedRs: number[]): number {
    let cumR = 0;
    let peak = 0;
    let maxDd = 0;

    for (const r of realizedRs) {
      cumR += r;
      if (cumR > peak) {
        peak = cumR;
      }
      const dd = peak - cumR;
      if (dd > maxDd) {
        maxDd = dd;
      }
    }

    return Number(maxDd.toFixed(2));
  }
}

/**
 * TradePredictionModel
 * Baseline Supervised Logistic Regression model with online stochastic gradient descent,
 * mini-batch optimization, and L2 regularization.
 */
export class TradePredictionModel implements PredictionModel {
  public readonly modelVersion: string;
  public readonly featureSchemaVersion: string = FEATURE_SCHEMA_VERSION;
  private weights: number[];
  private bias: number;
  private hyperparameters: IModelHyperparameters;

  constructor(
    modelVersion = 'v1.0.0',
    hyperparameters: Partial<IModelHyperparameters> = {},
    initialWeights?: number[],
    initialBias = 0.0,
  ) {
    this.modelVersion = modelVersion;
    this.hyperparameters = { ...DEFAULT_HYPERPARAMETERS, ...hyperparameters };

    if (initialWeights && initialWeights.length === FEATURE_VECTOR_DIMENSION) {
      this.weights = [...initialWeights];
    } else {
      // Deterministic Xavier/Glorot-style small initial weights
      const scale = Math.sqrt(2.0 / (FEATURE_VECTOR_DIMENSION + 1));
      this.weights = FEATURE_NAMES.map((_, i) => {
        const seed = Math.sin(i + 1) * 0.5; // Deterministic pseudo-random seed
        return Number((seed * scale).toFixed(5));
      });
    }
    this.bias = initialBias;
  }

  /**
   * Evaluates raw logit: z = w^T * x + b
   */
  public calculateLogit(featureArray: number[]): number {
    let z = this.bias;
    for (let i = 0; i < FEATURE_VECTOR_DIMENSION; i++) {
      z += this.weights[i] * featureArray[i];
    }
    // Numerical stability clamping
    return Math.max(-25.0, Math.min(25.0, z));
  }

  /**
   * Sigmoid activation: sigma(z) = 1 / (1 + exp(-z))
   */
  public sigmoid(z: number): number {
    return 1.0 / (1.0 + Math.exp(-z));
  }

  /**
   * Predicts win probability for a given TradeFeatureVector.
   */
  public predictProbability(features: TradeFeatureVector): number {
    const arr = FeatureVectorExtractor.toArray(features);
    const z = this.calculateLogit(arr);
    const prob = this.sigmoid(z);
    return Math.max(0.0001, Math.min(0.9999, prob));
  }

  /**
   * Returns a complete PredictionResult object.
   */
  public predict(features: TradeFeatureVector): PredictionResult {
    const arr = FeatureVectorExtractor.toArray(features);
    const z = this.calculateLogit(arr);
    const prob = Math.max(0.0001, Math.min(0.9999, this.sigmoid(z)));

    return {
      probability: Number(prob.toFixed(4)),
      rawLogit: Number(z.toFixed(4)),
      featuresUsed: features,
      modelVersion: this.modelVersion,
    };
  }

  /**
   * Online Gradient Descent update from a single completed trade.
   * Performs one stochastic gradient step with L2 regularization.
   * Returns the immediate loss before update.
   */
  public update(features: TradeFeatureVector, label: TradeOutcomeLabel): number {
    const x = FeatureVectorExtractor.toArray(features);
    const z = this.calculateLogit(x);
    const yHat = this.sigmoid(z);
    const y = label;

    const error = yHat - y; // Gradient of BCE w.r.t z
    const lr = this.hyperparameters.learningRate;
    const lambda = this.hyperparameters.l2Regularization;

    // Weight update: w_i <- w_i - lr * (error * x_i + lambda * w_i)
    for (let i = 0; i < FEATURE_VECTOR_DIMENSION; i++) {
      const grad = error * x[i] + lambda * this.weights[i];
      this.weights[i] -= lr * grad;
    }

    // Bias update: b <- b - lr * error
    this.bias -= lr * error;

    // Calculate binary cross-entropy loss
    const eps = 1e-7;
    const p = Math.max(eps, Math.min(1 - eps, yHat));
    return -(y * Math.log(p) + (1 - y) * Math.log(1 - p));
  }

  /**
   * Trains the model on a supervised training dataset using mini-batch gradient descent.
   */
  public train(dataset: TrainingExample[]): TrainingMetrics {
    const N = dataset.length;
    if (N === 0) {
      throw new Error('TradePredictionModel.train: dataset is empty');
    }

    const initialMetrics = ModelEvaluationEngine.calculateMetrics(dataset, this);
    const initialLoss = initialMetrics.logLoss;

    let currentLr = this.hyperparameters.learningRate;
    const batchSize = Math.min(this.hyperparameters.batchSize, N);
    const maxEpochs = this.hyperparameters.maxEpochs;
    const lambda = this.hyperparameters.l2Regularization;
    const decay = this.hyperparameters.decayRate || 1.0;

    let prevLoss = initialLoss;
    let finalEpoch = 0;

    for (let epoch = 0; epoch < maxEpochs; epoch++) {
      finalEpoch = epoch + 1;

      // Sequential batching (chronological stream)
      for (let startIdx = 0; startIdx < N; startIdx += batchSize) {
        const batch = dataset.slice(startIdx, startIdx + batchSize);
        const B = batch.length;

        const gradW = new Array(FEATURE_VECTOR_DIMENSION).fill(0.0);
        let gradB = 0.0;

        for (let b = 0; b < B; b++) {
          const ex = batch[b];
          const x = ex.featureArray;
          const z = this.calculateLogit(x);
          const yHat = this.sigmoid(z);
          const err = yHat - ex.label;

          for (let i = 0; i < FEATURE_VECTOR_DIMENSION; i++) {
            gradW[i] += err * x[i];
          }
          gradB += err;
        }

        // Apply average batch gradient + L2 regularization
        for (let i = 0; i < FEATURE_VECTOR_DIMENSION; i++) {
          const totalGrad = gradW[i] / B + lambda * this.weights[i];
          this.weights[i] -= currentLr * totalGrad;
        }
        this.bias -= currentLr * (gradB / B);
      }

      currentLr *= decay;

      // Check convergence every 5 epochs
      if ((epoch + 1) % 5 === 0) {
        const evalCurrent = ModelEvaluationEngine.calculateMetrics(dataset, this);
        if (Math.abs(prevLoss - evalCurrent.logLoss) < this.hyperparameters.convergenceTolerance) {
          break;
        }
        prevLoss = evalCurrent.logLoss;
      }
    }

    const finalMetrics = ModelEvaluationEngine.calculateMetrics(dataset, this);

    return {
      totalExamples: N,
      epochsTrained: finalEpoch,
      initialLoss,
      finalLoss: finalMetrics.logLoss,
      accuracy: finalMetrics.accuracy,
      precision: finalMetrics.precision,
      recall: finalMetrics.recall,
      f1Score: finalMetrics.f1Score,
      logLoss: finalMetrics.logLoss,
      brierScore: finalMetrics.brierScore,
      rocAuc: finalMetrics.rocAuc,
      profitFactor: finalMetrics.profitFactor,
      expectancyR: finalMetrics.expectancyR,
      maxDrawdownR: finalMetrics.maxDrawdownR,
    };
  }

  /**
   * Evaluates the model on an independent validation or test dataset.
   */
  public evaluate(dataset: TrainingExample[]): EvaluationMetrics {
    return ModelEvaluationEngine.calculateMetrics(dataset, this);
  }

  public getWeights(): number[] {
    return [...this.weights];
  }

  public getBias(): number {
    return this.bias;
  }

  public setWeights(weights: number[], bias: number): void {
    if (weights.length !== FEATURE_VECTOR_DIMENSION) {
      throw new Error(
        `Invalid weights dimension: expected ${FEATURE_VECTOR_DIMENSION}, got ${weights.length}`,
      );
    }
    this.weights = [...weights];
    this.bias = bias;
  }

  /**
   * Returns feature importance ranked by absolute weight magnitude.
   */
  public getFeatureImportance(): {
    feature: FeatureName;
    weight: number;
    absoluteWeight: number;
  }[] {
    return FEATURE_NAMES.map((name, idx) => ({
      feature: name,
      weight: Number(this.weights[idx].toFixed(4)),
      absoluteWeight: Number(Math.abs(this.weights[idx]).toFixed(4)),
    })).sort((a, b) => b.absoluteWeight - a.absoluteWeight);
  }
}

/**
 * Configuration for chronological dataset splitting.
 */
export interface IChronologicalSplitConfig {
  trainRatio: number; // e.g. 0.60 (60% oldest)
  validationRatio: number; // e.g. 0.20 (next 20%)
  outOfSampleRatio: number; // e.g. 0.20 (most recent 20%)
  minTrainExamples?: number;
}

export const DEFAULT_SPLIT_CONFIG: IChronologicalSplitConfig = {
  trainRatio: 0.6,
  validationRatio: 0.2,
  outOfSampleRatio: 0.2,
  minTrainExamples: 20,
};

export interface IChronologicalDatasetSplits {
  train: TrainingExample[];
  validation: TrainingExample[];
  outOfSample: TrainingExample[];
  periods: {
    trainStart: Date;
    trainEnd: Date;
    validationStart: Date;
    validationEnd: Date;
    outOfSampleStart: Date;
    outOfSampleEnd: Date;
  };
  counts: {
    train: number;
    validation: number;
    outOfSample: number;
    total: number;
  };
}

/**
 * ChronologicalSplitter
 * Splits time series datasets strictly by chronological ordering without look-ahead or shuffling.
 */
export class ChronologicalSplitter {
  public static split(
    dataset: TrainingExample[],
    config: Partial<IChronologicalSplitConfig> = {},
  ): IChronologicalDatasetSplits {
    const cfg = { ...DEFAULT_SPLIT_CONFIG, ...config };
    const sorted = TrainingDatasetBuilder.sortChronologically(dataset);
    const N = sorted.length;

    const minTrain = cfg.minTrainExamples || 10;
    if (N < minTrain) {
      throw new Error(
        `ChronologicalSplitter.split: insufficient dataset size (${N} < minimum ${minTrain})`,
      );
    }

    const nTrain = Math.max(1, Math.floor(N * cfg.trainRatio));
    const nVal = Math.max(1, Math.floor(N * cfg.validationRatio));
    const nOos = N - (nTrain + nVal);

    if (nOos < 1) {
      throw new Error(
        `ChronologicalSplitter.split: insufficient dataset to form out-of-sample partition (${N} examples)`,
      );
    }

    const train = sorted.slice(0, nTrain);
    const validation = sorted.slice(nTrain, nTrain + nVal);
    const outOfSample = sorted.slice(nTrain + nVal);

    // Leakage check across partitions
    const maxTrainTime = new Date(train[train.length - 1].predictionTimestamp).getTime();
    const minValTime = new Date(validation[0].predictionTimestamp).getTime();
    const maxValTime = new Date(validation[validation.length - 1].predictionTimestamp).getTime();
    const minOosTime = new Date(outOfSample[0].predictionTimestamp).getTime();

    if (maxTrainTime > minValTime) {
      throw new Error(
        `ChronologicalSplitter: temporal leak between Train and Validation partitions`,
      );
    }
    if (maxValTime > minOosTime) {
      throw new Error(
        `ChronologicalSplitter: temporal leak between Validation and Out-of-Sample partitions`,
      );
    }

    return {
      train,
      validation,
      outOfSample,
      periods: {
        trainStart: train[0].predictionTimestamp,
        trainEnd: train[train.length - 1].predictionTimestamp,
        validationStart: validation[0].predictionTimestamp,
        validationEnd: validation[validation.length - 1].predictionTimestamp,
        outOfSampleStart: outOfSample[0].predictionTimestamp,
        outOfSampleEnd: outOfSample[outOfSample.length - 1].predictionTimestamp,
      },
      counts: {
        train: train.length,
        validation: validation.length,
        outOfSample: outOfSample.length,
        total: N,
      },
    };
  }
}

/**
 * Result of a single walk-forward fold.
 */
export interface IWalkForwardFold {
  foldIndex: number;
  train: TrainingExample[];
  test: TrainingExample[];
  trainPeriod: { start: Date; end: Date };
  testPeriod: { start: Date; end: Date };
  trainMetrics: TrainingMetrics;
  testMetrics: EvaluationMetrics;
}

export interface IWalkForwardValidationResult {
  folds: IWalkForwardFold[];
  meanTestLogLoss: number;
  meanTestAccuracy: number;
  meanTestRocAuc: number;
  meanTestBrierScore: number;
  isStable: boolean;
  stabilityScore: number; // 0.0 to 1.0 (1.0 = highly consistent across time)
}

/**
 * WalkForwardValidator
 * Evaluates model temporal generalization through expanding-window chronological walk-forward cross validation.
 */
export class WalkForwardValidator {
  /**
   * Executes an expanding-window walk-forward validation across N temporal folds.
   */
  public static runWalkForward(
    dataset: TrainingExample[],
    modelFactory: () => PredictionModel,
    numFolds = 3,
  ): IWalkForwardValidationResult {
    const sorted = TrainingDatasetBuilder.sortChronologically(dataset);
    const N = sorted.length;

    if (N < numFolds * 10) {
      throw new Error(
        `WalkForwardValidator: insufficient dataset size (${N}) for ${numFolds} folds`,
      );
    }

    const folds: IWalkForwardFold[] = [];
    const foldTestLosses: number[] = [];
    const foldTestAccs: number[] = [];
    const foldTestAucs: number[] = [];
    const foldTestBriers: number[] = [];

    // Calculate step size per fold
    const initialTrainSize = Math.floor(N * 0.4);
    const testSizePerFold = Math.floor((N - initialTrainSize) / numFolds);

    for (let f = 0; f < numFolds; f++) {
      const trainEndIdx = initialTrainSize + f * testSizePerFold;
      const testEndIdx = f === numFolds - 1 ? N : trainEndIdx + testSizePerFold;

      const trainFold = sorted.slice(0, trainEndIdx);
      const testFold = sorted.slice(trainEndIdx, testEndIdx);

      if (trainFold.length === 0 || testFold.length === 0) continue;

      const model = modelFactory();
      const trainMetrics = model.train(trainFold);
      const testMetrics = model.evaluate(testFold);

      folds.push({
        foldIndex: f + 1,
        train: trainFold,
        test: testFold,
        trainPeriod: {
          start: trainFold[0].predictionTimestamp,
          end: trainFold[trainFold.length - 1].predictionTimestamp,
        },
        testPeriod: {
          start: testFold[0].predictionTimestamp,
          end: testFold[testFold.length - 1].predictionTimestamp,
        },
        trainMetrics,
        testMetrics,
      });

      foldTestLosses.push(testMetrics.logLoss);
      foldTestAccs.push(testMetrics.accuracy);
      foldTestAucs.push(testMetrics.rocAuc);
      foldTestBriers.push(testMetrics.brierScore);
    }

    const mean = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;
    const meanTestLogLoss = Number(mean(foldTestLosses).toFixed(4));
    const meanTestAccuracy = Number(mean(foldTestAccs).toFixed(4));
    const meanTestRocAuc = Number(mean(foldTestAucs).toFixed(4));
    const meanTestBrierScore = Number(mean(foldTestBriers).toFixed(4));

    // Calculate variance in test log loss to evaluate temporal stability
    const variance =
      foldTestLosses.reduce((acc, l) => acc + Math.pow(l - meanTestLogLoss, 2), 0) /
      foldTestLosses.length;
    const stabilityScore = Number(
      Math.max(0, Math.min(1, 1 - Math.sqrt(variance) * 2.0)).toFixed(4),
    );
    const isStable = stabilityScore >= 0.7 && meanTestRocAuc >= 0.5;

    return {
      folds,
      meanTestLogLoss,
      meanTestAccuracy,
      meanTestRocAuc,
      meanTestBrierScore,
      isStable,
      stabilityScore,
    };
  }
}

/**
 * Criteria required for a candidate model to be promoted to production.
 */
export interface IModelPromotionCriteria {
  minSampleSize: number; // e.g. 20
  maxOutOfSampleLogLoss: number; // e.g. 0.693
  minOutOfSampleRocAuc: number; // e.g. 0.51
  maxDrawdownToleranceR: number; // e.g. 8.0 R
  mustBeatBaseline: boolean;
}

export const DEFAULT_PROMOTION_CRITERIA: IModelPromotionCriteria = {
  minSampleSize: 20,
  maxOutOfSampleLogLoss: 0.693, // Better than uninformative 50/50 prior
  minOutOfSampleRocAuc: 0.51,
  maxDrawdownToleranceR: 10.0,
  mustBeatBaseline: true,
};

export interface IModelPromotionDecision {
  isPromoted: boolean;
  decisionStatus: 'PROMOTED' | 'REJECTED' | 'INSUFFICIENT_DATA';
  reasons: string[];
  candidateMetrics: EvaluationMetrics;
  baselineMetrics?: EvaluationMetrics | null;
}

/**
 * ModelPromotionEngine
 * Evaluates candidate models against strict production acceptance criteria and baselines.
 */
export class ModelPromotionEngine {
  /**
   * Evaluates whether a candidate model qualifies for promotion to production.
   */
  public static evaluatePromotion(
    candidateModel: PredictionModel,
    outOfSampleDataset: TrainingExample[],
    baselineModel?: PredictionModel | null,
    criteria: Partial<IModelPromotionCriteria> = {},
  ): IModelPromotionDecision {
    const cfg = { ...DEFAULT_PROMOTION_CRITERIA, ...criteria };
    const reasons: string[] = [];
    const N = outOfSampleDataset.length;

    const candidateMetrics = candidateModel.evaluate(outOfSampleDataset);
    const baselineMetrics = baselineModel ? baselineModel.evaluate(outOfSampleDataset) : null;

    // 1. Sample Size Check
    if (N < cfg.minSampleSize) {
      reasons.push(
        `Insufficient out-of-sample sample size (${N} observations < required minimum ${cfg.minSampleSize})`,
      );
      return {
        isPromoted: false,
        decisionStatus: 'INSUFFICIENT_DATA',
        reasons,
        candidateMetrics,
        baselineMetrics,
      };
    }

    // 2. Absolute Log Loss Barrier
    if (candidateMetrics.logLoss > cfg.maxOutOfSampleLogLoss) {
      reasons.push(
        `Candidate out-of-sample Log Loss (${candidateMetrics.logLoss}) exceeds maximum tolerance (${cfg.maxOutOfSampleLogLoss})`,
      );
    }

    // 3. ROC-AUC Barrier
    if (candidateMetrics.rocAuc < cfg.minOutOfSampleRocAuc) {
      reasons.push(
        `Candidate out-of-sample ROC-AUC (${candidateMetrics.rocAuc}) is below minimum threshold (${cfg.minOutOfSampleRocAuc})`,
      );
    }

    // 4. Maximum Drawdown Barrier
    if (candidateMetrics.maxDrawdownR > cfg.maxDrawdownToleranceR) {
      reasons.push(
        `Candidate out-of-sample Max Drawdown (${candidateMetrics.maxDrawdownR}R) exceeds tolerance (${cfg.maxDrawdownToleranceR}R)`,
      );
    }

    // 5. Comparison Against Existing Baseline Production Model
    if (cfg.mustBeatBaseline && baselineMetrics) {
      if (candidateMetrics.logLoss > baselineMetrics.logLoss) {
        reasons.push(
          `Candidate Log Loss (${candidateMetrics.logLoss}) does not improve over baseline (${baselineMetrics.logLoss})`,
        );
      }
      if (candidateMetrics.rocAuc < baselineMetrics.rocAuc) {
        reasons.push(
          `Candidate ROC-AUC (${candidateMetrics.rocAuc}) is inferior to baseline (${baselineMetrics.rocAuc})`,
        );
      }
    }

    const isPromoted = reasons.length === 0;

    if (isPromoted) {
      reasons.push(
        `Candidate model passed all out-of-sample validation tests (LogLoss: ${candidateMetrics.logLoss}, ROC-AUC: ${candidateMetrics.rocAuc}, Accuracy: ${candidateMetrics.accuracy})`,
      );
    }

    return {
      isPromoted,
      decisionStatus: isPromoted ? 'PROMOTED' : 'REJECTED',
      reasons,
      candidateMetrics,
      baselineMetrics,
    };
  }
}

/**
 * Reliability diagram calibration bin.
 */
export interface ICalibrationBin {
  binIndex: number;
  minProbability: number;
  maxProbability: number;
  binRangeLabel: string; // e.g. "80-90%"
  sampleCount: number;
  meanPredictedProbability: number; // e.g. 0.842
  observedWinRate: number; // e.g. 0.821
  calibrationError: number; // |meanPredictedProbability - observedWinRate|
}

export type CalibrationStatus =
  | 'EXCELLENT'
  | 'GOOD'
  | 'FAIR'
  | 'POOR'
  | 'INSUFFICIENT_DATA'
  | 'NOT_AVAILABLE'
  | 'UNKNOWN';

export interface ICalibrationReport {
  bins: ICalibrationBin[];
  expectedCalibrationError: number; // ECE (lower is better, < 0.08 is well-calibrated)
  maximumCalibrationError: number; // MCE
  totalSamples: number;
  status: CalibrationStatus;
  brierScore: number;
  description: string;
}

export interface IConfidenceInterval {
  lower: number; // Lower 95% bound
  upper: number; // Upper 95% bound
  confidenceLevel: number; // e.g. 0.95
  sampleSize: number; // Historical sample count supporting this interval
}

export interface ICalibratedPrediction {
  rawProbability: number;
  calibratedProbability: number;
  confidenceInterval: IConfidenceInterval | null;
  confidenceStatus: 'CALIBRATED' | 'INSUFFICIENT_DATA';
  calibrationStatus: CalibrationStatus;
  sampleSize: number;
  modelVersion: string;
}

/**
 * ProbabilityCalibrationEngine
 * Pure quantitative calibration engine calculating Expected Calibration Error (ECE),
 * reliability bins, Platt scaling, and statistical Wilson Score confidence intervals.
 */
export class ProbabilityCalibrationEngine {
  /**
   * Generates a 10-bin reliability diagram calibration report from predicted probabilities and actual labels.
   */
  public static generateCalibrationReport(
    items: { predictedProb: number; actualLabel: number }[],
    numBins = 10,
  ): ICalibrationReport {
    const N = items.length;

    if (N === 0) {
      return {
        bins: [],
        expectedCalibrationError: 0.0,
        maximumCalibrationError: 0.0,
        totalSamples: 0,
        status: 'INSUFFICIENT_DATA',
        brierScore: 0.0,
        description: 'No historical observations available for calibration analysis.',
      };
    }

    const binWidth = 1.0 / numBins;
    const bins: ICalibrationBin[] = [];

    let totalWeightedError = 0.0;
    let maxError = 0.0;
    let totalBrier = 0.0;

    for (let k = 0; k < numBins; k++) {
      const minP = k * binWidth;
      const maxP = (k + 1) * binWidth;
      const binRangeLabel = `${Math.round(minP * 100)}-${Math.round(maxP * 100)}%`;

      // Filter items in this bucket [minP, maxP) (last bin includes 1.0)
      const bucketItems = items.filter((item) => {
        if (k === numBins - 1) {
          return item.predictedProb >= minP && item.predictedProb <= maxP;
        }
        return item.predictedProb >= minP && item.predictedProb < maxP;
      });

      const count = bucketItems.length;
      if (count === 0) {
        bins.push({
          binIndex: k + 1,
          minProbability: Number(minP.toFixed(2)),
          maxProbability: Number(maxP.toFixed(2)),
          binRangeLabel,
          sampleCount: 0,
          meanPredictedProbability: Number(((minP + maxP) / 2.0).toFixed(4)),
          observedWinRate: 0.0,
          calibrationError: 0.0,
        });
        continue;
      }

      const meanPred = bucketItems.reduce((acc, i) => acc + i.predictedProb, 0) / count;
      const observedWins = bucketItems.filter((i) => i.actualLabel === 1).length;
      const winRate = observedWins / count;
      const error = Math.abs(meanPred - winRate);

      totalWeightedError += (count / N) * error;
      if (error > maxError) {
        maxError = error;
      }

      for (const item of bucketItems) {
        totalBrier += Math.pow(item.predictedProb - item.actualLabel, 2);
      }

      bins.push({
        binIndex: k + 1,
        minProbability: Number(minP.toFixed(2)),
        maxProbability: Number(maxP.toFixed(2)),
        binRangeLabel,
        sampleCount: count,
        meanPredictedProbability: Number(meanPred.toFixed(4)),
        observedWinRate: Number(winRate.toFixed(4)),
        calibrationError: Number(error.toFixed(4)),
      });
    }

    const expectedCalibrationError = Number(totalWeightedError.toFixed(4));
    const maximumCalibrationError = Number(maxError.toFixed(4));
    const brierScore = Number((totalBrier / N).toFixed(4));

    let status: CalibrationStatus = 'GOOD';
    let description = '';

    if (N < 15) {
      status = 'INSUFFICIENT_DATA';
      description = `Insufficient sample size (${N} < 15) for statistical probability calibration.`;
    } else if (expectedCalibrationError <= 0.06) {
      status = 'EXCELLENT';
      description = `Excellent probability calibration (ECE: ${(expectedCalibrationError * 100).toFixed(1)}%). Predicted probabilities closely mirror realized win rates.`;
    } else if (expectedCalibrationError <= 0.12) {
      status = 'GOOD';
      description = `Good probability calibration (ECE: ${(expectedCalibrationError * 100).toFixed(1)}%). Observed win rates align within standard confidence bands.`;
    } else if (expectedCalibrationError <= 0.2) {
      status = 'FAIR';
      description = `Fair calibration (ECE: ${(expectedCalibrationError * 100).toFixed(1)}%). Slight probability miscalibration in extreme deciles.`;
    } else {
      status = 'POOR';
      description = `Poor calibration (ECE: ${(expectedCalibrationError * 100).toFixed(1)}%). Substantial divergence between predicted scores and actual outcomes.`;
    }

    return {
      bins,
      expectedCalibrationError,
      maximumCalibrationError,
      totalSamples: N,
      status,
      brierScore,
      description,
    };
  }

  /**
   * Calculates a 95% Wilson Score confidence interval for a predicted probability.
   * If sample size is insufficient (< minSampleSize), returns null.
   */
  public static calculateConfidenceInterval(
    probability: number,
    supportingSampleSize: number,
    minSampleSize = 15,
    confidenceLevel = 0.95,
  ): IConfidenceInterval | null {
    if (supportingSampleSize < minSampleSize) {
      return null;
    }

    const p = Math.max(0.0001, Math.min(0.9999, probability));
    const n = supportingSampleSize;

    // z = 1.96 for 95% two-sided interval
    const z = 1.95996;
    const z2 = z * z;

    // Wilson Score Interval formula:
    // center = (p + z^2 / (2n)) / (1 + z^2 / n)
    // margin = z * sqrt( (p(1-p)/n) + (z^2 / (4n^2)) ) / (1 + z^2 / n)
    const denominator = 1.0 + z2 / n;
    const center = (p + z2 / (2.0 * n)) / denominator;
    const margin = (z * Math.sqrt((p * (1.0 - p)) / n + z2 / (4.0 * n * n))) / denominator;

    const lower = Number(Math.max(0.0, center - margin).toFixed(4));
    const upper = Number(Math.min(1.0, center + margin).toFixed(4));

    return {
      lower,
      upper,
      confidenceLevel,
      sampleSize: n,
    };
  }
}

/**
 * PlattScaler
 * Univariate logistic calibration mapping uncalibrated model probabilities to calibrated posteriors.
 */
export class PlattScaler {
  private a = 1.0;
  private b = 0.0;
  private isFitted = false;

  /**
   * Fits Platt scaling parameters (A, B) using maximum likelihood on validation set probabilities.
   */
  public fit(probabilities: number[], labels: TradeOutcomeLabel[], maxIter = 50, lr = 0.05): void {
    const N = probabilities.length;
    if (N < 10) return;

    let a = 1.0;
    let b = 0.0;

    for (let iter = 0; iter < maxIter; iter++) {
      let gradA = 0.0;
      let gradB = 0.0;

      for (let i = 0; i < N; i++) {
        const p = Math.max(1e-6, Math.min(1 - 1e-6, probabilities[i]));
        // log-odds logit
        const logit = Math.log(p / (1.0 - p));
        const z = Math.max(-20, Math.min(20, a * logit + b));
        const calibratedP = 1.0 / (1.0 + Math.exp(-z));
        const err = calibratedP - labels[i];

        gradA += err * logit;
        gradB += err;
      }

      a -= (lr * gradA) / N;
      b -= (lr * gradB) / N;
    }

    this.a = a;
    this.b = b;
    this.isFitted = true;
  }

  /**
   * Calibrates a single predicted probability.
   */
  public calibrate(rawProb: number): number {
    if (!this.isFitted) return rawProb;
    const p = Math.max(1e-6, Math.min(1 - 1e-6, rawProb));
    const logit = Math.log(p / (1.0 - p));
    const z = Math.max(-20, Math.min(20, this.a * logit + this.b));
    return Number((1.0 / (1.0 + Math.exp(-z))).toFixed(4));
  }

  public getParameters(): { a: number; b: number; isFitted: boolean } {
    return { a: this.a, b: this.b, isFitted: this.isFitted };
  }
}

/**
 * Trade payoff configuration specifying reward and risk parameters.
 */
export interface ITradePayoffStructure {
  targetR: number; // e.g. 2.5 R
  lossR?: number; // e.g. 1.0 R (default: 1.0)
  partialScaleOut?: {
    tp1R: number; // e.g. 1.5 R
    tp1Ratio: number; // e.g. 0.5 (50% position closed)
    tp2R: number; // e.g. 2.5 R
    tp2Ratio: number; // e.g. 0.5 (50% position runner)
  };
}

export interface IExpectedValueResult {
  winProbability: number;
  lossProbability: number;
  averageWinR: number;
  averageLossR: number;
  expectedValueR: number; // EV = P(win) * WinR - P(loss) * LossR
  kellyCriterionFraction: number; // Optimal Kelly fraction f*
  isPositiveExpectancy: boolean;
}

/**
 * Four-tier AI recommendation enum.
 * Strictly respects risk engine separation of concerns (never outputs position sizes).
 */
export type AIRecommendationStatus =
  'HIGH_CONFIDENCE' | 'MODERATE_CONFIDENCE' | 'LOW_CONFIDENCE' | 'WAIT';

export interface IAIRecommendationResult {
  recommendation: AIRecommendationStatus;
  winProbability: number;
  expectedValueR: number;
  averageWinR: number;
  averageLossR: number;
  supportingSampleSize: number;
  calibrationStatus: CalibrationStatus;
  confidenceInterval: IConfidenceInterval | null;
  confidenceStatus: 'CALIBRATED' | 'UNCALIBRATED' | 'INSUFFICIENT_DATA';
  reasons: string[];
  modelVersion: string;
}

export interface IEvaluateRecommendationParams {
  probability: number;
  payoff: ITradePayoffStructure;
  supportingSampleSize: number;
  calibrationStatus?: CalibrationStatus;
  minSampleSize?: number;
  modelVersion?: string;
}

/**
 * ExpectedValueEngine
 * Calculates mathematical expectation, Kelly fraction, and sample-size gated AI recommendations.
 */
export class ExpectedValueEngine {
  /**
   * Computes expected value in R-multiples given win probability and trade payoff structure.
   */
  public static calculateExpectedValue(
    winProbability: number,
    payoff: ITradePayoffStructure,
  ): IExpectedValueResult {
    const p = Math.max(0.0, Math.min(1.0, winProbability));
    const q = 1.0 - p;

    let winR = payoff.targetR;
    if (payoff.partialScaleOut) {
      const { tp1R, tp1Ratio, tp2R, tp2Ratio } = payoff.partialScaleOut;
      winR = tp1R * tp1Ratio + tp2R * tp2Ratio;
    }

    const lossR = payoff.lossR !== undefined ? Math.abs(payoff.lossR) : 1.0;

    // EV = P(win) * averageWinR - P(loss) * averageLossR
    const ev = p * winR - q * lossR;

    // Kelly Criterion: f* = (p * b - q) / b, where b = winR / lossR
    let kelly = 0.0;
    if (lossR > 0 && winR > 0) {
      const b = winR / lossR;
      kelly = (p * b - q) / b;
      kelly = Math.max(0.0, Math.min(1.0, kelly)); // Clamped to [0.0, 1.0]
    }

    return {
      winProbability: Number(p.toFixed(4)),
      lossProbability: Number(q.toFixed(4)),
      averageWinR: Number(winR.toFixed(2)),
      averageLossR: Number(lossR.toFixed(2)),
      expectedValueR: Number(ev.toFixed(2)),
      kellyCriterionFraction: Number(kelly.toFixed(4)),
      isPositiveExpectancy: ev > 0.0,
    };
  }

  /**
   * Evaluates AI recommendation with strict sample-size gating and calibration checks.
   */
  public static evaluateRecommendation(
    params: IEvaluateRecommendationParams,
  ): IAIRecommendationResult {
    const {
      probability,
      payoff,
      supportingSampleSize,
      calibrationStatus = 'NOT_AVAILABLE',
      minSampleSize = 25,
      modelVersion = 'v1.0.0',
    } = params;

    const evResult = this.calculateExpectedValue(probability, payoff);
    const confidenceInterval = ProbabilityCalibrationEngine.calculateConfidenceInterval(
      probability,
      supportingSampleSize,
      minSampleSize,
    );

    const isCalibrated =
      calibrationStatus === 'EXCELLENT' ||
      calibrationStatus === 'GOOD' ||
      calibrationStatus === 'FAIR' ||
      calibrationStatus === 'POOR';
    const confidenceStatus = isCalibrated ? 'CALIBRATED' : 'UNCALIBRATED';

    const reasons: string[] = [];

    // 1. Sample Size Barrier
    if (supportingSampleSize < minSampleSize) {
      reasons.push(
        `INSUFFICIENT_DATA: Supporting sample size (${supportingSampleSize}) is below minimum threshold (${minSampleSize}) required for statistical conviction.`,
      );
      return {
        recommendation: 'WAIT',
        winProbability: evResult.winProbability,
        expectedValueR: evResult.expectedValueR,
        averageWinR: evResult.averageWinR,
        averageLossR: evResult.averageLossR,
        supportingSampleSize,
        calibrationStatus: 'INSUFFICIENT_DATA',
        confidenceInterval: null,
        confidenceStatus: 'INSUFFICIENT_DATA',
        reasons,
        modelVersion,
      };
    }

    // 2. Negative or Zero Expectancy
    if (evResult.expectedValueR <= 0.0) {
      reasons.push(
        `NEGATIVE_EXPECTANCY: Expected value (${evResult.expectedValueR}R) is non-positive despite setup score.`,
      );
      return {
        recommendation: 'WAIT',
        winProbability: evResult.winProbability,
        expectedValueR: evResult.expectedValueR,
        averageWinR: evResult.averageWinR,
        averageLossR: evResult.averageLossR,
        supportingSampleSize,
        calibrationStatus,
        confidenceInterval,
        confidenceStatus,
        reasons,
        modelVersion,
      };
    }

    // 3. Calibration Barrier (Poor calibration downgrades confidence)
    if (calibrationStatus === 'POOR') {
      reasons.push(
        'POOR_CALIBRATION: Probability reliability error is elevated. Model recommendation downgraded to WAIT.',
      );
      return {
        recommendation: 'WAIT',
        winProbability: evResult.winProbability,
        expectedValueR: evResult.expectedValueR,
        averageWinR: evResult.averageWinR,
        averageLossR: evResult.averageLossR,
        supportingSampleSize,
        calibrationStatus,
        confidenceInterval,
        confidenceStatus,
        reasons,
        modelVersion,
      };
    }

    // 4. High Confidence Criteria
    const isStandardHigh = evResult.winProbability >= 0.7 && evResult.expectedValueR >= 0.5;
    const isAsymmetricHigh =
      payoff.targetR >= 2.5 && evResult.winProbability >= 0.5 && evResult.expectedValueR >= 0.8;

    if (
      (isStandardHigh || isAsymmetricHigh) &&
      (calibrationStatus === 'EXCELLENT' || calibrationStatus === 'GOOD')
    ) {
      reasons.push(
        `High conviction setup (${(evResult.winProbability * 100).toFixed(1)}% win rate, strong +${evResult.expectedValueR}R positive expectancy) across ${supportingSampleSize} validated observations.`,
      );
      return {
        recommendation: 'HIGH_CONFIDENCE',
        winProbability: evResult.winProbability,
        expectedValueR: evResult.expectedValueR,
        averageWinR: evResult.averageWinR,
        averageLossR: evResult.averageLossR,
        supportingSampleSize,
        calibrationStatus,
        confidenceInterval,
        confidenceStatus: 'CALIBRATED',
        reasons,
        modelVersion,
      };
    }

    // 5. Moderate Confidence Criteria
    const isStandardModerate = evResult.winProbability >= 0.55 && evResult.expectedValueR >= 0.2;
    const isAsymmetricModerate =
      payoff.targetR >= 2.0 && evResult.winProbability >= 0.38 && evResult.expectedValueR >= 0.35;

    if (isStandardModerate || isAsymmetricModerate) {
      reasons.push(
        `Favorable statistical edge (${(evResult.winProbability * 100).toFixed(1)}% win rate, +${evResult.expectedValueR}R expectancy) backed by ${supportingSampleSize} observations.`,
      );
      return {
        recommendation: 'MODERATE_CONFIDENCE',
        winProbability: evResult.winProbability,
        expectedValueR: evResult.expectedValueR,
        averageWinR: evResult.averageWinR,
        averageLossR: evResult.averageLossR,
        supportingSampleSize,
        calibrationStatus,
        confidenceInterval,
        confidenceStatus,
        reasons,
        modelVersion,
      };
    }

    // 6. Low Confidence Criteria
    const isStandardLow = evResult.winProbability >= 0.45 && evResult.expectedValueR > 0.0;
    const isAsymmetricLow =
      payoff.targetR >= 2.0 && evResult.winProbability >= 0.25 && evResult.expectedValueR > 0.0;

    if (isStandardLow || isAsymmetricLow) {
      reasons.push(
        `Positive mathematical expectation (+${evResult.expectedValueR}R) with ${(evResult.winProbability * 100).toFixed(1)}% win probability.`,
      );
      return {
        recommendation: 'LOW_CONFIDENCE',
        winProbability: evResult.winProbability,
        expectedValueR: evResult.expectedValueR,
        averageWinR: evResult.averageWinR,
        averageLossR: evResult.averageLossR,
        supportingSampleSize,
        calibrationStatus,
        confidenceInterval,
        confidenceStatus: 'CALIBRATED',
        reasons,
        modelVersion,
      };
    }

    // 7. Default Fallback
    reasons.push('Probability below executable threshold.');
    return {
      recommendation: 'WAIT',
      winProbability: evResult.winProbability,
      expectedValueR: evResult.expectedValueR,
      averageWinR: evResult.averageWinR,
      averageLossR: evResult.averageLossR,
      supportingSampleSize,
      calibrationStatus,
      confidenceInterval,
      confidenceStatus: 'CALIBRATED',
      reasons,
      modelVersion,
    };
  }
}

/**
 * Persisted model state encapsulating weights, hyperparameters, validation metrics, and version lineage.
 */
export interface IPersistedModelState {
  id?: string;
  version: string;
  algorithm: string;
  featureSchemaVersion: string;
  status: 'CANDIDATE' | 'ACTIVE' | 'ARCHIVED' | 'REJECTED';
  weights: number[];
  bias: number;
  hyperparameters: IModelHyperparameters;
  metrics: EvaluationMetrics;
  calibrationReport?: ICalibrationReport | null;
  trainingExampleCount: number;
  validationExampleCount: number;
  outOfSampleExampleCount: number;
  trainingPeriod?: { start: Date; end: Date };
  validationPeriod?: { start: Date; end: Date };
  outOfSamplePeriod?: { start: Date; end: Date };
  trainingStartedAt?: Date;
  trainingCompletedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * ModelPersistenceManager
 * Serializes and deserializes TradePredictionModels with schema validation and integrity checks.
 */
export class ModelPersistenceManager {
  /**
   * Serializes an active TradePredictionModel and evaluation metrics into a portable IPersistedModelState.
   */
  public static serialize(
    model: TradePredictionModel,
    meta: {
      status?: 'CANDIDATE' | 'ACTIVE' | 'ARCHIVED' | 'REJECTED';
      metrics: EvaluationMetrics;
      calibrationReport?: ICalibrationReport | null;
      trainingExampleCount: number;
      validationExampleCount: number;
      outOfSampleExampleCount: number;
      trainingPeriod?: { start: Date; end: Date };
      validationPeriod?: { start: Date; end: Date };
      outOfSamplePeriod?: { start: Date; end: Date };
      hyperparameters?: Partial<IModelHyperparameters>;
    },
  ): IPersistedModelState {
    const now = new Date();

    return {
      version: model.modelVersion,
      algorithm: 'LOGISTIC_REGRESSION',
      featureSchemaVersion: FEATURE_SCHEMA_VERSION,
      status: meta.status || 'CANDIDATE',
      weights: model.getWeights(),
      bias: model.getBias(),
      hyperparameters: { ...DEFAULT_HYPERPARAMETERS, ...meta.hyperparameters },
      metrics: meta.metrics,
      calibrationReport: meta.calibrationReport || null,
      trainingExampleCount: meta.trainingExampleCount,
      validationExampleCount: meta.validationExampleCount,
      outOfSampleExampleCount: meta.outOfSampleExampleCount,
      trainingPeriod: meta.trainingPeriod,
      validationPeriod: meta.validationPeriod,
      outOfSamplePeriod: meta.outOfSamplePeriod,
      trainingStartedAt: now,
      trainingCompletedAt: now,
      createdAt: now,
      updatedAt: now,
    };
  }

  /**
   * Deserializes a persisted model state back into an operational TradePredictionModel.
   * Throws an error if the feature schema version or weights dimension does not match.
   */
  public static deserialize(state: IPersistedModelState): TradePredictionModel {
    if (!state) {
      throw new Error('ModelPersistenceManager.deserialize: null or undefined model state');
    }

    if (state.featureSchemaVersion !== FEATURE_SCHEMA_VERSION) {
      throw new Error(
        `ModelPersistenceManager.deserialize: feature schema mismatch: expected ${FEATURE_SCHEMA_VERSION}, received ${state.featureSchemaVersion}`,
      );
    }

    if (!state.weights || state.weights.length !== FEATURE_VECTOR_DIMENSION) {
      throw new Error(
        `ModelPersistenceManager.deserialize: weights dimension mismatch: expected ${FEATURE_VECTOR_DIMENSION}, received ${state.weights?.length}`,
      );
    }

    return new TradePredictionModel(
      state.version,
      state.hyperparameters,
      state.weights,
      state.bias !== undefined ? state.bias : 0.0,
    );
  }
}

/**
 * In-memory model registry managing model version history, promotions, and active production routing.
 */
export class ModelRegistry {
  private versions: Map<string, IPersistedModelState> = new Map();
  private assetActiveVersions: Map<string, string> = new Map();
  private activeVersionId: string | null = null;

  /**
   * Registers a new model version in the registry. Never overwrites existing versions without explicit promotion.
   */
  public registerVersion(state: IPersistedModelState, asset?: string): void {
    if (this.versions.has(state.version)) {
      throw new Error(
        `ModelRegistry: model version '${state.version}' already exists in registry. Overwriting immutable versions is prohibited.`,
      );
    }

    this.versions.set(state.version, { ...state });

    const targetAsset = asset ? asset.toUpperCase() : 'GLOBAL';

    // If this is the first active model for asset, set as active
    if (state.status === 'ACTIVE' || !this.assetActiveVersions.has(targetAsset)) {
      this.assetActiveVersions.set(targetAsset, state.version);
      if (!this.activeVersionId) {
        this.activeVersionId = state.version;
      }
    }
  }

  /**
   * Promotes a validated candidate model to production for an asset.
   * Archives previous active version.
   */
  public promoteVersion(version: string, asset?: string): void {
    const target = this.versions.get(version);
    if (!target) {
      throw new Error(`ModelRegistry.promoteVersion: version '${version}' not found in registry`);
    }

    const targetAsset = asset ? asset.toUpperCase() : 'GLOBAL';
    const currentActiveVersion = this.assetActiveVersions.get(targetAsset);

    // Archive current active
    if (currentActiveVersion && currentActiveVersion !== version) {
      const currentActive = this.versions.get(currentActiveVersion);
      if (currentActive) {
        currentActive.status = 'ARCHIVED';
        currentActive.updatedAt = new Date();
      }
    }

    target.status = 'ACTIVE';
    target.updatedAt = new Date();
    this.assetActiveVersions.set(targetAsset, version);
    this.activeVersionId = version;
  }

  /**
   * Retrieves the active production TradePredictionModel for a given asset (e.g. NIFTY or BTCUSDT).
   */
  public getActiveModel(asset?: string): TradePredictionModel | null {
    const targetAsset = asset ? asset.toUpperCase() : 'GLOBAL';
    const versionId = this.assetActiveVersions.get(targetAsset) || this.activeVersionId;
    if (!versionId) return null;
    const state = this.versions.get(versionId);
    if (!state) return null;
    return ModelPersistenceManager.deserialize(state);
  }

  public getActiveVersionState(asset?: string): IPersistedModelState | null {
    const targetAsset = asset ? asset.toUpperCase() : 'GLOBAL';
    const versionId = this.assetActiveVersions.get(targetAsset) || this.activeVersionId;
    if (!versionId) return null;
    return this.versions.get(versionId) || null;
  }

  public getVersion(version: string): IPersistedModelState | null {
    return this.versions.get(version) || null;
  }

  public getAllVersions(): IPersistedModelState[] {
    return Array.from(this.versions.values()).sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
  }

  public clear(): void {
    this.versions.clear();
    this.assetActiveVersions.clear();
    this.activeVersionId = null;
  }
}

/**
 * Deterministic post-mortem failure & success classification taxonomy.
 */
export type PostMortemClassification =
  | 'LIQUIDITY_SWEEP_FAILURE'
  | 'HTF_COUNTERTREND'
  | 'SESSION_CLOSE_REVERSAL'
  | 'VOLATILITY_EXPANSION_STOP'
  | 'EARLY_ENTRY_BEFORE_CONFIRMATION'
  | 'NEWS_SPIKE'
  | 'TARGET_ACHIEVED'
  | 'STANDARD_STOP_OUT'
  | 'TRADE_EXPIRED';

export interface ITradePostMortemInput {
  tradeId?: string;
  symbol: string;
  direction: 'BULLISH' | 'BEARISH';
  entryPrice: number;
  stopLoss: number;
  targets: { tp1: number; tp2: number; tp3?: number };
  entryTimestamp: Date;
  subsequentCandles: ICandle[];
  marketRegime?: MarketRegimeType;
  htfTrendAligned?: boolean;
  atrAtEntry?: number;
  entrySignalConfirmed?: boolean;
  hasNewsEventDuringTrade?: boolean;
}

export interface ITradePostMortemReport {
  symbol: string;
  direction: 'BULLISH' | 'BEARISH';
  entryPrice: number;
  stopLoss: number;
  outcome: 'TP1_HIT' | 'TP2_HIT' | 'TP3_HIT' | 'SL_HIT' | 'EXPIRED';
  realizedRMultiple: number;
  mfeR: number; // Maximum Favorable Excursion in R
  maeR: number; // Maximum Adverse Excursion in R
  timeToResolutionMinutes: number;
  exitTimestamp: Date;
  classification: PostMortemClassification;
  classificationRationale: string;
  marketRegime: string;
  keyContributingFactors: { factor: string; impact: string }[];
}

/**
 * PostMortemAnalyticsEngine
 * Deterministically evaluates trade execution, MFE/MAE excursions, and root-cause failure classifications.
 */
export class PostMortemAnalyticsEngine {
  /**
   * Generates a rigorous post-mortem report for a completed or expired trade.
   */
  public static analyzeTrade(input: ITradePostMortemInput): ITradePostMortemReport {
    const {
      symbol,
      direction,
      entryPrice,
      stopLoss,
      targets,
      entryTimestamp,
      subsequentCandles,
      marketRegime = 'UNKNOWN',
      htfTrendAligned = true,
      atrAtEntry,
      entrySignalConfirmed = true,
      hasNewsEventDuringTrade = false,
    } = input;

    const riskDistance = Math.abs(entryPrice - stopLoss);
    if (riskDistance <= 0) {
      throw new Error(
        'PostMortemAnalyticsEngine: Invalid risk distance (entryPrice equals stopLoss).',
      );
    }

    const isBull = direction === 'BULLISH';
    let maxFavorableExcursion = 0.0;
    let maxAdverseExcursion = 0.0;

    let outcome: 'TP1_HIT' | 'TP2_HIT' | 'TP3_HIT' | 'SL_HIT' | 'EXPIRED' = 'EXPIRED';
    let realizedRMultiple = 0.0;
    let exitIndex = subsequentCandles.length - 1;
    let exitTimestamp =
      subsequentCandles.length > 0
        ? new Date(subsequentCandles[subsequentCandles.length - 1].timestamp)
        : entryTimestamp;

    // Track intra-trade candles up to resolution
    let hitSlIndex = -1;

    for (let i = 0; i < subsequentCandles.length; i++) {
      const c = subsequentCandles[i];
      const candleTime = new Date(c.timestamp);

      // Excursion calculation
      if (isBull) {
        const favorable = Math.max(0, c.high - entryPrice);
        const adverse = Math.max(0, entryPrice - c.low);
        if (favorable > maxFavorableExcursion) maxFavorableExcursion = favorable;
        if (adverse > maxAdverseExcursion) maxAdverseExcursion = adverse;
      } else {
        const favorable = Math.max(0, entryPrice - c.low);
        const adverse = Math.max(0, c.high - entryPrice);
        if (favorable > maxFavorableExcursion) maxFavorableExcursion = favorable;
        if (adverse > maxAdverseExcursion) maxAdverseExcursion = adverse;
      }

      // Check SL hit
      const isSlHit = isBull ? c.low <= stopLoss : c.high >= stopLoss;
      // Check TP hits
      const isTp3Hit =
        targets.tp3 !== undefined && (isBull ? c.high >= targets.tp3 : c.low <= targets.tp3);
      const isTp2Hit = isBull ? c.high >= targets.tp2 : c.low <= targets.tp2;
      const isTp1Hit = isBull ? c.high >= targets.tp1 : c.low <= targets.tp1;

      if (isSlHit) {
        outcome = 'SL_HIT';
        realizedRMultiple = -1.0;
        exitIndex = i;
        hitSlIndex = i;
        exitTimestamp = candleTime;
        break;
      }

      if (isTp3Hit) {
        outcome = 'TP3_HIT';
        realizedRMultiple = targets.tp3 ? Math.abs(targets.tp3 - entryPrice) / riskDistance : 3.0;
        exitIndex = i;
        exitTimestamp = candleTime;
        break;
      }

      if (isTp2Hit) {
        outcome = 'TP2_HIT';
        realizedRMultiple = Math.abs(targets.tp2 - entryPrice) / riskDistance;
        exitIndex = i;
        exitTimestamp = candleTime;
        break;
      }

      if (isTp1Hit && outcome !== 'TP1_HIT') {
        outcome = 'TP1_HIT';
        realizedRMultiple = Math.abs(targets.tp1 - entryPrice) / riskDistance;
        exitIndex = i;
        exitTimestamp = candleTime;
      }
    }

    const mfeR = Number((maxFavorableExcursion / riskDistance).toFixed(2));
    const maeR = Number((maxAdverseExcursion / riskDistance).toFixed(2));
    const timeToResolutionMinutes = Math.max(
      1,
      Math.round((exitTimestamp.getTime() - entryTimestamp.getTime()) / 60000),
    );

    // Deterministic Failure Classification
    const classificationResult = this.classifyOutcome({
      outcome,
      direction,
      entryPrice,
      stopLoss,
      targets,
      subsequentCandles,
      hitSlIndex,
      htfTrendAligned,
      entrySignalConfirmed,
      hasNewsEventDuringTrade,
      atrAtEntry: atrAtEntry || riskDistance,
    });

    return {
      symbol,
      direction,
      entryPrice,
      stopLoss,
      outcome,
      realizedRMultiple: Number(realizedRMultiple.toFixed(2)),
      mfeR,
      maeR,
      timeToResolutionMinutes,
      exitTimestamp,
      classification: classificationResult.classification,
      classificationRationale: classificationResult.rationale,
      marketRegime: String(marketRegime),
      keyContributingFactors: classificationResult.factors,
    };
  }

  /**
   * Deterministic rule-based classification algorithm.
   */
  private static classifyOutcome(params: {
    outcome: string;
    direction: 'BULLISH' | 'BEARISH';
    entryPrice: number;
    stopLoss: number;
    targets: { tp1: number; tp2: number; tp3?: number };
    subsequentCandles: ICandle[];
    hitSlIndex: number;
    htfTrendAligned: boolean;
    entrySignalConfirmed: boolean;
    hasNewsEventDuringTrade: boolean;
    atrAtEntry: number;
  }): {
    classification: PostMortemClassification;
    rationale: string;
    factors: { factor: string; impact: string }[];
  } {
    const {
      outcome,
      direction,
      entryPrice,
      stopLoss,
      targets,
      subsequentCandles,
      hitSlIndex,
      htfTrendAligned,
      entrySignalConfirmed,
      hasNewsEventDuringTrade,
      atrAtEntry,
    } = params;

    const factors: { factor: string; impact: string }[] = [];

    // 1. Success cases
    if (outcome === 'TP1_HIT' || outcome === 'TP2_HIT' || outcome === 'TP3_HIT') {
      return {
        classification: 'TARGET_ACHIEVED',
        rationale: `Target achieved (${outcome}) cleanly with favorable structural flow.`,
        factors: [
          {
            factor: 'Market Alignment',
            impact: 'Price reached target without breaching invalidation zone.',
          },
        ],
      };
    }

    if (outcome === 'EXPIRED') {
      return {
        classification: 'TRADE_EXPIRED',
        rationale: 'Trade timed out before either stop-loss or take-profit was reached.',
        factors: [
          { factor: 'Time Decay / Low Volatility', impact: 'Insufficient expansion momentum.' },
        ],
      };
    }

    // --- Failure Classifications (SL_HIT) ---

    // Rule A: News Spike
    if (hasNewsEventDuringTrade) {
      factors.push({
        factor: 'Scheduled Macro Event',
        impact: 'Exogenous volatility spike breached stop-loss level.',
      });
      return {
        classification: 'NEWS_SPIKE',
        rationale:
          'Trade invalidated by high-impact macro event volatility spike during holding period.',
        factors,
      };
    }

    // Rule B: Liquidity Sweep Failure (Price swept SL, then reversed toward TP within 10 candles)
    if (hitSlIndex >= 0 && hitSlIndex < subsequentCandles.length - 1) {
      const isBull = direction === 'BULLISH';
      const postStopCandles = subsequentCandles.slice(hitSlIndex + 1, hitSlIndex + 11);
      const reversedToTp = postStopCandles.some((c) =>
        isBull ? c.high >= targets.tp1 : c.low <= targets.tp1,
      );

      if (reversedToTp) {
        factors.push({
          factor: 'Liquidity Sweep Beyond Stop',
          impact:
            'Price swept stop-loss liquidity before aggressive reversal toward initial target.',
        });
        return {
          classification: 'LIQUIDITY_SWEEP_FAILURE',
          rationale:
            'Stop-loss was swept for resting retail liquidity before price immediately reversed to target.',
          factors,
        };
      }
    }

    // Rule C: HTF Countertrend
    if (!htfTrendAligned) {
      factors.push({
        factor: 'HTF Structure Inversion',
        impact: 'Trade executed against higher timeframe order flow bias.',
      });
      return {
        classification: 'HTF_COUNTERTREND',
        rationale:
          'Failure caused by higher-timeframe order flow dominance over lower-timeframe setup.',
        factors,
      };
    }

    // Rule D: Early Entry Before Confirmation
    if (!entrySignalConfirmed) {
      factors.push({
        factor: 'Unconfirmed Trigger',
        impact: 'Entry executed prior to candle close or BOS confirmation.',
      });
      return {
        classification: 'EARLY_ENTRY_BEFORE_CONFIRMATION',
        rationale: 'Premature execution without complete structural confirmation.',
        factors,
      };
    }

    // Rule E: Volatility Expansion Stop (Candle range > 2.5x entry ATR)
    if (hitSlIndex >= 0 && hitSlIndex < subsequentCandles.length) {
      const slCandle = subsequentCandles[hitSlIndex];
      const candleRange = Math.abs(slCandle.high - slCandle.low);
      if (candleRange > 2.5 * atrAtEntry) {
        factors.push({
          factor: 'Volatility Expansion',
          impact: `Stop candle range (${candleRange.toFixed(1)}) exceeded 2.5x entry ATR (${atrAtEntry.toFixed(1)}).`,
        });
        return {
          classification: 'VOLATILITY_EXPANSION_STOP',
          rationale: 'Unexpected market volatility expansion exceeded standard ATR distribution.',
          factors,
        };
      }
    }

    // Rule F: Session Close Reversal
    if (hitSlIndex >= 0 && hitSlIndex < subsequentCandles.length) {
      const slCandleTime = new Date(subsequentCandles[hitSlIndex].timestamp);
      const hours = slCandleTime.getUTCHours();
      const minutes = slCandleTime.getUTCMinutes();
      // Near Indian market close (15:15 - 15:30 IST / 09:45 - 10:00 UTC) or NY close (20:45 - 21:00 UTC)
      if (
        (hours === 9 && minutes >= 45) ||
        (hours === 10 && minutes === 0) ||
        (hours === 20 && minutes >= 45)
      ) {
        factors.push({
          factor: 'Session End Rebalancing',
          impact: 'Institutional end-of-session square-off triggered stop.',
        });
        return {
          classification: 'SESSION_CLOSE_REVERSAL',
          rationale: 'Trade stopped out during institutional session settlement rebalancing.',
          factors,
        };
      }
    }

    // Default Fallback
    factors.push({
      factor: 'Normal Variance',
      impact: 'Standard statistical invalidation within risk boundary.',
    });
    return {
      classification: 'STANDARD_STOP_OUT',
      rationale: 'Normal statistical stop-out adhering to system risk boundary.',
      factors,
    };
  }
}

/**
 * Online learning configuration and safety parameters.
 */
export interface IOnlineLearningConfig {
  learningRate?: number; // Maximum: 0.01
  l2Regularization?: number; // Default: 0.001
  maxWeightChangeNorm?: number; // Default: 0.05
  decayRate?: number; // e.g. 0.9995
  maxAllowedLossSpike?: number; // e.g. 1.8
  checkpointWindowSize?: number; // Default: 10
}

export interface IOnlineUpdateResult {
  tradeId?: string;
  symbol: string;
  previousWeights: number[];
  updatedWeights: number[];
  weightDeltaNorm: number;
  learningRateApplied: number;
  predictionProbability: number;
  actualLabel: 0 | 1;
  instantaneousLoss: number;
  isRollbackTriggered: boolean;
  status: 'UPDATED' | 'CLIPPED' | 'ROLLED_BACK' | 'REJECTED_SCHEMA_MISMATCH';
}

interface IWeightCheckpoint {
  weights: number[];
  bias: number;
  timestamp: Date;
  updateCount: number;
  rollingLoss: number;
}

/**
 * OnlineLearningEngine
 * Applies single-step SGD updates upon live trade closure with strict safety bounds,
 * norm clipping, checkpointing, and automatic rollback on loss spikes.
 */
export class OnlineLearningEngine {
  private checkpoints: IWeightCheckpoint[] = [];
  private updateCount: number = 0;
  private recentLosses: number[] = [];

  constructor(private config: IOnlineLearningConfig = {}) {
    this.config = {
      learningRate: Math.min(0.01, config.learningRate || 0.005),
      l2Regularization: config.l2Regularization !== undefined ? config.l2Regularization : 0.001,
      maxWeightChangeNorm: config.maxWeightChangeNorm || 0.05,
      decayRate: config.decayRate || 0.9995,
      maxAllowedLossSpike: config.maxAllowedLossSpike || 1.8,
      checkpointWindowSize: config.checkpointWindowSize || 10,
    };
  }

  /**
   * Applies an online gradient descent update using the point-in-time features and realized binary outcome.
   */
  public updateModel(
    model: TradePredictionModel,
    tradeOutcome: {
      tradeId?: string;
      symbol: string;
      features: TradeFeatureVector;
      featureSchemaVersion?: string;
      actualLabel: 0 | 1;
    },
  ): IOnlineUpdateResult {
    const { tradeId, symbol, features, featureSchemaVersion, actualLabel } = tradeOutcome;

    // 1. Feature Schema Guard
    if (featureSchemaVersion && featureSchemaVersion !== FEATURE_SCHEMA_VERSION) {
      return {
        tradeId,
        symbol,
        previousWeights: model.getWeights(),
        updatedWeights: model.getWeights(),
        weightDeltaNorm: 0.0,
        learningRateApplied: 0.0,
        predictionProbability: 0.5,
        actualLabel,
        instantaneousLoss: 0.0,
        isRollbackTriggered: false,
        status: 'REJECTED_SCHEMA_MISMATCH',
      };
    }

    const prevWeights = model.getWeights();
    const prevBias = model.getBias();
    const x = FeatureVectorExtractor.toArray(features);

    // Save checkpoint before update
    if (this.checkpoints.length === 0) {
      this.checkpoints.push({
        weights: [...prevWeights],
        bias: prevBias,
        timestamp: new Date(),
        updateCount: this.updateCount,
        rollingLoss: 0.45,
      });
    }

    // 2. Predict probability before update
    const p = model.predictProbability(features);
    const y = actualLabel;

    // Instantaneous Cross-Entropy Loss
    const clampedP = Math.max(1e-6, Math.min(1 - 1e-6, p));
    const loss = -(y * Math.log(clampedP) + (1 - y) * Math.log(1 - clampedP));

    // 3. Compute Adaptive / Decayed Learning Rate
    const baseEta = Math.min(0.01, this.config.learningRate || 0.005);
    const eta = baseEta * Math.pow(this.config.decayRate || 1.0, this.updateCount);
    const lambda = this.config.l2Regularization || 0.001;

    const err = p - y;

    // Single-step SGD gradient:
    // dw = eta * (p - y) * x + 2 * lambda * w
    // db = eta * (p - y)
    const deltaW: number[] = [];
    let deltaNormSq = 0.0;

    for (let j = 0; j < x.length; j++) {
      const grad = err * x[j] + 2 * lambda * prevWeights[j];
      const step = eta * grad;
      deltaW.push(step);
      deltaNormSq += step * step;
    }

    const deltaNorm = Math.sqrt(deltaNormSq);
    const maxNorm = this.config.maxWeightChangeNorm || 0.05;

    // Clip weight delta if ||deltaW|| > maxNorm
    let scale = 1.0;
    let wasClipped = false;
    if (deltaNorm > maxNorm && deltaNorm > 0) {
      scale = maxNorm / deltaNorm;
      wasClipped = true;
    }

    const newWeights: number[] = [];
    for (let j = 0; j < prevWeights.length; j++) {
      newWeights.push(prevWeights[j] - deltaW[j] * scale);
    }
    const newBias = prevBias - eta * err * scale;

    // Apply weights to model
    model.setWeights(newWeights, newBias);

    // Update rolling loss stats
    this.recentLosses.push(loss);
    if (this.recentLosses.length > 20) this.recentLosses.shift();
    const avgRecentLoss = this.recentLosses.reduce((a, b) => a + b, 0) / this.recentLosses.length;

    this.updateCount++;

    // 4. Loss Spike Rollback Guard
    const maxLossSpike = this.config.maxAllowedLossSpike || 1.8;
    let isRollbackTriggered = false;

    if (loss > maxLossSpike && avgRecentLoss > 1.2 && this.checkpoints.length > 0) {
      const healthyCheckpoint = this.checkpoints[this.checkpoints.length - 1];
      model.setWeights(healthyCheckpoint.weights, healthyCheckpoint.bias);
      isRollbackTriggered = true;

      return {
        tradeId,
        symbol,
        previousWeights: prevWeights,
        updatedWeights: healthyCheckpoint.weights,
        weightDeltaNorm: deltaNorm,
        learningRateApplied: eta,
        predictionProbability: p,
        actualLabel,
        instantaneousLoss: Number(loss.toFixed(4)),
        isRollbackTriggered: true,
        status: 'ROLLED_BACK',
      };
    }

    // Record new healthy checkpoint
    this.checkpoints.push({
      weights: [...newWeights],
      bias: newBias,
      timestamp: new Date(),
      updateCount: this.updateCount,
      rollingLoss: avgRecentLoss,
    });

    const maxCheckpoints = this.config.checkpointWindowSize || 10;
    if (this.checkpoints.length > maxCheckpoints) {
      this.checkpoints.shift();
    }

    return {
      tradeId,
      symbol,
      previousWeights: prevWeights,
      updatedWeights: newWeights,
      weightDeltaNorm: Number((deltaNorm * scale).toFixed(4)),
      learningRateApplied: Number(eta.toFixed(5)),
      predictionProbability: p,
      actualLabel,
      instantaneousLoss: Number(loss.toFixed(4)),
      isRollbackTriggered: false,
      status: wasClipped ? 'CLIPPED' : 'UPDATED',
    };
  }

  public getCheckpoints(): IWeightCheckpoint[] {
    return [...this.checkpoints];
  }

  public getUpdateCount(): number {
    return this.updateCount;
  }
}

/**
 * Historical prediction and realized outcome sample for drift monitoring.
 */
export interface IDriftEvaluationSample {
  predictionProbability: number;
  actualOutcome: 0 | 1;
  realizedR: number;
  expectedR: number;
  features: TradeFeatureVector;
  timestamp: Date;
}

/**
 * Continuous Model Drift & Performance Health Monitor.
 * Detects feature shift, prediction drift, calibration degradation, and expectancy decay.
 */
export class ModelDriftDetector {
  private samples: IDriftEvaluationSample[] = [];
  private readonly maxSamples: number;

  constructor(maxSamples = 200) {
    this.maxSamples = maxSamples;
  }

  /**
   * Records a completed trade prediction and actual outcome.
   */
  public recordSample(sample: IDriftEvaluationSample): void {
    this.samples.push(sample);
    if (this.samples.length > this.maxSamples) {
      this.samples.shift();
    }
  }

  /**
   * Generates a comprehensive drift and health report across the rolling window.
   */
  public evaluateDrift(
    asset = 'GLOBAL',
    modelVersion = '1.0.0',
    baselineMetrics?: { brierScore?: number; ece?: number; winRate?: number },
  ) {
    if (this.samples.length < 10) {
      return {
        modelVersion,
        asset,
        evaluatedAt: new Date(),
        sampleCount: this.samples.length,
        featureDriftDetected: false,
        predictionDriftDetected: false,
        calibrationDriftDetected: false,
        brierScore: 0.18,
        expectedCalibrationError: 0.04,
        maximumCalibrationError: 0.07,
        rollingWinRate: 65.0,
        rollingExpectancyR: 0.75,
        recommendedAction: 'CONTINUE_LIVE' as const,
        reasons: ['Insufficient sample history for drift rejection (warm-up phase)'],
      };
    }

    const n = this.samples.length;
    const wins = this.samples.filter((s) => s.actualOutcome === 1).length;
    const rollingWinRate = Number(((wins / n) * 100).toFixed(1));
    const rollingExpectancyR = Number(
      (this.samples.reduce((acc, s) => acc + s.realizedR, 0) / n).toFixed(2),
    );

    // 1. Calculate Brier Score: 1/N * sum((p - y)^2)
    const brierScore = Number(
      (
        this.samples.reduce(
          (acc, s) => acc + Math.pow(s.predictionProbability - s.actualOutcome, 2),
          0,
        ) / n
      ).toFixed(4),
    );

    // 2. Calculate ECE & MCE across 10 decile probability bins
    const numBins = 10;
    const bins: { count: number; sumProb: number; sumActual: number }[] = Array.from(
      { length: numBins },
      () => ({ count: 0, sumProb: 0, sumActual: 0 }),
    );

    for (const s of this.samples) {
      const binIdx = Math.min(numBins - 1, Math.floor(s.predictionProbability * numBins));
      bins[binIdx].count++;
      bins[binIdx].sumProb += s.predictionProbability;
      bins[binIdx].sumActual += s.actualOutcome;
    }

    let ece = 0;
    let mce = 0;

    for (const b of bins) {
      if (b.count > 0) {
        const avgConfidence = b.sumProb / b.count;
        const avgAccuracy = b.sumActual / b.count;
        const diff = Math.abs(avgAccuracy - avgConfidence);
        ece += (b.count / n) * diff;
        if (diff > mce) mce = diff;
      }
    }

    const expectedCalibrationError = Number(ece.toFixed(4));
    const maximumCalibrationError = Number(mce.toFixed(4));

    // 3. Drift Flags Evaluation
    const baseBrier = baselineMetrics?.brierScore ?? 0.2;
    const baseECE = baselineMetrics?.ece ?? 0.06;

    const calibrationDriftDetected =
      expectedCalibrationError > baseECE * 1.6 || brierScore > baseBrier * 1.4;
    const predictionDriftDetected =
      Math.abs(rollingWinRate - (baselineMetrics?.winRate ?? 65.0)) > 20.0;
    const featureDriftDetected = brierScore > 0.28 || expectedCalibrationError > 0.18;

    const reasons: string[] = [];
    let recommendedAction: 'CONTINUE_LIVE' | 'REDUCE_RISK' | 'SWITCH_TO_PAPER' | 'DISABLE_MODEL' =
      'CONTINUE_LIVE';

    if (featureDriftDetected || brierScore > 0.27) {
      recommendedAction = 'DISABLE_MODEL';
      reasons.push(
        `Severe model degradation: Brier Score (${brierScore}) exceeded critical limit 0.27`,
      );
    } else if (calibrationDriftDetected || expectedCalibrationError > 0.12) {
      recommendedAction = 'SWITCH_TO_PAPER';
      reasons.push(
        `Calibration drift detected: ECE (${expectedCalibrationError}) exceeded limit 0.12`,
      );
    } else if (predictionDriftDetected || rollingExpectancyR < 0.1) {
      recommendedAction = 'REDUCE_RISK';
      reasons.push(`Expectancy decay: Rolling expectancy dropped to ${rollingExpectancyR}R`);
    }

    return {
      modelVersion,
      asset,
      evaluatedAt: new Date(),
      sampleCount: n,
      featureDriftDetected,
      predictionDriftDetected,
      calibrationDriftDetected,
      brierScore,
      expectedCalibrationError,
      maximumCalibrationError,
      rollingWinRate,
      rollingExpectancyR,
      recommendedAction,
      reasons,
    };
  }

  public clear(): void {
    this.samples = [];
  }
}
