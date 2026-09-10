import { createHash } from 'crypto';
import { DriftEvent, ShadowWindowMetrics } from './shadow-types';
import { ShadowEvaluationMetrics } from '../types';

export interface PerformanceDriftThresholds {
  readonly minTradesForEvaluation: number;
  readonly warningExpectancyRDropRatio: number; // e.g., 0.35 (35% drop)
  readonly criticalExpectancyRDropRatio: number; // e.g., 0.60 (60% drop or negative R)
  readonly warningWinRateDropPercent: number; // e.g., 10 (10% drop in win rate)
  readonly criticalWinRateDropPercent: number; // e.g., 20
  readonly warningProfitFactorDropRatio: number; // e.g., 0.30
  readonly criticalProfitFactorDropRatio: number; // e.g., 0.50
  readonly maxAllowableDrawdownR: number; // e.g., 3.5 R
  readonly criticalDrawdownR: number; // e.g., 5.0 R
}

export const DEFAULT_PERFORMANCE_DRIFT_THRESHOLDS: PerformanceDriftThresholds = {
  minTradesForEvaluation: 10,
  warningExpectancyRDropRatio: 0.35,
  criticalExpectancyRDropRatio: 0.60,
  warningWinRateDropPercent: 10,
  criticalWinRateDropPercent: 20,
  warningProfitFactorDropRatio: 0.30,
  criticalProfitFactorDropRatio: 0.50,
  maxAllowableDrawdownR: 3.5,
  criticalDrawdownR: 5.0,
};

