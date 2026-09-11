import { createHash, randomUUID } from 'crypto';
import { canonicalJsonStringify } from '../canonical-serializer';
import { deepFreeze } from '../champion-challenger/evaluation-identity';
import {
  MarketSnapshot,
  MarketSnapshotInstrument,
  MarketSnapshotOHLCV,
  PortfolioSnapshot,
  DecisionContext,
  TradingDecision,
  TradingAction,
  ChampionChallengerDecisionPair,
  DecisionDivergenceType,
  ModelIdentity,
  ExecutionMode,
  ModelRole
} from './types';
import { ILiveExecutionPort, IShadowExecutionPort, assertLiveExecution, assertShadowExecution } from './safety-guard';
import { IShadowExecutionStore } from './shadow-execution-store';

/**
 * Validates that all market data inside a snapshot respects Point-In-Time (PIT) safety
 * and does not contain future data relative to snapshot.timestamp.
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
 * Creates and freezes an immutable MarketSnapshot with a cryptographic snapshotHash.
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
  const snapshotId = params.snapshotId || `snap_${randomUUID()}`;
  const spread = params.ask - params.bid;

  const rawPayload = {
    snapshotId,
    instrument: params.instrument,
    timestamp: params.timestamp,
    exchangeTimestamp: params.exchangeTimestamp ?? null,
    ohlcv: params.ohlcv,
    bid: params.bid,
    ask: params.ask,
    spread,
    volume: params.volume,
    marketStatus: params.marketStatus || 'OPEN',
    dataSource: params.dataSource,
    dataVersion: params.dataVersion,
    sourceSequence: params.sourceSequence ?? null,
  };

  const snapshotHash = createHash('sha256')
    .update(canonicalJsonStringify(rawPayload))
    .digest('hex');

  const snapshot: MarketSnapshot = {
    ...rawPayload,
    exchangeTimestamp: params.exchangeTimestamp,
    marketStatus: params.marketStatus || 'OPEN',
    sourceSequence: params.sourceSequence,
    snapshotHash,
  };

  validatePointInTimeSnapshot(snapshot);
  return deepFreeze(snapshot);
}

/**
 * Creates an immutable point-in-time PortfolioSnapshot with cryptographic portfolioStateHash.
 */
export function createPortfolioSnapshot(params: {
  portfolioId: string;
  timestamp: number;
  cash: number;
  equity: number;
  openPositionsCount: number;
}): PortfolioSnapshot {
  const raw = {
    portfolioId: params.portfolioId,
    timestamp: params.timestamp,
    cash: params.cash,
    equity: params.equity,
    openPositionsCount: params.openPositionsCount,
  };
  const portfolioStateHash = createHash('sha256')
    .update(canonicalJsonStringify(raw))
    .digest('hex');

  const snapshot: PortfolioSnapshot = {
    ...raw,
    portfolioStateHash,
  };
  return deepFreeze(snapshot);
}

/**
 * Computes a comprehensive decision fingerprint covering all Point-In-Time input contexts and decision parameters.
 */
export function computeDecisionFingerprint(params: {
  modelIdentity: ModelIdentity;
  snapshotId: string;
  snapshotHash: string;
  portfolioStateHash: string;
  featureVersion: string;
  featureSchemaHash: string;
  featureInputHash: string;
  featureDataCutoff: number;
  strategyConfigHash?: string;
  executionConfigHash?: string;
  riskConfigHash?: string;
  costConfigHash?: string;
  action: TradingAction;
  signal: string;
  entryPrice?: number;
  stopLoss?: number;
  takeProfit?: number;
  positionSize?: number;
  riskAmount?: number;
}): string {
  const payload = {
    modelIdentity: params.modelIdentity,
    snapshotId: params.snapshotId,
    snapshotHash: params.snapshotHash,
    portfolioStateHash: params.portfolioStateHash,
    featureVersion: params.featureVersion,
    featureSchemaHash: params.featureSchemaHash,
    featureInputHash: params.featureInputHash,
    featureDataCutoff: params.featureDataCutoff,
    strategyConfigHash: params.strategyConfigHash ?? null,
    executionConfigHash: params.executionConfigHash ?? null,
    riskConfigHash: params.riskConfigHash ?? null,
    costConfigHash: params.costConfigHash ?? null,
    action: params.action,
    signal: params.signal,
    entryPrice: params.entryPrice ?? null,
    stopLoss: params.stopLoss ?? null,
    takeProfit: params.takeProfit ?? null,
    positionSize: params.positionSize ?? null,
    riskAmount: params.riskAmount ?? null,
  };
  return createHash('sha256').update(canonicalJsonStringify(payload)).digest('hex');
}

