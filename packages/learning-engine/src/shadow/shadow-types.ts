import { IBacktestTrade, ICandle } from '@quant/shared';
import { IExecutionEvent, PositionLot } from '@quant/risk-engine';
import { IFill, IOrder } from '@quant/backtesting';
import { ShadowEvaluationMetrics } from '../types';

export const SHADOW_SCHEMA_VERSION = '1.0';

export type ShadowStatus =
  | 'PENDING'
  | 'ACTIVE'
  | 'HEALTHY'
  | 'DEGRADED'
  | 'FAILED'
  | 'REJECTED'
  | 'STOPPED';

export type DriftType =
  | 'PERFORMANCE'
  | 'FEATURE'
  | 'REGIME'
  | 'EXECUTION'
  | 'CANDIDATE_VS_PRODUCTION';

export type DriftSeverity = 'INFO' | 'WARNING' | 'CRITICAL';

export interface ShadowSignalSnapshot {
  readonly direction: 'LONG' | 'SHORT' | 'FLAT';
  readonly confidence?: number;
  readonly score?: number;
  readonly stopLoss?: number;
  readonly takeProfit?: number;
  readonly targets?: { readonly tp1: number; readonly tp2: number; readonly tp3: number };
  readonly regime?: string;
  readonly conditionRules?: readonly string[];
}

export interface ShadowExecutionSnapshot {
  readonly orderId?: string;
  readonly clientOrderId?: string;
  readonly fillId?: string;
  readonly filledPrice?: number;
  readonly quantity?: number;
  readonly fees?: number;
  readonly slippage?: number;
  readonly status?: string;
}

export interface ShadowObservation {
  readonly candidateId: string;
  readonly candidateVersion: string;
  readonly strategyVersion: string;
  readonly timestamp: number;
  readonly marketTimestamp: number;
  readonly featureVectorHash: string;
  readonly featureSchemaHash: string;
  readonly features?: readonly number[];
  readonly signal?: ShadowSignalSnapshot;
  readonly execution?: ShadowExecutionSnapshot;
}

export interface ShadowWindowMetrics {
  readonly candidateId: string;
  readonly windowType: 'SHORT' | 'MEDIUM' | 'LONG' | 'CUSTOM';
  readonly windowStart: number;
  readonly windowEnd: number;
  readonly observationCount: number;
  readonly tradeCount: number;
  readonly pnl: number;
  readonly pnlR: number;
  readonly winRate: number;
  readonly profitFactor: number;
  readonly maxDrawdown: number;
  readonly averageSlippage: number;
  readonly averageFees: number;
  readonly averageR: number;
  readonly averageHoldingTimeMs: number;
  readonly signalFrequency: number;
  readonly longRatio: number;
  readonly shortRatio: number;
  readonly baselineComparison?: {
    readonly pnlDelta: number;
    readonly pnlRDelta: number;
    readonly winRateDelta: number;
    readonly drawdownDelta: number;
    readonly expectancyRDelta: number;
  };
}

export interface DriftEvent {
  readonly id: string;
  readonly candidateId: string;
  readonly timestamp: number;
  readonly marketTimestamp: number;
  readonly type: DriftType;
  readonly severity: DriftSeverity;
  readonly metric: string;
  readonly baselineValue: number;
  readonly observedValue: number;
  readonly threshold: number;
  readonly windowStart: number;
  readonly windowEnd: number;
  readonly evidenceHash: string;
  readonly details?: string;
}

export interface CandidateProductionComparison {
  readonly timestamp: number;
  readonly marketTimestamp: number;
  readonly candidateSignal: ShadowSignalSnapshot;
  readonly productionSignal: ShadowSignalSnapshot;
  readonly directionMatch: boolean;
  readonly confidenceDelta?: number;
  readonly timingDeltaMs?: number;
}

export interface ShadowHealthState {
  readonly candidateId: string;
  readonly status: ShadowStatus;
  readonly observationCount: number;
  readonly tradeCount: number;
  readonly consecutiveHealthyWindows: number;
  readonly consecutiveDegradedWindows: number;
  readonly lastObservationAt: number;
  readonly lastEvaluationAt: number;
  readonly activeDrifts: readonly DriftEvent[];
  readonly updatedAt: number;
  readonly statusReason?: string;
}

export interface ShadowWindowConfig {
  readonly shortWindowSize: number; // e.g. 20 trades
  readonly mediumWindowSize: number; // e.g. 50 trades
  readonly longWindowSize: number; // e.g. 100 trades
  readonly minObservationsForEvaluation: number; // e.g. 30 candles
  readonly minTradesForEvaluation: number; // e.g. 10 trades
}

export const DEFAULT_SHADOW_WINDOW_CONFIG: ShadowWindowConfig = {
  shortWindowSize: 20,
  mediumWindowSize: 50,
  longWindowSize: 100,
  minObservationsForEvaluation: 30,
  minTradesForEvaluation: 10,
};

export interface ShadowProcessingResult {
  readonly candidateId: string;
  readonly marketTimestamp: number;
  readonly observation: ShadowObservation;
  readonly newOrders: readonly IOrder[];
  readonly newFills: readonly IFill[];
  readonly closedTrades: readonly IBacktestTrade[];
  readonly openPositionsCount: number;
  readonly healthState: ShadowHealthState;
  readonly activeDrifts: readonly DriftEvent[];
  readonly comparisonWithProduction?: CandidateProductionComparison;
}

export interface ShadowAuditRecord {
  readonly eventId: string;
  readonly candidateId: string;
  readonly candidateVersion: string;
  readonly strategyVersion: string;
  readonly timestamp: number;
  readonly marketTimestamp: number;
  readonly eventType:
    | 'SHADOW_STARTED'
    | 'SHADOW_OBSERVATION'
    | 'SHADOW_TRADE_OPENED'
    | 'SHADOW_TRADE_CLOSED'
    | 'SHADOW_WINDOW_EVALUATED'
    | 'PERFORMANCE_DRIFT_DETECTED'
    | 'FEATURE_DRIFT_DETECTED'
    | 'REGIME_DRIFT_DETECTED'
    | 'EXECUTION_DRIFT_DETECTED'
    | 'CANDIDATE_PRODUCTION_DIVERGENCE'
    | 'SHADOW_DEGRADED'
    | 'SHADOW_RECOVERED'
    | 'SHADOW_FAILED'
    | 'SHADOW_STOPPED'
    | 'PAPER_ROLLBACK';
  readonly evidenceHash: string;
  readonly metadata?: Record<string, unknown>;
}

export interface ShadowLedgerData {
  readonly version: string;
  readonly candidateId: string;
  readonly candidateVersion: string;
  readonly strategyVersion: string;
  readonly featureSchemaHash: string;
  readonly artifactHash: string;
  readonly symbol?: string;
  readonly lastMarketTimestamp: number;
  readonly observations: readonly ShadowObservation[];
  readonly orders: readonly IOrder[];
  readonly fills: readonly IFill[];
  readonly trades: readonly IBacktestTrade[];
  readonly windows: readonly ShadowWindowMetrics[];
  readonly drifts: readonly DriftEvent[];
  readonly comparisons: readonly CandidateProductionComparison[];
  readonly health: ShadowHealthState;
  readonly events: readonly ShadowAuditRecord[];
  readonly activeLot?: PositionLot | null;
  readonly recentCandles?: readonly ICandle[];
  readonly pendingOrders?: readonly IOrder[];
  readonly regimeHistory?: readonly any[];
  readonly featureVectors?: readonly (readonly number[])[];
  readonly savedAt: number;
}

