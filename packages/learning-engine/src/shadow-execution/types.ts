/**
 * Phase 11 — Shadow Trading & Live Decision Simulation Domain Types
 * Immutable MarketSnapshot, PortfolioSnapshot, DecisionContext, ShadowOrder,
 * ShadowPosition, DecisionPair, and ShadowOutcome models.
 */

export interface MarketSnapshotOHLCV {
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
}

export interface MarketSnapshotInstrument {
  readonly symbol: string;
  readonly market: string;
  readonly tickSize?: number;
  readonly lotSize?: number;
}

export interface MarketSnapshot {
  readonly snapshotId: string;
  readonly instrument: MarketSnapshotInstrument;
  readonly timestamp: number;
  readonly exchangeTimestamp?: number;
  readonly ohlcv: MarketSnapshotOHLCV;
  readonly bid: number;
  readonly ask: number;
  readonly spread: number;
  readonly volume: number;
  readonly marketStatus: 'OPEN' | 'CLOSED' | 'HALTED' | 'AUCTION';
  readonly dataSource: string;
  readonly dataVersion: string;
  readonly sourceSequence?: number;
  readonly snapshotHash: string;
}

export interface PortfolioSnapshot {
  readonly portfolioId: string;
  readonly timestamp: number;
  readonly cash: number;
  readonly equity: number;
  readonly openPositionsCount: number;
  readonly portfolioStateHash: string;
}

export type ExecutionMode = 'LIVE' | 'SHADOW';
export type ModelRole = 'CHAMPION' | 'CHALLENGER';

export interface ModelIdentity {
  readonly modelId: string;
  readonly modelVersion: string;
  readonly artifactHash: string;
}

export interface DecisionLatencies {
  readonly marketTimestamp: number;
  readonly featureStartTimestamp: number;
  readonly featureEndTimestamp: number;
  readonly modelStartTimestamp: number;
  readonly modelEndTimestamp: number;
  readonly decisionTimestamp: number;
  readonly dataToDecisionLatencyMs: number;
  readonly featureLatencyMs: number;
  readonly modelLatencyMs: number;
  readonly totalDecisionLatencyMs: number;
}

export interface DecisionContext {
  readonly decisionId: string;
  readonly snapshotId: string;
  readonly snapshotHash: string;
  readonly decisionTimestamp: number;
  readonly instrument: MarketSnapshotInstrument;
  readonly marketSnapshot: MarketSnapshot;
  readonly portfolioSnapshot: PortfolioSnapshot;
  readonly featureVersion: string;
  readonly featureSchemaHash: string;
  readonly featureInputHash: string;
  readonly featureDataCutoff: number;
  readonly strategyVersion: string;
  readonly strategyConfigHash: string;
  readonly executionConfigVersion: string;
  readonly executionConfigHash: string;
  readonly riskConfigVersion: string;
  readonly riskConfigHash: string;
  readonly costConfigVersion: string;
  readonly costConfigHash: string;
  readonly portfolioStateVersion: string;
  readonly portfolioStateHash: string;
  readonly modelIdentity: ModelIdentity;
  readonly evaluationFingerprint: string;
  readonly mode: ExecutionMode;
  readonly modelRole: ModelRole;
}

export type TradingAction = 'BUY' | 'SELL' | 'HOLD' | 'EXIT' | 'WAIT' | 'NO_ACTION';

export interface TradingDecision {
  readonly decisionId: string;
  readonly action: TradingAction;
  readonly confidence: number;
  readonly signal: string;
  readonly entryPrice?: number;
  readonly stopLoss?: number;
  readonly takeProfit?: number;
  readonly positionSize?: number;
  readonly riskAmount?: number;
  readonly reason: string;
  readonly decisionFingerprint: string;
  readonly latencies: DecisionLatencies;
  readonly context: DecisionContext;
}

export type ShadowOrderStatus = 'PENDING' | 'FILLED' | 'PARTIALLY_FILLED' | 'CANCELLED' | 'EXPIRED' | 'REJECTED';
export type ShadowOrderType = 'MARKET' | 'LIMIT' | 'STOP';

