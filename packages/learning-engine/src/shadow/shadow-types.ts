import { IBacktestTrade, ICandle, ISignalSetup } from '@quant/shared';
import { PositionLot } from '@quant/risk-engine';
import { IFill, IOrder } from '@quant/backtesting';
import { ShadowEvaluationMetrics } from '../types';
import { RegimeObservation } from './regime-drift-detector';
import { FeatureDriftBaseline } from './feature-drift-detector';

export const SHADOW_SCHEMA_VERSION = '1.0';

export type ShadowStatus =
  | 'INSUFFICIENT_EVIDENCE'
  | 'PENDING'
  | 'ACTIVE'
  | 'HEALTHY'
  | 'DEGRADED'
  | 'CRITICAL'
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

export interface ShadowMarketData {
  readonly symbol: string;
  readonly timeframe: string;
  readonly candles: readonly ICandle[];
  readonly receivedAt: Date;
  readonly source: string;
}

/**
 * Validates shadow market data in strict fail-closed mode.
 */
export function validateShadowMarketData(
  data: ShadowMarketData,
  expectedSymbol?: string,
): void {
  if (!data || typeof data !== 'object') {
    throw new Error('INVALID_SHADOW_MARKET_DATA: Market data object is null or undefined');
  }

  if (!data.symbol || typeof data.symbol !== 'string' || data.symbol.trim() === '') {
    throw new Error('INVALID_SHADOW_MARKET_DATA: Market data is missing authoritative symbol');
  }

  if (expectedSymbol && data.symbol.trim().toUpperCase() !== expectedSymbol.trim().toUpperCase()) {
    throw new Error(
      `SYMBOL_MISMATCH: Market data symbol '${data.symbol}' does not match expected '${expectedSymbol}'`,
    );
  }

  if (!data.timeframe || typeof data.timeframe !== 'string' || data.timeframe.trim() === '') {
    throw new Error('INVALID_SHADOW_MARKET_DATA: Market data is missing timeframe');
  }

  if (!data.source || typeof data.source !== 'string' || data.source.trim() === '') {
    throw new Error('INVALID_SHADOW_MARKET_DATA: Market data is missing authoritative source');
  }

  if (!(data.receivedAt instanceof Date) || isNaN(data.receivedAt.getTime())) {
    throw new Error('INVALID_SHADOW_MARKET_DATA: Market data is missing valid receivedAt date');
  }

  if (!Array.isArray(data.candles) || data.candles.length === 0) {
    throw new Error('INVALID_SHADOW_MARKET_DATA: Market data candles array is empty or not an array');
  }

  let prevTime = 0;
  for (let i = 0; i < data.candles.length; i++) {
    const candle = data.candles[i];
    if (!candle || typeof candle !== 'object') {
      throw new Error(`INVALID_CANDLE: Candle at index ${i} is null or invalid`);
    }

    const { open, high, low, close, volume, timestamp } = candle;
    if (
      typeof open !== 'number' ||
      typeof high !== 'number' ||
      typeof low !== 'number' ||
      typeof close !== 'number' ||
      !Number.isFinite(open) ||
      !Number.isFinite(high) ||
      !Number.isFinite(low) ||
      !Number.isFinite(close) ||
      Number.isNaN(open) ||
      Number.isNaN(high) ||
      Number.isNaN(low) ||
      Number.isNaN(close)
    ) {
      throw new Error(`INVALID_CANDLE_OHLC: Non-finite or NaN numeric price detected at index ${i}`);
    }

    if (high < low || close < low || close > high || open < low || open > high) {
      throw new Error(`INVALID_CANDLE_BOUNDS: Candle at index ${i} has High (${high}) < Low (${low}) or Open/Close outside bounds`);
    }

    if (typeof volume !== 'number' || !Number.isFinite(volume) || volume < 0) {
      throw new Error(`INVALID_CANDLE_VOLUME: Candle at index ${i} has negative or non-finite volume`);
    }

    const candleTime = timestamp instanceof Date ? timestamp.getTime() : new Date(timestamp).getTime();
    if (Number.isNaN(candleTime) || candleTime <= 0) {
      throw new Error(`INVALID_CANDLE_TIMESTAMP: Candle at index ${i} has invalid timestamp`);
    }

    if (i > 0) {
      if (candleTime === prevTime) {
        throw new Error(`DUPLICATE_CANDLE_TIMESTAMP: Duplicate candle timestamp ${candleTime} at index ${i}`);
      }
      if (candleTime < prevTime) {
        throw new Error(`TIMESTAMP_REGRESSION: Out-of-order candle timestamp ${candleTime} < previous ${prevTime} at index ${i}`);
      }
    }
    prevTime = candleTime;
  }
}

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

export interface ShadowEvaluationEvidence {
  readonly candidateId: string;
  readonly artifactHash: string;
  readonly observationCount: number;
  readonly completedTradeCount: number;
  readonly evaluationStart: Date;
  readonly evaluationEnd: Date;
  readonly performanceMetrics: ShadowEvaluationMetrics;
  readonly featureDriftEvents: readonly DriftEvent[];
  readonly regimeDriftEvents: readonly DriftEvent[];
  readonly executionDriftEvents: readonly DriftEvent[];
  readonly healthState: ShadowHealthState;
  readonly marketDatasetHash: string;
  readonly shadowDatasetHash: string;
  readonly stateHash: string;
  readonly evidenceHash: string;
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
  readonly pendingEntrySignals?: readonly (readonly [string, ISignalSetup])[];
  readonly baselineMetrics?: {
    readonly expectancyR: number;
    readonly winRate: number;
    readonly profitFactor: number;
    readonly maxDrawdownR?: number;
  };
  readonly featureBaseline?: FeatureDriftBaseline;
  readonly referenceRegime?: {
    readonly volatilityRegime: 'LOW_VOLATILITY' | 'NORMAL_VOLATILITY' | 'HIGH_VOLATILITY';
    readonly trendRegime?: 'TRENDING_BULLISH' | 'TRENDING_BEARISH' | 'RANGING';
  };
  readonly windowConfig?: ShadowWindowConfig;
  readonly regimeHistory?: readonly RegimeObservation[];
  readonly featureVectors?: readonly (readonly number[])[];
  readonly executionSequences?: {
    readonly nextOrderSequence: number;
    readonly nextFillSequence: number;
    readonly nextEventSequence: number;
  };
  readonly cumulativeMarketHash?: string;
  readonly savedAt: number;
}
