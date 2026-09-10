import { createHash } from 'crypto';
import { ICandle } from '@quant/shared';
import { DriftEvent } from './shadow-types';

export interface RegimeObservation {
  readonly timestamp: number;
  readonly volatilityRegime: 'LOW_VOLATILITY' | 'NORMAL_VOLATILITY' | 'HIGH_VOLATILITY';
  readonly trendRegime: 'TRENDING_BULLISH' | 'TRENDING_BEARISH' | 'RANGING';
  readonly atrRatio: number;
}

export interface RegimeDriftThresholds {
  readonly minObservations: number; // e.g. 20
  readonly warningRegimeShiftRatio: number; // e.g. 0.45 (45% in different regime)
  readonly criticalRegimeShiftRatio: number; // e.g. 0.70 (70% in different regime)
}

export const DEFAULT_REGIME_DRIFT_THRESHOLDS: RegimeDriftThresholds = {
  minObservations: 20,
  warningRegimeShiftRatio: 0.45,
  criticalRegimeShiftRatio: 0.70,
};

export class RegimeDriftDetector {
  /**
   * Evaluates causal market regime from recent closed candles without future lookahead.
   */
  public static classifyCausalRegime(candles: readonly ICandle[]): RegimeObservation {
    if (candles.length === 0) {
      return {
        timestamp: 0,
        volatilityRegime: 'NORMAL_VOLATILITY',
        trendRegime: 'RANGING',
        atrRatio: 1.0,
      };
    }

    const lastCandle = candles[candles.length - 1];
    const ts = lastCandle.timestamp instanceof Date ? lastCandle.timestamp.getTime() : new Date(lastCandle.timestamp).getTime();

    if (candles.length < 15) {
      return {
        timestamp: ts,
        volatilityRegime: 'NORMAL_VOLATILITY',
        trendRegime: 'RANGING',
        atrRatio: 1.0,
      };
    }

    // Calculate causal ATR-14
    let trSum = 0;
    const startIdx = Math.max(1, candles.length - 14);
    for (let i = startIdx; i < candles.length; i++) {
      const c = candles[i];
      const prev = candles[i - 1];
      const tr = Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close));
      trSum += tr;
    }
    const currentAtr = trSum / (candles.length - startIdx || 1);

    // Calculate causal historical baseline ATR (over last 50 candles if available)
    const histStartIdx = Math.max(1, candles.length - 50);
    let histTrSum = 0;
    for (let i = histStartIdx; i < candles.length; i++) {
      const c = candles[i];
      const prev = candles[i - 1];
      histTrSum += Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close));
    }
    const baselineAtr = histTrSum / (candles.length - histStartIdx || 1) || currentAtr;
    const atrRatio = Number((currentAtr / baselineAtr).toFixed(2));
    const atrPctOfPrice = currentAtr / (lastCandle.close || 100);

    let volatilityRegime: 'LOW_VOLATILITY' | 'NORMAL_VOLATILITY' | 'HIGH_VOLATILITY' = 'NORMAL_VOLATILITY';
    if (atrRatio > 1.4 || atrPctOfPrice > 0.04) {
      volatilityRegime = 'HIGH_VOLATILITY';
    } else if (atrRatio < 0.7 && atrPctOfPrice < 0.015) {
      volatilityRegime = 'LOW_VOLATILITY';
    }

    // Trend classification via 14-period return & direction
    const firstClose = candles[candles.length - 14].close;
    const lastClose = lastCandle.close;
    const priceChangePct = (lastClose - firstClose) / firstClose;

    let trendRegime: 'TRENDING_BULLISH' | 'TRENDING_BEARISH' | 'RANGING' = 'RANGING';
    if (priceChangePct > 0.02) {
      trendRegime = 'TRENDING_BULLISH';
    } else if (priceChangePct < -0.02) {
      trendRegime = 'TRENDING_BEARISH';
    }

    return {
      timestamp: ts,
      volatilityRegime,
      trendRegime,
      atrRatio,
    };
  }

  /**
   * Evaluates regime drift by comparing current window regime observations against reference baseline regime.
   * Strictly fails closed if reference regime is missing.
   */
  public static evaluateRegimeDrift(
    candidateId: string,
    observedRegimes: readonly RegimeObservation[],
    referenceRegime: {
      volatilityRegime: 'LOW_VOLATILITY' | 'NORMAL_VOLATILITY' | 'HIGH_VOLATILITY';
      trendRegime?: 'TRENDING_BULLISH' | 'TRENDING_BEARISH' | 'RANGING';
    },
    thresholds: RegimeDriftThresholds = DEFAULT_REGIME_DRIFT_THRESHOLDS,
    timestamp = Date.now(),
  ): DriftEvent[] {
    const events: DriftEvent[] = [];

    if (!referenceRegime || !referenceRegime.volatilityRegime) {
      throw new Error(`REFERENCE_REGIME_MISSING: Candidate '${candidateId}' is missing authoritative reference regime`);
    }

    if (observedRegimes.length < thresholds.minObservations) {
      return events;
    }

    const lastObs = observedRegimes[observedRegimes.length - 1];
    const marketTimestamp = lastObs.timestamp;

    // Shift ratio: Proportion of observations differing from baseline volatility regime
    const diffCount = observedRegimes.filter(
      (r) => r.volatilityRegime !== referenceRegime.volatilityRegime,
    ).length;
    const shiftRatio = diffCount / observedRegimes.length;

    if (shiftRatio >= thresholds.criticalRegimeShiftRatio) {
      events.push(
        this.createEvent({
          candidateId,
          timestamp,
          marketTimestamp,
          type: 'REGIME',
          severity: 'CRITICAL',
          metric: 'volatility_regime_shift',
          baselineValue: 0.1,
          observedValue: Number(shiftRatio.toFixed(2)),
          threshold: thresholds.criticalRegimeShiftRatio,
          windowStart: observedRegimes[0].timestamp,
          windowEnd: marketTimestamp,
          details: `Critical regime shift: ${(shiftRatio * 100).toFixed(1)}% of window observed in non-baseline regime (baseline: ${referenceRegime.volatilityRegime})`,
        }),
      );
    } else if (shiftRatio >= thresholds.warningRegimeShiftRatio) {
      events.push(
        this.createEvent({
          candidateId,
          timestamp,
          marketTimestamp,
          type: 'REGIME',
          severity: 'WARNING',
          metric: 'volatility_regime_shift',
          baselineValue: 0.1,
          observedValue: Number(shiftRatio.toFixed(2)),
          threshold: thresholds.warningRegimeShiftRatio,
          windowStart: observedRegimes[0].timestamp,
          windowEnd: marketTimestamp,
          details: `Warning regime shift: ${(shiftRatio * 100).toFixed(1)}% of window observed in non-baseline regime (baseline: ${referenceRegime.volatilityRegime})`,
        }),
      );
    }

    return events;
  }

  private static createEvent(params: {
    candidateId: string;
    timestamp: number;
    marketTimestamp: number;
    type: 'REGIME';
    severity: 'INFO' | 'WARNING' | 'CRITICAL';
    metric: string;
    baselineValue: number;
    observedValue: number;
    threshold: number;
    windowStart: number;
    windowEnd: number;
    details?: string;
  }): DriftEvent {
    const rawPayload = `${params.candidateId}|${params.type}|${params.metric}|${params.severity}|${params.observedValue}|${params.marketTimestamp}`;
    const evidenceHash = createHash('sha256').update(rawPayload).digest('hex');
    const id = `drift-regime-${params.candidateId}-${params.metric}-${params.marketTimestamp}-${evidenceHash.slice(0, 8)}`;

    return {
      id,
      candidateId: params.candidateId,
      timestamp: params.timestamp,
      marketTimestamp: params.marketTimestamp,
      type: params.type,
      severity: params.severity,
      metric: params.metric,
      baselineValue: params.baselineValue,
      observedValue: params.observedValue,
      threshold: params.threshold,
      windowStart: params.windowStart,
      windowEnd: params.windowEnd,
      evidenceHash,
      details: params.details,
    };
  }
}
