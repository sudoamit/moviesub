import { createHash } from 'crypto';
import { IFill } from '@quant/backtesting';
import { IBacktestTrade } from '@quant/shared';
import { DriftEvent } from './shadow-types';

export interface ExecutionDriftThresholds {
  readonly minTrades: number; // e.g. 10
  readonly warningSlippageAvgRatio: number; // e.g. 0.0015 (15 bps)
  readonly criticalSlippageAvgRatio: number; // e.g. 0.0030 (30 bps)
  readonly warningHighSlippageTradeRatio: number; // e.g. 0.20 (20% of trades with high slippage)
  readonly criticalHighSlippageTradeRatio: number; // e.g. 0.40
}

export const DEFAULT_EXECUTION_DRIFT_THRESHOLDS: ExecutionDriftThresholds = {
  minTrades: 10,
  warningSlippageAvgRatio: 0.0015,
  criticalSlippageAvgRatio: 0.0030,
  warningHighSlippageTradeRatio: 0.20,
  criticalHighSlippageTradeRatio: 0.40,
};

export class ExecutionDriftDetector {
  /**
   * Evaluates execution quality drift from actual simulated fills and completed trades.
   */
  public static evaluateExecutionDrift(
    candidateId: string,
    trades: readonly IBacktestTrade[],
    fills: readonly IFill[],
    thresholds: ExecutionDriftThresholds = DEFAULT_EXECUTION_DRIFT_THRESHOLDS,
    timestamp = Date.now(),
  ): DriftEvent[] {
    const events: DriftEvent[] = [];

    if (trades.length < thresholds.minTrades) {
      return events;
    }

    const lastTrade = trades[trades.length - 1];
    const marketTimestamp =
      lastTrade.exitTime instanceof Date
        ? lastTrade.exitTime.getTime()
        : new Date(lastTrade.exitTime).getTime();

    // 1. Average slippage evaluation across fills
    if (fills.length > 0) {
      const totalSlippageCost = fills.reduce((sum, f) => sum + Math.abs(f.slippage || 0), 0);
      const totalFillValue = fills.reduce((sum, f) => sum + f.price * f.quantity, 0);
      const avgSlippageRatio = totalFillValue > 0 ? totalSlippageCost / totalFillValue : 0;

      if (avgSlippageRatio >= thresholds.criticalSlippageAvgRatio) {
        events.push(
          this.createEvent({
            candidateId,
            timestamp,
            marketTimestamp,
            type: 'EXECUTION',
            severity: 'CRITICAL',
            metric: 'average_slippage',
            baselineValue: 0.0005,
            observedValue: avgSlippageRatio,
            threshold: thresholds.criticalSlippageAvgRatio,
            windowStart: trades[0].entryTime instanceof Date ? trades[0].entryTime.getTime() : new Date(trades[0].entryTime).getTime(),
            windowEnd: marketTimestamp,
            details: `Critical execution drift: Average slippage reached ${(avgSlippageRatio * 10000).toFixed(1)} bps (threshold: ${(thresholds.criticalSlippageAvgRatio * 10000).toFixed(1)} bps)`,
          }),
        );
      } else if (avgSlippageRatio >= thresholds.warningSlippageAvgRatio) {
        events.push(
          this.createEvent({
            candidateId,
            timestamp,
            marketTimestamp,
            type: 'EXECUTION',
            severity: 'WARNING',
            metric: 'average_slippage',
            baselineValue: 0.0005,
            observedValue: avgSlippageRatio,
            threshold: thresholds.warningSlippageAvgRatio,
            windowStart: trades[0].entryTime instanceof Date ? trades[0].entryTime.getTime() : new Date(trades[0].entryTime).getTime(),
            windowEnd: marketTimestamp,
            details: `Warning execution drift: Average slippage reached ${(avgSlippageRatio * 10000).toFixed(1)} bps`,
          }),
        );
      }
    }

    return events;
  }

  private static createEvent(params: {
    candidateId: string;
    timestamp: number;
    marketTimestamp: number;
    type: 'EXECUTION';
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
    const id = `drift-exec-${params.candidateId}-${params.metric}-${params.marketTimestamp}-${evidenceHash.slice(0, 8)}`;

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