export interface ShadowOrder {
  readonly shadowOrderId: string;
  readonly decisionId: string;
  readonly instrument: MarketSnapshotInstrument;
  readonly side: 'BUY' | 'SELL';
  readonly quantity: number;
  readonly requestedPrice: number;
  readonly stopLoss?: number;
  readonly takeProfit?: number;
  readonly orderType: ShadowOrderType;
  readonly createdAt: number;
  readonly executionConfigVersion: string;
  readonly costConfigVersion: string;
  readonly status: ShadowOrderStatus;
}

export interface ShadowFill {
  readonly fillId: string;
  readonly shadowOrderId: string;
  readonly fillPrice: number;
  readonly filledQuantity: number;
  readonly fillTimestamp: number;
  readonly fee: number;
  readonly slippage: number;
}

export type ShadowPositionStatus = 'OPEN' | 'PARTIALLY_FILLED' | 'CLOSED' | 'STOPPED' | 'TARGET_HIT' | 'TIME_EXIT' | 'EXPIRED';

export interface ShadowPosition {
  readonly positionId: string;
  readonly shadowOrderId: string;
  readonly decisionId: string;
  readonly instrument: MarketSnapshotInstrument;
  readonly side: 'BUY' | 'SELL';
  readonly quantity: number;
  readonly entryPrice: number;
  readonly stopLoss?: number;
  readonly takeProfit?: number;
  readonly openedAt: number;
  readonly closedAt?: number;
  readonly exitPrice?: number;
  readonly status: ShadowPositionStatus;
  readonly realizedPnL?: number;
  readonly fees: number;
  readonly slippage: number;
}

export interface ShadowPortfolioState {
  readonly portfolioId: string;
  readonly shadowCash: number;
  readonly shadowEquity: number;
  readonly shadowPeakEquity: number;
  readonly shadowDrawdownPercent: number;
  readonly openPositions: ReadonlyArray<ShadowPosition>;
  readonly lastUpdatedAt: number;
}

export type DecisionDivergenceType =
  | 'AGREE'
  | 'BOTH_NO_ACTION'
  | 'CHAMPION_ONLY_ACTION'
  | 'CHALLENGER_ONLY_ACTION'
  | 'BOTH_ACTION_SAME_DIRECTION_SAME_SIZE'
  | 'BOTH_ACTION_SAME_DIRECTION_DIFFERENT_SIZE'
  | 'BOTH_ACTION_DIFFERENT_DIRECTION';

export interface ChampionChallengerDecisionPair {
  readonly pairId: string;
  readonly snapshotId: string;
  readonly snapshotHash: string;
  readonly decisionTimestamp: number;
  readonly championDecisionId: string;
  readonly challengerDecisionId: string;
  readonly championModelIdentity: ModelIdentity;
  readonly challengerModelIdentity: ModelIdentity;
  readonly championEvaluationFingerprint: string;
  readonly challengerEvaluationFingerprint: string;
  readonly championDecision: TradingDecision;
  readonly challengerDecision: TradingDecision;
  readonly divergence: 'AGREE' | 'DISAGREE';
  readonly divergenceType: DecisionDivergenceType;
  readonly decisionPairFingerprint: string;
}

export type ShadowOutcomeStatus = 'EVALUATED' | 'TIMEOUT_EXPIRED' | 'INSUFFICIENT_DATA';

export interface ShadowOutcome {
  readonly outcomeId: string;
  readonly decisionId: string;
  readonly pairId: string;
  readonly outcomeStartTimestamp: number;
  readonly outcomeEndTimestamp: number;
  readonly entryFill?: ShadowFill;
  readonly exitFill?: ShadowFill;
  readonly grossPnL: number;
  readonly fees: number;
  readonly slippage: number;
  readonly netPnL: number;
  readonly maxFavorableExcursion: number;
  readonly maxAdverseExcursion: number;
  readonly holdingDurationMs: number;
  readonly exitReason: string;
  readonly outcomeStatus: ShadowOutcomeStatus;
  readonly outcomeHash: string;
}