/**
 * Validates that Champion and Challenger contexts evaluated the exact same market snapshot,
 * portfolio state, and feature environment.
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

  if (championContext.snapshotHash !== challengerContext.snapshotHash) {
    violations.push(
      `Snapshot hash mismatch: champion=${championContext.snapshotHash}, challenger=${challengerContext.snapshotHash}`
    );
  }

  if (championContext.portfolioStateHash !== challengerContext.portfolioStateHash) {
    violations.push('Portfolio state hash mismatch');
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

  if (championContext.featureInputHash !== challengerContext.featureInputHash) {
    violations.push('Feature input vector hash mismatch');
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
        snapshotHash: params.championDecision.context.snapshotHash,
        championFingerprint: params.championDecision.decisionFingerprint,
        challengerFingerprint: params.challengerDecision.decisionFingerprint,
        divergenceType,
      })
    )
    .digest('hex');

  const pair: ChampionChallengerDecisionPair = {
    pairId,
    snapshotId: params.championDecision.context.snapshotId,
    snapshotHash: params.championDecision.context.snapshotHash,
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

/**
 * Synchronized live/shadow execution orchestrator.
 * Evaluates Champion on the fast-path critical path and runs Challenger asynchronously
 * without blocking or altering Champion production execution.
 */
export class SynchronizedShadowOrchestrator {
  private readonly store: IShadowExecutionStore;
  private readonly livePort?: ILiveExecutionPort;
  private readonly shadowPort: IShadowExecutionPort;

  constructor(params: {
    store: IShadowExecutionStore;
    livePort?: ILiveExecutionPort;
    shadowPort: IShadowExecutionPort;
  }) {
    this.store = params.store;
    this.livePort = params.livePort;
    this.shadowPort = params.shadowPort;
  }

