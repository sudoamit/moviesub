import { Direction, ICandle } from '@quant/shared';

export interface IDisplacementMetrics {
  bodyRatio: number;          // body / range (0 to 1)
  rangeAtrRatio: number;      // range / ATR
  closeExtremity: number;     // bullish: (close - low)/range, bearish: (high - close)/range
  relativeVolume: number;     // volume / avgVolume (default 1.0 if not available)
  penetrationAtrRatio: number;// distance beyond pivot / ATR
  compositeScore: number;     // Weighted multi-factor score
  isDisplacement: boolean;    // compositeScore >= threshold
}

export interface IDisplacementOptions {
  threshold?: number;
  minBodyRatio?: number;
  minRangeAtrRatio?: number;
}

export class DisplacementEngine {
  /**
   * Calculates comprehensive multi-factor displacement metrics for a candle.
   * Deterministic, zero look-ahead bias.
   */
  static calculate(
    candle: ICandle,
    direction: Direction,
    atr: number,
    pivotPrice?: number,
    avgVolume?: number,
    options: IDisplacementOptions = {},
  ): IDisplacementMetrics {
    const threshold = options.threshold ?? 1.0;
    const minBodyRatio = options.minBodyRatio ?? 0.5;
    const minRangeAtrRatio = options.minRangeAtrRatio ?? 0.8;

    const open = Number(candle.open);
    const high = Number(candle.high);
    const low = Number(candle.low);
    const close = Number(candle.close);
    const volume = candle.volume !== undefined ? Number(candle.volume) : 0;

    const range = Math.max(0.0001, high - low);
    const body = Math.abs(close - open);
    const effectiveAtr = atr > 0 ? atr : range;

    const bodyRatio = Math.min(1.0, body / range);
    const rangeAtrRatio = range / effectiveAtr;

    let closeExtremity = 0.5;
    let penetrationAtrRatio = 0.0;

    if (direction === Direction.BULLISH) {
      closeExtremity = (close - low) / range;
      if (pivotPrice !== undefined && close > pivotPrice) {
        penetrationAtrRatio = (close - pivotPrice) / effectiveAtr;
      }
    } else if (direction === Direction.BEARISH) {
      closeExtremity = (high - close) / range;
      if (pivotPrice !== undefined && close < pivotPrice) {
        penetrationAtrRatio = (pivotPrice - close) / effectiveAtr;
      }
    }

    const relativeVolume =
      avgVolume && avgVolume > 0 && volume > 0 ? Math.min(3.0, volume / avgVolume) : 1.0;

    // Multi-factor weighted displacement score scaled by directional conviction (body ratio):
    const directionalBodyWeight = Math.min(1.0, bodyRatio / minBodyRatio);
    const score =
      (rangeAtrRatio * 0.35 * directionalBodyWeight) +
      (bodyRatio * 1.5 * 0.30) +
      (closeExtremity * 1.5 * 0.20 * directionalBodyWeight) +
      (Math.min(1.5, relativeVolume) * 0.15 * directionalBodyWeight);

    const isDirectionalCandle =
      direction === Direction.BULLISH ? close > open : direction === Direction.BEARISH ? close < open : true;

    const isDisplacement =
      isDirectionalCandle &&
      bodyRatio >= minBodyRatio &&
      rangeAtrRatio >= minRangeAtrRatio &&
      closeExtremity >= 0.55 &&
      score >= threshold;

    return {
      bodyRatio: Number(bodyRatio.toFixed(3)),
      rangeAtrRatio: Number(rangeAtrRatio.toFixed(3)),
      closeExtremity: Number(closeExtremity.toFixed(3)),
      relativeVolume: Number(relativeVolume.toFixed(3)),
      penetrationAtrRatio: Number(penetrationAtrRatio.toFixed(3)),
      compositeScore: Number(score.toFixed(3)),
      isDisplacement,
    };
  }

  /**
   * Evaluates displacement and returns a score and factors structure.
   */
  static evaluateDisplacement(
    candle: ICandle,
    atr: number,
    avgVolume?: number,
    pivotPrice?: number,
  ): {
    score: number;
    direction: Direction;
    isDisplacement: boolean;
    factors: {
      bodyRatio: number;
      rangeAtrRatio: number;
      closeExtremity: number;
      relativeVolume: number;
    };
  } {
    const isBull = candle.close >= candle.open;
    const dir = isBull ? Direction.BULLISH : Direction.BEARISH;
    const metrics = DisplacementEngine.calculate(candle, dir, atr, pivotPrice, avgVolume);
    return {
      score: metrics.compositeScore,
      direction: dir,
      isDisplacement: metrics.isDisplacement,
      factors: {
        bodyRatio: metrics.bodyRatio,
        rangeAtrRatio: metrics.rangeAtrRatio,
        closeExtremity: metrics.closeExtremity,
        relativeVolume: metrics.relativeVolume,
      },
    };
  }
}
