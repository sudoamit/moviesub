import { createHash, randomUUID } from 'crypto';
import { canonicalJsonStringify } from '../canonical-serializer';
import { deepFreeze } from '../champion-challenger/evaluation-identity';
import {
  MarketSnapshot,
  MarketSnapshotInstrument,
  MarketSnapshotOHLCV,
  DecisionContext,
  TradingDecision,
  TradingAction,
  ChampionChallengerDecisionPair,
  DecisionDivergenceType,
  ModelIdentity,
  ExecutionMode,
  ModelRole
} from './types';

/**
 * Validates that all market data and candles inside a snapshot respect Point-In-Time (PIT) safety
 * and do not contain future data relative to snapshot.timestamp.
 */
export function validatePointInTimeSnapshot(snapshot: MarketSnapshot): void {
  if (!snapshot || typeof snapshot !== 'object') {
    throw new Error('INVALID_MARKET_SNAPSHOT: Snapshot is null or undefined');
  }

  if (!snapshot.snapshotId || typeof snapshot.snapshotId !== 'string' || snapshot.snapshotId.trim() === '') {
    throw new Error('INVALID_MARKET_SNAPSHOT: snapshotId is required');
  }

  if (!snapshot.instrument || !snapshot.instrument.symbol) {
    throw new Error('INVALID_MARKET_SNAPSHOT: instrument and symbol are required');
  }

  if (typeof snapshot.timestamp !== 'number' || snapshot.timestamp <= 0) {
    throw new Error('INVALID_MARKET_SNAPSHOT: Valid numeric timestamp is required');
  }

  if (!snapshot.ohlcv) {
    throw new Error('INVALID_MARKET_SNAPSHOT: OHLCV is required');
  }

  const { open, high, low, close } = snapshot.ohlcv;
  if (high < low || close < low || close > high || open < low || open > high) {
    throw new Error('INVALID_MARKET_SNAPSHOT: OHLCV price relationships invalid');
  }

  if (snapshot.bid > snapshot.ask) {
    throw new Error('INVALID_MARKET_SNAPSHOT: Negative spread detected (bid > ask)');
  }

  if (snapshot.exchangeTimestamp && snapshot.exchangeTimestamp > snapshot.timestamp) {
    throw new Error('FUTURE_DATA_LEAKAGE: exchangeTimestamp is in the future relative to snapshot timestamp');
  }
}

/**
 * Creates and freezes an immutable MarketSnapshot.
 */
export function createMarketSnapshot(params: {
  snapshotId?: string;
  instrument: MarketSnapshotInstrument;
  timestamp: number;
  exchangeTimestamp?: number;
  ohlcv: MarketSnapshotOHLCV;
  bid: number;
  ask: number;
  volume: number;
  marketStatus?: 'OPEN' | 'CLOSED' | 'HALTED' | 'AUCTION';
  dataSource: string;
  dataVersion: string;
  sourceSequence?: number;
}): MarketSnapshot {
  const snapshot: MarketSnapshot = {
    snapshotId: params.snapshotId || `snap_${randomUUID()}`,
    instrument: { ...params.instrument },
    timestamp: params.timestamp,
    exchangeTimestamp: params.exchangeTimestamp,
    ohlcv: { ...params.ohlcv },
    bid: params.bid,
    ask: params.ask,
    spread: params.ask - params.bid,
    volume: params.volume,
    marketStatus: params.marketStatus || 'OPEN',
    dataSource: params.dataSource,
    dataVersion: params.dataVersion,
    sourceSequence: params.sourceSequence,
  };

  validatePointInTimeSnapshot(snapshot);
  return deepFreeze(snapshot);
}

/**
 * Computes a cryptographic decision fingerprint covering only Point-In-Time decision inputs and parameters.
 */
export function computeDecisionFingerprint(params: {
  modelIdentity: ModelIdentity;
  snapshotId: string;
  featureVersion: string;
  featureSchemaHash: string;
  featureDataCutoff: number;
  action: TradingAction;
  signal: string;
  entryPrice?: number;
  stopLoss?: number;
  takeProfit?: number;
  positionSize?: number;
}): string {
  const payload = {
    modelIdentity: params.modelIdentity,
    snapshotId: params.snapshotId,
    featureVersion: params.featureVersion,
    featureSchemaHash: params.featureSchemaHash,
    featureDataCutoff: params.featureDataCutoff,
    action: params.action,
    signal: params.signal,
    entryPrice: params.entryPrice ?? null,
    stopLoss: params.stopLoss ?? null,
    takeProfit: params.takeProfit ?? null,
    positionSize: params.positionSize ?? null,
  };
  return createHash('sha256').update(canonicalJsonStringify(payload)).digest('hex');
}

/**
 * Validates that Champion and Challenger contexts evaluated the exact same market snapshot and environment.
 */