export class PerformanceDriftDetector {
  /**
   * Evaluates statistical performance drift for a rolling shadow window against the candidate's immutable reference baseline.
   * Strictly fails closed if reference baseline metrics are missing or invalid.
   */
  public static evaluatePerformanceDrift(
    candidateId: string,
    currentMetrics: ShadowWindowMetrics,
    baselineMetrics: ShadowEvaluationMetrics | {
      expectancyR?: number;
      averageR?: number;
      winRate: number;
      profitFactor: number;
      maxDrawdownR?: number;
    },
    thresholds: PerformanceDriftThresholds = DEFAULT_PERFORMANCE_DRIFT_THRESHOLDS,
    timestamp = Date.now(),
  ): DriftEvent[] {
    const events: DriftEvent[] = [];

    // Minimum sample size requirement: cannot judge drift with insufficient trades
    if (currentMetrics.tradeCount < thresholds.minTradesForEvaluation) {
      return events;
    }

    if (!baselineMetrics || typeof baselineMetrics !== 'object') {
      throw new Error(`SHADOW_BASELINE_MISSING: Candidate '${candidateId}' is missing authoritative reference baseline metrics`);
    }

    const baseExpectancy =
      'expectancyR' in baselineMetrics && typeof baselineMetrics.expectancyR === 'number'
        ? baselineMetrics.expectancyR
        : 'averageR' in baselineMetrics && typeof baselineMetrics.averageR === 'number'
        ? baselineMetrics.averageR
        : undefined;
    if (typeof baseExpectancy !== 'number' || !Number.isFinite(baseExpectancy)) {
      throw new Error(`SHADOW_BASELINE_MISSING: Candidate '${candidateId}' is missing valid numeric baseline expectancy`);
    }

    const baseWinRate = baselineMetrics.winRate;
    if (typeof baseWinRate !== 'number' || !Number.isFinite(baseWinRate)) {
      throw new Error(`SHADOW_BASELINE_MISSING: Candidate '${candidateId}' is missing valid numeric baseline win rate`);
    }

    const baseProfitFactor = baselineMetrics.profitFactor;
    if (typeof baseProfitFactor !== 'number' || !Number.isFinite(baseProfitFactor)) {
      throw new Error(`SHADOW_BASELINE_MISSING: Candidate '${candidateId}' is missing valid numeric baseline profit factor`);
    }

    // 1. Expectancy R Drift
    if (baseExpectancy > 0) {
      const dropRatio = (baseExpectancy - currentMetrics.averageR) / baseExpectancy;
      if (dropRatio >= thresholds.criticalExpectancyRDropRatio || currentMetrics.averageR < 0) {
        events.push(
          this.createEvent({
            candidateId,
            timestamp,
            marketTimestamp: currentMetrics.windowEnd,
            type: 'PERFORMANCE',
            severity: 'CRITICAL',
            metric: 'expectancyR',
            baselineValue: baseExpectancy,
            observedValue: currentMetrics.averageR,
            threshold: baseExpectancy * (1 - thresholds.criticalExpectancyRDropRatio),
            windowStart: currentMetrics.windowStart,
            windowEnd: currentMetrics.windowEnd,
            details: `Critical performance drift: Expectancy R dropped to ${currentMetrics.averageR.toFixed(2)}R vs baseline ${baseExpectancy.toFixed(2)}R (drop ratio: ${(dropRatio * 100).toFixed(1)}%)`,
          }),
        );
      } else if (dropRatio >= thresholds.warningExpectancyRDropRatio) {
        events.push(
          this.createEvent({
            candidateId,
            timestamp,
            marketTimestamp: currentMetrics.windowEnd,
            type: 'PERFORMANCE',
            severity: 'WARNING',
            metric: 'expectancyR',
            baselineValue: baseExpectancy,
            observedValue: currentMetrics.averageR,
            threshold: baseExpectancy * (1 - thresholds.warningExpectancyRDropRatio),
            windowStart: currentMetrics.windowStart,
            windowEnd: currentMetrics.windowEnd,
            details: `Warning performance drift: Expectancy R dropped to ${currentMetrics.averageR.toFixed(2)}R vs baseline ${baseExpectancy.toFixed(2)}R`,
          }),
        );
      }
    }

    // 2. Win Rate Drift
    const winRateDelta = baseWinRate - currentMetrics.winRate;
    if (winRateDelta >= thresholds.criticalWinRateDropPercent) {
      events.push(
        this.createEvent({
          candidateId,
          timestamp,
          marketTimestamp: currentMetrics.windowEnd,
          type: 'PERFORMANCE',
          severity: 'CRITICAL',
          metric: 'winRate',
          baselineValue: baseWinRate,
          observedValue: currentMetrics.winRate,
          threshold: baseWinRate - thresholds.criticalWinRateDropPercent,
          windowStart: currentMetrics.windowStart,
          windowEnd: currentMetrics.windowEnd,
          details: `Critical win rate drift: Win rate fell ${winRateDelta.toFixed(1)}% to ${currentMetrics.winRate.toFixed(1)}% (baseline: ${baseWinRate.toFixed(1)}%)`,
        }),
      );
    } else if (winRateDelta >= thresholds.warningWinRateDropPercent) {
      events.push(
        this.createEvent({
          candidateId,
          timestamp,
          marketTimestamp: currentMetrics.windowEnd,
          type: 'PERFORMANCE',
          severity: 'WARNING',
          metric: 'winRate',
          baselineValue: baseWinRate,
          observedValue: currentMetrics.winRate,
          threshold: baseWinRate - thresholds.warningWinRateDropPercent,
          windowStart: currentMetrics.windowStart,
          windowEnd: currentMetrics.windowEnd,
          details: `Warning win rate drift: Win rate fell ${winRateDelta.toFixed(1)}% to ${currentMetrics.winRate.toFixed(1)}%`,
        }),
      );
    }

    // 3. Profit Factor Drift
    if (baseProfitFactor > 1.0) {
      const pfDropRatio = (baseProfitFactor - currentMetrics.profitFactor) / baseProfitFactor;
      if (currentMetrics.profitFactor < 1.0 || pfDropRatio >= thresholds.criticalProfitFactorDropRatio) {
        events.push(
          this.createEvent({
            candidateId,
            timestamp,
            marketTimestamp: currentMetrics.windowEnd,
            type: 'PERFORMANCE',
            severity: 'CRITICAL',
            metric: 'profitFactor',
            baselineValue: baseProfitFactor,
            observedValue: currentMetrics.profitFactor,
            threshold: 1.0,
            windowStart: currentMetrics.windowStart,
            windowEnd: currentMetrics.windowEnd,
            details: `Critical profit factor drift: Profit factor fell to ${currentMetrics.profitFactor.toFixed(2)} (baseline: ${baseProfitFactor.toFixed(2)})`,
          }),
        );
      } else if (pfDropRatio >= thresholds.warningProfitFactorDropRatio) {
        events.push(
          this.createEvent({
            candidateId,
            timestamp,
            marketTimestamp: currentMetrics.windowEnd,
            type: 'PERFORMANCE',
            severity: 'WARNING',
            metric: 'profitFactor',
            baselineValue: baseProfitFactor,
            observedValue: currentMetrics.profitFactor,
            threshold: baseProfitFactor * (1 - thresholds.warningProfitFactorDropRatio),
            windowStart: currentMetrics.windowStart,
            windowEnd: currentMetrics.windowEnd,
            details: `Warning profit factor drift: Profit factor fell to ${currentMetrics.profitFactor.toFixed(2)} vs baseline ${baseProfitFactor.toFixed(2)}`,
          }),
        );
      }
    }

    // 4. Max Drawdown Drift
    if (currentMetrics.maxDrawdown >= thresholds.criticalDrawdownR) {
      events.push(
        this.createEvent({
          candidateId,
          timestamp,
          marketTimestamp: currentMetrics.windowEnd,
          type: 'PERFORMANCE',
          severity: 'CRITICAL',
          metric: 'maxDrawdown',
          baselineValue: thresholds.maxAllowableDrawdownR,
          observedValue: currentMetrics.maxDrawdown,
          threshold: thresholds.criticalDrawdownR,
          windowStart: currentMetrics.windowStart,
          windowEnd: currentMetrics.windowEnd,
          details: `Critical drawdown drift: Rolling drawdown reached ${currentMetrics.maxDrawdown.toFixed(2)}R (threshold: ${thresholds.criticalDrawdownR}R)`,
        }),
      );
    } else if (currentMetrics.maxDrawdown >= thresholds.maxAllowableDrawdownR) {
      events.push(
        this.createEvent({
          candidateId,
          timestamp,
          marketTimestamp: currentMetrics.windowEnd,
          type: 'PERFORMANCE',
          severity: 'WARNING',
          metric: 'maxDrawdown',
          baselineValue: thresholds.maxAllowableDrawdownR,
          observedValue: currentMetrics.maxDrawdown,
          threshold: thresholds.maxAllowableDrawdownR,
          windowStart: currentMetrics.windowStart,
          windowEnd: currentMetrics.windowEnd,
          details: `Warning drawdown drift: Rolling drawdown reached ${currentMetrics.maxDrawdown.toFixed(2)}R`,
        }),
      );
    }

    return events;
  }

  private static createEvent(params: {
    candidateId: string;
    timestamp: number;
    marketTimestamp: number;
    type: 'PERFORMANCE';
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
    const id = `drift-perf-${params.candidateId}-${params.metric}-${params.marketTimestamp}-${evidenceHash.slice(0, 8)}`;

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