  /**
   * Evaluates Champion synchronously for production execution and launches Challenger in the background.
   * Slow Challenger execution NEVER delays Champion decision return.
   */
  public executeDecisionFlow(params: {
    snapshot: MarketSnapshot;
    portfolioSnapshot: PortfolioSnapshot;
    featureExtractor: () => { features: Record<string, number>; featureHash: string; featureLatencyMs: number };
    championEvaluator: (ctx: DecisionContext, features: Record<string, number>) => TradingDecision;
    challengerEvaluator: (ctx: DecisionContext, features: Record<string, number>) => Promise<TradingDecision> | TradingDecision;
    championIdentity: ModelIdentity;
    challengerIdentity: ModelIdentity;
    sharedConfigs: {
      featureVersion: string;
      featureSchemaHash: string;
      strategyVersion: string;
      strategyConfigHash: string;
      executionConfigVersion: string;
      executionConfigHash: string;
      riskConfigVersion: string;
      riskConfigHash: string;
      costConfigVersion: string;
      costConfigHash: string;
      portfolioStateVersion: string;
    };
  }): { championDecision: TradingDecision; pairPromise: Promise<ChampionChallengerDecisionPair> } {
    // 1. Check idempotency at the storage boundary
    const existingPair = this.store.getDecisionPairBySnapshot(params.snapshot.snapshotId);
    if (existingPair) {
      return {
        championDecision: existingPair.championDecision,
        pairPromise: Promise.resolve(existingPair),
      };
    }

    // 2. Extract PIT features once for both models
    const featureRes = params.featureExtractor();
    const decisionTimestamp = Date.now();

    // 3. Build immutable shared contexts
    const champContext: DecisionContext = deepFreeze({
      decisionId: `dec_champ_${randomUUID()}`,
      snapshotId: params.snapshot.snapshotId,
      snapshotHash: params.snapshot.snapshotHash,
      decisionTimestamp,
      instrument: params.snapshot.instrument,
      marketSnapshot: params.snapshot,
      portfolioSnapshot: params.portfolioSnapshot,
      featureVersion: params.sharedConfigs.featureVersion,
      featureSchemaHash: params.sharedConfigs.featureSchemaHash,
      featureInputHash: featureRes.featureHash,
      featureDataCutoff: params.snapshot.timestamp,
      strategyVersion: params.sharedConfigs.strategyVersion,
      strategyConfigHash: params.sharedConfigs.strategyConfigHash,
      executionConfigVersion: params.sharedConfigs.executionConfigVersion,
      executionConfigHash: params.sharedConfigs.executionConfigHash,
      riskConfigVersion: params.sharedConfigs.riskConfigVersion,
      riskConfigHash: params.sharedConfigs.riskConfigHash,
      costConfigVersion: params.sharedConfigs.costConfigVersion,
      costConfigHash: params.sharedConfigs.costConfigHash,
      portfolioStateVersion: params.sharedConfigs.portfolioStateVersion,
      portfolioStateHash: params.portfolioSnapshot.portfolioStateHash,
      modelIdentity: params.championIdentity,
      evaluationFingerprint: `efp_champ_${params.championIdentity.modelId}`,
      mode: 'LIVE',
      modelRole: 'CHAMPION',
    });

    const challContext: DecisionContext = deepFreeze({
      decisionId: `dec_chall_${randomUUID()}`,
      snapshotId: params.snapshot.snapshotId,
      snapshotHash: params.snapshot.snapshotHash,
      decisionTimestamp,
      instrument: params.snapshot.instrument,
      marketSnapshot: params.snapshot,
      portfolioSnapshot: params.portfolioSnapshot,
      featureVersion: params.sharedConfigs.featureVersion,
      featureSchemaHash: params.sharedConfigs.featureSchemaHash,
      featureInputHash: featureRes.featureHash,
      featureDataCutoff: params.snapshot.timestamp,
      strategyVersion: params.sharedConfigs.strategyVersion,
      strategyConfigHash: params.sharedConfigs.strategyConfigHash,
      executionConfigVersion: params.sharedConfigs.executionConfigVersion,
      executionConfigHash: params.sharedConfigs.executionConfigHash,
      riskConfigVersion: params.sharedConfigs.riskConfigVersion,
      riskConfigHash: params.sharedConfigs.riskConfigHash,
      costConfigVersion: params.sharedConfigs.costConfigVersion,
      costConfigHash: params.sharedConfigs.costConfigHash,
      portfolioStateVersion: params.sharedConfigs.portfolioStateVersion,
      portfolioStateHash: params.portfolioSnapshot.portfolioStateHash,
      modelIdentity: params.challengerIdentity,
      evaluationFingerprint: `efp_chall_${params.challengerIdentity.modelId}`,
      mode: 'SHADOW',
      modelRole: 'CHALLENGER',
    });

    // 4. CRITICAL FAST PATH: Champion executes immediately
    const championDecision = params.championEvaluator(champContext, featureRes.features);
    if (this.livePort && (championDecision.action === 'BUY' || championDecision.action === 'SELL')) {
      assertLiveExecution(champContext, this.livePort);
      // Submit live order via live port
      this.livePort.submitLiveOrder(championDecision);
    }

    // 5. ASYNC ISOLATED PATH: Challenger executes in background with shadow port only
    const pairPromise = (async () => {
      try {
        const challengerDecision = await Promise.resolve(
          params.challengerEvaluator(challContext, featureRes.features)
        );

        if (challengerDecision.action === 'BUY' || challengerDecision.action === 'SELL') {
          assertShadowExecution(challContext, this.shadowPort);
          this.shadowPort.submitShadowOrder({
            shadowOrderId: `so_${randomUUID()}`,
            decisionId: challengerDecision.decisionId,
            instrument: params.snapshot.instrument,
            side: challengerDecision.action,
            quantity: challengerDecision.positionSize || 1,
            requestedPrice: challengerDecision.entryPrice || params.snapshot.ohlcv.close,
            stopLoss: challengerDecision.stopLoss,
            takeProfit: challengerDecision.takeProfit,
            orderType: 'MARKET',
            createdAt: decisionTimestamp,
            executionConfigVersion: params.sharedConfigs.executionConfigVersion,
            costConfigVersion: params.sharedConfigs.costConfigVersion,
            status: 'PENDING',
          });
        }

        const pair = createDecisionPair({
          championDecision,
          challengerDecision,
        });

        // Persist idempotently
        this.store.saveSnapshot(params.snapshot);
        this.store.saveDecision(championDecision);
        this.store.saveDecision(challengerDecision);
        this.store.saveDecisionPair(pair);

        return pair;
      } catch (err) {
        // If Challenger fails, champion production execution has already succeeded
        throw err;
      }
    })();

    return {
      championDecision,
      pairPromise,
    };
  }
}