export function validateDecisionParity(
  championContext: DecisionContext,
  challengerContext: DecisionContext
): { isParityValid: boolean; violations: string[] } {
  const violations: string[] = [];

  if (championContext.snapshotId !== challengerContext.snapshotId) {
    violations.push(
      `Snapshot ID mismatch: champion=${championContext.snapshotId}, challenger=${challengerContext.snapshotId}`
    );
  }

  if (championContext.instrument.symbol !== challengerContext.instrument.symbol) {
    violations.push('Instrument symbol mismatch');
  }

  if (championContext.featureVersion !== challengerContext.featureVersion) {
    violations.push('Feature version mismatch');
  }

  if (championContext.featureSchemaHash !== challengerContext.featureSchemaHash) {
    violations.push('Feature schema hash mismatch');
  }

  if (championContext.featureDataCutoff !== challengerContext.featureDataCutoff) {
    violations.push('Feature data cutoff timestamp mismatch');
  }

  if (championContext.strategyConfigHash !== challengerContext.strategyConfigHash) {
    violations.push('Strategy config hash mismatch');
  }

  if (championContext.executionConfigHash !== challengerContext.executionConfigHash) {
    violations.push('Execution config hash mismatch');
  }

  if (championContext.riskConfigHash !== challengerContext.riskConfigHash) {
    violations.push('Risk config hash mismatch');
  }

  if (championContext.costConfigHash !== challengerContext.costConfigHash) {
    violations.push('Cost config hash mismatch');
  }

  return {
    isParityValid: violations.length === 0,
    violations,
  };
}

/**
 * Classifies the divergence between Champion and Challenger decisions.
 */
export function classifyDecisionDivergence(
  championDecision: TradingDecision,
  challengerDecision: TradingDecision
): { divergence: 'AGREE' | 'DISAGREE'; divergenceType: DecisionDivergenceType } {
  const champAction = championDecision.action;
  const challAction = challengerDecision.action;

  const isNoAction = (a: TradingAction) => a === 'HOLD' || a === 'WAIT' || a === 'NO_ACTION';
  const isTradeAction = (a: TradingAction) => a === 'BUY' || a === 'SELL';

  if (isNoAction(champAction) && isNoAction(challAction)) {
    return { divergence: 'AGREE', divergenceType: 'BOTH_NO_ACTION' };
  }

  if (isTradeAction(champAction) && isNoAction(challAction)) {
    return { divergence: 'DISAGREE', divergenceType: 'CHAMPION_ONLY_ACTION' };
  }

  if (isNoAction(champAction) && isTradeAction(challAction)) {
    return { divergence: 'DISAGREE', divergenceType: 'CHALLENGER_ONLY_ACTION' };
  }

  if (champAction === challAction) {
    const sizeDiff = Math.abs((championDecision.positionSize || 0) - (challengerDecision.positionSize || 0));
    if (sizeDiff < 1e-6) {
      return { divergence: 'AGREE', divergenceType: 'BOTH_ACTION_SAME_DIRECTION_SAME_SIZE' };
    }
    return { divergence: 'DISAGREE', divergenceType: 'BOTH_ACTION_SAME_DIRECTION_DIFFERENT_SIZE' };
  }

  return { divergence: 'DISAGREE', divergenceType: 'BOTH_ACTION_DIFFERENT_DIRECTION' };
}

/**
 * Creates an immutable ChampionChallengerDecisionPair connecting both decisions.
 */
export function createDecisionPair(params: {
  pairId?: string;
  championDecision: TradingDecision;
  challengerDecision: TradingDecision;
}): ChampionChallengerDecisionPair {
  const parity = validateDecisionParity(
    params.championDecision.context,
    params.challengerDecision.context
  );

  if (!parity.isParityValid) {
    throw new Error(
      `INVALID_DECISION_PAIR: Decision parity validation failed: ${parity.violations.join('; ')}`
    );
  }

  const { divergence, divergenceType } = classifyDecisionDivergence(
    params.championDecision,
    params.challengerDecision
  );

  const pairId = params.pairId || `pair_${randomUUID()}`;
  const pairFingerprint = createHash('sha256')
    .update(
      canonicalJsonStringify({
        pairId,
        snapshotId: params.championDecision.context.snapshotId,
        championFingerprint: params.championDecision.decisionFingerprint,
        challengerFingerprint: params.challengerDecision.decisionFingerprint,
        divergenceType,
      })
    )
    .digest('hex');

  const pair: ChampionChallengerDecisionPair = {
    pairId,
    snapshotId: params.championDecision.context.snapshotId,
    decisionTimestamp: params.championDecision.context.decisionTimestamp,
    championDecisionId: params.championDecision.decisionId,
    challengerDecisionId: params.challengerDecision.decisionId,
    championModelIdentity: params.championDecision.context.modelIdentity,
    challengerModelIdentity: params.challengerDecision.context.modelIdentity,
    championEvaluationFingerprint: params.championDecision.context.evaluationFingerprint,
    challengerEvaluationFingerprint: params.challengerDecision.context.evaluationFingerprint,
    championDecision: params.championDecision,
    challengerDecision: params.challengerDecision,
    divergence,
    divergenceType,
    decisionPairFingerprint: pairFingerprint,
  };

  return deepFreeze(pair);
}
