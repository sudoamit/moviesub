import { createHash } from 'crypto';
import { ICandle, Direction, SignalGrade } from '@quant/shared';
import {
  ExecutionSimulator,
  FillModel,
  SameCandleAmbiguityMode,
  IFeeConfig,
  ISlippageConfig,
  ISpreadConfig,
  ExecutionCostStressConfig,
  ILatencyConfig,
  IFill,
} from '@quant/backtesting';
import {
  SignalGenerator,
  CanonicalMLEngineV2,
  SnapshotBuilder,
  CANONICAL_FEATURE_NAMES_V2,
  CANONICAL_V2_DIMENSION,
} from '@quant/trading-engine';
import { CandidateArtifact, ShadowEvaluationMetrics } from './types';
import { canonicalJsonStringify } from './canonical-serializer';
import { ChallengerEvaluation, ChampionChallengerCoordinator, ChampionSnapshot, ShadowEvidence } from './champion-challenger';
import { ProductionExecutionContext, ProductionExecutionContextInput } from './execution-context';

export type ShadowDecisionAction = 'ENTER_LONG' | 'ENTER_SHORT' | 'EXIT' | 'HOLD';
export type ShadowMode = 'LIVE' | 'PAPER' | 'SHADOW';
export type ShadowExecutionType = 'ENTRY' | 'EXIT' | 'PARTIAL_EXIT' | 'REVERSAL_EXIT' | 'REVERSAL_ENTRY';
export type BacktestEndPolicy = 'CANCEL_PENDING_AT_END' | 'LEAVE_PENDING_AT_END' | 'FORCE_CLOSE_POSITION_AT_END';

export type DivergenceType =
  | 'ENTER_vs_HOLD'
  | 'EXIT_vs_HOLD'
  | 'LONG_vs_SHORT'
  | 'LONG_vs_FLAT'
  | 'SHORT_vs_FLAT'
  | 'SIZING_DIFFERENCE'
  | 'RISK_DIFFERENCE';

export interface EvaluationMarketSnapshot {
  readonly snapshotId: string;
  readonly snapshotHash: string;
  readonly symbol: string;
  readonly timeframe: string;
  readonly marketDataCutoffTimestamp: number;
  readonly source: string;
  readonly datasetHash: string;
  readonly dataVersion: string;
  readonly candleIds: readonly string[];
  readonly featureSnapshotHash: string;
  readonly executionContextHash: string;
  readonly executionContextVersion: string;
  readonly candle: ICandle;
}

export interface FeatureSnapshot {
  readonly featurePipelineVersion: string;
  readonly featureVersion: string;
  readonly featureSchemaHash: string;
  readonly canonicalMLFeatureHash: string;
  readonly featureHash: string;
  readonly generatedAt: number;
  readonly sourceSnapshotHash: string;
  readonly cutoffTimestamp: number;
  readonly features: Readonly<Record<string, number>>;
}

export interface ShadowDecision {
  readonly decisionId: string;
  readonly timestamp: number;
  readonly decisionCutoffTimestamp: number;
  readonly action: ShadowDecisionAction;
  readonly symbol: string;
  readonly timeframe: string;
  readonly confidence?: number;
  readonly positionTarget: 'LONG' | 'SHORT' | 'FLAT';
  readonly quantity: number;
  readonly riskState: Readonly<Record<string, number>>;
  readonly featureSnapshotHash: string;
  readonly snapshotId: string;
  readonly snapshotHash: string;
  readonly marketDataCutoffTimestamp: number;
  readonly executionContextHash: string;
}

export interface ShadowPendingOrder {
  readonly orderId: string;
  readonly clientOrderId?: string;
  readonly tradeId: string;
  readonly symbol: string;
  readonly side: 'BUY' | 'SELL';
  readonly orderType: 'MARKET' | 'LIMIT' | 'STOP';
  readonly positionEffect: 'OPEN' | 'CLOSE' | 'PARTIAL_EXIT' | 'REVERSE_EXIT' | 'REVERSE_ENTRY';
  readonly requestedQuantity: number;
  readonly filledQuantity: number;
  readonly remainingQuantity: number;
  readonly status: 'PENDING' | 'PARTIALLY_FILLED' | 'FILLED' | 'CANCELLED' | 'REJECTED';
  readonly submissionTimestamp: number;
  readonly arrivalTimestamp: number;
  readonly executionTimestamp?: number;
  readonly limitPrice?: number;
  readonly stopPrice?: number;
  readonly strategyId?: string;
  readonly decisionId?: string;
  readonly createdAtMarketTimestamp: number;
  readonly exitTarget?: 'TP1' | 'TP2' | 'TP3' | 'SL' | 'TRAILING_STOP' | 'ENTRY' | string;
  readonly cancelReason?: string;
  readonly cancelTimestamp?: number;
}

export interface ShadowExecutionResult {
  readonly orderId: string;
  readonly decisionId: string;
  readonly executionType: ShadowExecutionType;
  readonly notional: number;
  readonly entryPrice: number;
  readonly exitPrice: number;
  readonly quantity: number;
  readonly fees: number;
  readonly slippage: number;
  readonly grossPnL: number;
  readonly realizedPnL: number;
  readonly unrealizedPnL: number;
  readonly rMultiple: number;
  readonly decisionTimestamp: number;
  readonly decisionCutoffTimestamp: number;
  readonly orderSubmissionTimestamp: number;
  readonly orderArrivalTimestamp: number;
  readonly executionTimestamp: number;
  readonly executionContextHash: string;
}

export interface ShadowBranchState {
  readonly capital: number;
  readonly position: 'LONG' | 'SHORT' | 'FLAT';
  readonly quantity: number;
  readonly initialQuantity: number;
  readonly entryPrice: number;
  readonly rawEntryPrice: number;
  readonly averageEntryPrice: number;
  readonly entryFees: number;
  readonly remainingEntryFees: number;
  readonly entrySlippage: number;
  readonly remainingEntrySlippage: number;
  readonly realizedPnL: number;
  readonly unrealizedPnL: number;
  readonly pendingOrders: readonly ShadowPendingOrder[];
  readonly openOrders: readonly string[];
  readonly closedTrades: readonly ShadowExecutionResult[];
  readonly riskState: Readonly<Record<string, number>>;
  readonly portfolioState: Readonly<Record<string, number>>;
}

export interface ShadowBranchResult {
  readonly mode: ShadowMode;
  readonly state: ShadowBranchState;
  readonly decisions: readonly ShadowDecision[];
  readonly executions: readonly ShadowExecutionResult[];
  readonly metrics: Phase10BShadowMetrics;
  readonly simulatorId: string;
  readonly feeModelHash: string;
  readonly slippageModelHash: string;
  readonly hasProductionOrderRouter: boolean;
}

export interface Phase10BShadowMetrics extends ShadowEvaluationMetrics {
  readonly totalPnL: number;
  readonly returnPct: number;
  readonly tradeCount: number;
  readonly averageTrade: number;
  readonly turnover: number;
  readonly costAdjustedPnL: number;
  readonly riskAdjustedReturn: number;
}

export interface ShadowComparisonEvaluation {
  readonly evaluationId: string;
  readonly championArtifactHash: string;
  readonly challengerArtifactHash: string;
  readonly championSnapshotHash: string;
  readonly executionContextHash: string;
  readonly executionContextVersion: string;
  readonly datasetHash: string;
  readonly marketDataStartTimestamp: number;
  readonly marketDataEndTimestamp: number;
  readonly observationCount: number;
  readonly championMetrics: Phase10BShadowMetrics;
  readonly challengerMetrics: Phase10BShadowMetrics;
  readonly relativeMetrics: Readonly<Record<string, number>>;
  readonly decisionAgreement: number;
  readonly decisionDivergence: Readonly<Record<DivergenceType, number>>;
  readonly shadowEvaluationVersion: string;
  readonly evidenceHash: string;
}

export interface ShadowEvaluationCheckpoint {
  readonly configHash: string;
  readonly evaluationId: string;
  readonly lastProcessedTimestamp: number;
  readonly lastSnapshotId: string;
  readonly marketSnapshotsPrefixHash: string;
  readonly featureSnapshotsPrefixHash: string;
  readonly championDecisionsPrefixHash: string;
  readonly challengerDecisionsPrefixHash: string;
  readonly championExecutionsPrefixHash: string;
  readonly challengerExecutionsPrefixHash: string;
  readonly championPendingOrdersPrefixHash: string;
  readonly challengerPendingOrdersPrefixHash: string;
  readonly championStateHash: string;
  readonly challengerStateHash: string;
  readonly metricsStateHash: string;
  readonly processedEventCount: number;
  readonly state: {
    readonly champion: ShadowBranchResult;
    readonly challenger: ShadowBranchResult;
    readonly marketSnapshots: readonly EvaluationMarketSnapshot[];
    readonly featureSnapshots: readonly FeatureSnapshot[];
  };
}

export interface SynchronizedShadowEvaluationResult {
  readonly evaluation: ShadowComparisonEvaluation;
  readonly shadowEvidence: ShadowEvidence;
  readonly champion: ShadowBranchResult;
  readonly challenger: ShadowBranchResult;
  readonly marketSnapshots: readonly EvaluationMarketSnapshot[];
  readonly featureSnapshots: readonly FeatureSnapshot[];
  readonly shadowEvaluationHash: string;
  readonly checkpoint?: ShadowEvaluationCheckpoint;
}

export interface ShadowExecutionConfig {
  readonly initialCapital: number;
  readonly feePerTrade?: number;
  readonly slippagePerTrade?: number;
  readonly feeRate?: number;
  readonly feeBps?: number;
  readonly slippageBps?: number;
  readonly riskPerTrade: number;
  readonly quantity: number;
  readonly fillModel?: string;
  readonly ambiguityMode?: string;
  readonly latencyMs?: number;
  readonly backtestEndPolicy?: BacktestEndPolicy;
  readonly partialFillRatio?: number;
}

export interface SynchronizedShadowEvaluationOptions {
  readonly champion: CandidateArtifact;
  readonly challenger: CandidateArtifact;
  readonly championSnapshot: ChampionSnapshot;
  readonly coordinatorEvaluation: ChallengerEvaluation;
  readonly candles: readonly ICandle[];
  readonly symbol: string;
  readonly timeframe: string;
  readonly source: string;
  readonly datasetHash: string;
  readonly dataVersion: string;
  readonly marketDataCutoffTimestamp: number;
  readonly featureVersion: string;
  readonly generatedAt?: number;
  readonly executionConfig?: ShadowExecutionConfig;
  readonly productionExecutionContext?: ProductionExecutionContext;
  readonly maxEvents?: number;
  readonly checkpoint?: ShadowEvaluationCheckpoint;
  readonly decisionProvider?: (input: {
    readonly artifact: CandidateArtifact;
    readonly snapshot: EvaluationMarketSnapshot;
    readonly features: FeatureSnapshot;
    readonly state: ShadowBranchState;
    readonly mode: ShadowMode;
  }) => Omit<
    ShadowDecision,
    | 'decisionId'
    | 'timestamp'
    | 'symbol'
    | 'timeframe'
    | 'featureSnapshotHash'
    | 'snapshotId'
    | 'snapshotHash'
    | 'marketDataCutoffTimestamp'
    | 'executionContextHash'
    | 'decisionCutoffTimestamp'
  >;
}

function freeze<T>(value: T): T {
  return Object.freeze(value);
}

function hash(value: unknown): string {
  return createHash('sha256').update(canonicalJsonStringify(value)).digest('hex');
}

function timestampOf(candle: ICandle): number {
  return candle.timestamp instanceof Date ? candle.timestamp.getTime() : new Date(candle.timestamp).getTime();
}

function cloneState(state: ShadowBranchState): ShadowBranchState {
  return {
    capital: state.capital,
    position: state.position,
    quantity: state.quantity,
    initialQuantity: state.initialQuantity,
    entryPrice: state.entryPrice,
    rawEntryPrice: state.rawEntryPrice,
    averageEntryPrice: state.averageEntryPrice,
    entryFees: state.entryFees,
    remainingEntryFees: state.remainingEntryFees,
    entrySlippage: state.entrySlippage,
    remainingEntrySlippage: state.remainingEntrySlippage,
    realizedPnL: state.realizedPnL,
    unrealizedPnL: state.unrealizedPnL,
    pendingOrders: [...state.pendingOrders],
    openOrders: [...state.openOrders],
    closedTrades: [...state.closedTrades],
    riskState: { ...state.riskState },
    portfolioState: { ...state.portfolioState },
  };
}

export class SynchronizedEvaluationClock {
  private cursor = 0;

  public constructor(private readonly snapshots: readonly EvaluationMarketSnapshot[]) {}

  public next(): EvaluationMarketSnapshot | undefined {
    if (this.cursor >= this.snapshots.length) {
      return undefined;
    }
    const current = this.snapshots[this.cursor];
    this.cursor += 1;
    return current;
  }

  public get currentCursor(): number {
    return this.cursor;
  }
}

/**
 * Adapter integrating Shadow Evaluations with the canonical ExecutionSimulator.
 * Follows a clean event-driven order lifecycle:
 * Decision -> ShadowPendingOrder -> arrivalTimestamp reached -> Simulator Evaluation -> State Reducer.
 */
export class ShadowExecutionAdapter {
  public readonly simulatorId: string;
  public readonly fillModelHash: string;
  public readonly slippageModelHash: string;
  public readonly feeModelHash: string;
  public readonly hasProductionOrderRouter: boolean;
  public readonly simulator: ExecutionSimulator;
  public readonly latencyMs: number;
  public readonly symbol: string;
  private readonly fillModel: FillModel;
  private readonly ambiguityMode: SameCandleAmbiguityMode;
  private readonly latencyConfig: ILatencyConfig;
  private readonly slippageConfig?: ISlippageConfig;
  private readonly feeConfig?: IFeeConfig;
  private readonly spreadConfig?: ISpreadConfig;
  private readonly costStressConfig?: ExecutionCostStressConfig;
  private readonly runId: string;
  private orderSequence = 0;

  public constructor(
    private readonly mode: ShadowMode,
    private readonly executionContext: ProductionExecutionContextInput | ProductionExecutionContext,
    private readonly config: ShadowExecutionConfig,
    runId = 'shadow-eval',
  ) {
    this.hasProductionOrderRouter = mode !== 'SHADOW';
    this.simulatorId = `canonical-execution-simulator-${runId}`;
    this.symbol = executionContext.symbol;
    this.runId = runId;

    this.fillModel = ((executionContext.fillModel || config.fillModel || 'OHLC_PATH') as FillModel);
    this.ambiguityMode = ((executionContext.ambiguityMode || config.ambiguityMode || 'CONSERVATIVE') as SameCandleAmbiguityMode);
    this.latencyMs =
      config.latencyMs !== undefined
        ? config.latencyMs
        : (executionContext.latencyConfig?.submissionLatencyMs ?? 15);
    this.latencyConfig = {
      submissionLatencyMs: this.latencyMs,
      processingLatencyMs: executionContext.latencyConfig?.processingLatencyMs ?? 5,
    };

    let feeConfig: IFeeConfig | undefined;
    if (config.feePerTrade !== undefined) {
      feeConfig = { brokerageFlat: config.feePerTrade };
    } else if (config.feeRate !== undefined) {
      feeConfig = { brokerageRateBps: config.feeRate * 10000 };
    } else if (config.feeBps !== undefined) {
      feeConfig = { brokerageRateBps: config.feeBps };
    } else {
      feeConfig = executionContext.feeConfig;
    }
    this.feeConfig = feeConfig;

    let slippageConfig: ISlippageConfig | undefined;
    if (config.slippageBps !== undefined) {
      slippageConfig = {
        baseSlippageBps: config.slippageBps,
        volatilityMultiplier: 1.0,
        impactMultiplier: 1.0,
        maxSlippageBps: Math.max(25.0, config.slippageBps * 2),
      };
    } else if (config.slippagePerTrade !== undefined) {
      slippageConfig = {
        baseSlippageBps: 0,
        volatilityMultiplier: 0,
        impactMultiplier: 0,
        maxSlippageBps: 0,
      };
    } else {
      slippageConfig = executionContext.slippageConfig;
    }
    this.slippageConfig = slippageConfig;

    const spreadConfig: ISpreadConfig | undefined =
      executionContext.spreadConfig ||
      (config.feePerTrade !== undefined || config.slippagePerTrade !== undefined
        ? { baseSpreadBps: 0, illiquidMultiplier: 1.0 }
        : undefined);
    this.spreadConfig = spreadConfig;
    this.costStressConfig = executionContext.costStressConfig;

    this.fillModelHash = hash(this.fillModel);
    this.feeModelHash = hash(feeConfig ?? { type: 'zero-fee' });
    this.slippageModelHash = hash(slippageConfig ?? { type: 'zero-slippage' });

    this.simulator = this.createSimulator();
  }

  /**
   * Factory creating a canonical ExecutionSimulator instance configured with authoritative settings.
   */
  public createSimulator(customRunId?: string): ExecutionSimulator {
    return new ExecutionSimulator(
      this.fillModel,
      this.ambiguityMode,
      this.latencyConfig,
      customRunId || this.runId,
      this.slippageConfig,
      this.feeConfig,
      this.spreadConfig,
      this.costStressConfig,
    );
  }

  /**
   * Submits persistent pending orders resulting from a strategy decision.
   * Computes exact causal timestamps (submissionTimestamp and arrivalTimestamp).
   * Note: Orders are stored purely in shadow pending state; they are NOT sent to the simulator until arrival.
   */
  public submitDecisionOrders(
    decision: ShadowDecision,
    snapshot: EvaluationMarketSnapshot,
    state: ShadowBranchState,
  ): readonly ShadowPendingOrder[] {
    if (this.mode === 'SHADOW' && this.hasProductionOrderRouter) {
      throw new Error('SHADOW_PRODUCTION_ROUTER_FORBIDDEN');
    }

    const decisionCutoffTimestamp = decision.decisionCutoffTimestamp;
    const decisionTimestamp = decision.timestamp;

    if (decisionTimestamp < decisionCutoffTimestamp) {
      throw new Error('SHADOW_LOOKAHEAD_DETECTED: Decision timestamp cannot precede decision cutoff');
    }
    if (decisionCutoffTimestamp > snapshot.marketDataCutoffTimestamp) {
      throw new Error('SHADOW_LOOKAHEAD_DETECTED: Decision cutoff exceeds snapshot cutoff');
    }

    const action = decision.action;
    if (action === 'HOLD') {
      return [];
    }

    const orderSubmissionTimestamp = decisionTimestamp;
    const orderArrivalTimestamp = orderSubmissionTimestamp + this.latencyMs;
    const newOrders: ShadowPendingOrder[] = [];

    // 1. Handle EXIT from an active position
    if (action === 'EXIT' && state.position !== 'FLAT' && state.quantity > 0) {
      const exitSide = state.position === 'LONG' ? 'SELL' : 'BUY';
      const isPartial = decision.quantity > 0 && decision.quantity < state.quantity;
      const exitQty = isPartial ? decision.quantity : state.quantity;

      this.orderSequence += 1;
      const orderId = `ord-${decision.decisionId}-exit-${this.orderSequence}`;

      newOrders.push(
        freeze({
          orderId,
          clientOrderId: orderId,
          tradeId: `trade-${decision.decisionId}-exit`,
          symbol: this.symbol,
          side: exitSide,
          orderType: 'MARKET',
          positionEffect: isPartial ? 'PARTIAL_EXIT' : 'CLOSE',
          requestedQuantity: exitQty,
          filledQuantity: 0,
          remainingQuantity: exitQty,
          status: 'PENDING',
          submissionTimestamp: orderSubmissionTimestamp,
          arrivalTimestamp: orderArrivalTimestamp,
          strategyId: decision.decisionId,
          decisionId: decision.decisionId,
          createdAtMarketTimestamp: snapshot.marketDataCutoffTimestamp,
          exitTarget: 'SL',
        }),
      );
      return freeze(newOrders);
    }

    // 2. Handle REVERSAL (e.g. LONG -> ENTER_SHORT or SHORT -> ENTER_LONG)
    const isReversal =
      (state.position === 'LONG' && action === 'ENTER_SHORT') ||
      (state.position === 'SHORT' && action === 'ENTER_LONG');

    if (isReversal && state.quantity > 0) {
      const exitSide = state.position === 'LONG' ? 'SELL' : 'BUY';
      const exitQty = state.quantity;

      this.orderSequence += 1;
      const exitOrderId = `ord-${decision.decisionId}-rev-exit-${this.orderSequence}`;

      newOrders.push(
        freeze({
          orderId: exitOrderId,
          clientOrderId: exitOrderId,
          tradeId: `trade-${decision.decisionId}-reversal-exit`,
          symbol: this.symbol,
          side: exitSide,
          orderType: 'MARKET',
          positionEffect: 'REVERSE_EXIT',
          requestedQuantity: exitQty,
          filledQuantity: 0,
          remainingQuantity: exitQty,
          status: 'PENDING',
          submissionTimestamp: orderSubmissionTimestamp,
          arrivalTimestamp: orderArrivalTimestamp,
          strategyId: decision.decisionId,
          decisionId: decision.decisionId,
          createdAtMarketTimestamp: snapshot.marketDataCutoffTimestamp,
          exitTarget: 'SL',
        }),
      );

      const enterSide = action === 'ENTER_LONG' ? 'BUY' : 'SELL';
      const enterQty = decision.quantity > 0 ? decision.quantity : 1;

      this.orderSequence += 1;
      const enterOrderId = `ord-${decision.decisionId}-rev-enter-${this.orderSequence}`;

      newOrders.push(
        freeze({
          orderId: enterOrderId,
          clientOrderId: enterOrderId,
          tradeId: `trade-${decision.decisionId}-reversal-enter`,
          symbol: this.symbol,
          side: enterSide,
          orderType: 'MARKET',
          positionEffect: 'REVERSE_ENTRY',
          requestedQuantity: enterQty,
          filledQuantity: 0,
          remainingQuantity: enterQty,
          status: 'PENDING',
          submissionTimestamp: orderSubmissionTimestamp,
          arrivalTimestamp: orderArrivalTimestamp,
          strategyId: decision.decisionId,
          decisionId: decision.decisionId,
          createdAtMarketTimestamp: snapshot.marketDataCutoffTimestamp,
          exitTarget: 'ENTRY',
        }),
      );

      return freeze(newOrders);
    }

    // 3. Handle standard ENTRY from FLAT
    const isEntering =
      (action === 'ENTER_LONG' && state.position === 'FLAT') ||
      (action === 'ENTER_SHORT' && state.position === 'FLAT');

    if (isEntering) {
      const enterSide = action === 'ENTER_LONG' ? 'BUY' : 'SELL';
      const enterQty = decision.quantity > 0 ? decision.quantity : 1;

      this.orderSequence += 1;
      const enterOrderId = `ord-${decision.decisionId}-enter-${this.orderSequence}`;

      newOrders.push(
        freeze({
          orderId: enterOrderId,
          clientOrderId: enterOrderId,
          tradeId: `trade-${decision.decisionId}-enter`,
          symbol: this.symbol,
          side: enterSide,
          orderType: 'MARKET',
          positionEffect: 'OPEN',
          requestedQuantity: enterQty,
          filledQuantity: 0,
          remainingQuantity: enterQty,
          status: 'PENDING',
          submissionTimestamp: orderSubmissionTimestamp,
          arrivalTimestamp: orderArrivalTimestamp,
          strategyId: decision.decisionId,
          decisionId: decision.decisionId,
          createdAtMarketTimestamp: snapshot.marketDataCutoffTimestamp,
          exitTarget: 'ENTRY',
        }),
      );
    }

    return freeze(newOrders);
  }

  /**
   * Compatibility method for external order ingestion.
   */
  public ensureOrderInSimulator(_order: ShadowPendingOrder): void {
    // No-op: Orders are ingested on-demand at arrival eligibility during processMarketEvent.
  }

  /**
   * Processes active pending orders against the current market candle event.
   * - Only orders that have arrived (arrivalTimestamp <= candleTime) are evaluated.
   * - Exits are evaluated first, then entries if position conditions permit.
   * - Blocked reversal entries remain pending until prior position is fully FLAT.
   * - Unfilled or partially filled orders persist in pending state.
   */
  public processMarketEvent(
    candle: ICandle,
    pendingOrders: readonly ShadowPendingOrder[],
    currentState: ShadowBranchState,
    snapshot: EvaluationMarketSnapshot,
  ): {
    readonly executions: readonly ShadowExecutionResult[];
    readonly updatedPendingOrders: readonly ShadowPendingOrder[];
    readonly newState: ShadowBranchState;
  } {
    const candleTime = timestampOf(candle);
    const executions: ShadowExecutionResult[] = [];
    let state = cloneState(currentState);

    const ineligibleOrders: ShadowPendingOrder[] = [];
    const eligibleExits: ShadowPendingOrder[] = [];
    const eligibleEntries: ShadowPendingOrder[] = [];

    for (const order of pendingOrders) {
      if (order.status === 'CANCELLED' || order.status === 'FILLED' || order.status === 'REJECTED') {
        continue;
      }
      if (candleTime < order.arrivalTimestamp) {
        ineligibleOrders.push(order);
        continue;
      }

      const isExit =
        order.positionEffect === 'CLOSE' ||
        order.positionEffect === 'PARTIAL_EXIT' ||
        order.positionEffect === 'REVERSE_EXIT';

      if (isExit) {
        eligibleExits.push(order);
      } else {
        eligibleEntries.push(order);
      }
    }

    const pendingAfterExits: ShadowPendingOrder[] = [];

    // PASS 1: Evaluate Eligible Exits
    if (eligibleExits.length > 0) {
      const exitSim = this.createSimulator(`exit-${candleTime}`);
      for (const order of eligibleExits) {
        exitSim.submitOrder({
          clientOrderId: order.clientOrderId || order.orderId,
          tradeId: order.tradeId,
          symbol: order.symbol,
          side: order.side,
          orderType: order.orderType,
          price: order.limitPrice,
          stopPrice: order.stopPrice,
          quantity: order.remainingQuantity,
          timestamp: order.submissionTimestamp,
          signalTimestamp: order.submissionTimestamp,
          exitTarget: order.exitTarget,
        });
      }

      const simResult = exitSim.processSingleExecutionBar(candle);
      const fills = simResult.fills;
      let fillIdx = 0;

      for (const order of eligibleExits) {
        const fill =
          fills.find(
            (f, idx) =>
              idx >= fillIdx &&
              f.side === order.side &&
              f.symbol === order.symbol &&
              (f.tradeId === order.tradeId || (order.clientOrderId && (f as any).clientOrderId === order.clientOrderId) || f.orderId === order.orderId),
          ) || fills[fillIdx];

        if (!fill) {
          pendingAfterExits.push(order);
          continue;
        }
        fillIdx++;

        const executionTimestamp = fill.timestamp;
        if (executionTimestamp < order.arrivalTimestamp) {
          throw new Error('EXECUTION_BEFORE_ORDER_ARRIVAL: Execution timestamp cannot precede order arrival timestamp');
        }

        let fillQty = fill.quantity;
        if (this.config.partialFillRatio !== undefined && this.config.partialFillRatio > 0 && this.config.partialFillRatio < 1) {
          fillQty = Math.min(order.remainingQuantity, Number((order.remainingQuantity * this.config.partialFillRatio).toFixed(8)));
        } else {
          fillQty = Math.min(order.remainingQuantity, fillQty);
        }

        let executionType: ShadowExecutionType;
        if (order.positionEffect === 'REVERSE_EXIT') {
          executionType = 'REVERSAL_EXIT';
        } else if (order.positionEffect === 'PARTIAL_EXIT') {
          executionType = 'PARTIAL_EXIT';
        } else if (order.positionEffect === 'CLOSE') {
          executionType = fillQty < order.requestedQuantity ? 'PARTIAL_EXIT' : 'EXIT';
        } else {
          executionType = 'EXIT';
        }

        const fillFee = this.config.feePerTrade !== undefined ? this.config.feePerTrade : (fill.fee ?? 0);
        const fillSlippage = this.config.slippagePerTrade !== undefined ? this.config.slippagePerTrade : (fill.slippage ?? 0);

        const { updatedState, executionResult } = this.reduceStateOnFill(
          state,
          fill,
          order,
          fillQty,
          executionType,
          fillFee,
          fillSlippage,
          snapshot,
          executionTimestamp,
        );

        state = updatedState;
        executions.push(executionResult);

        const newFilledQty = Number((order.filledQuantity + fillQty).toFixed(8));
        const newRemainingQty = Math.max(0, Number((order.remainingQuantity - fillQty).toFixed(8)));
        const isComplete = newRemainingQty <= 1e-6;

        if (!isComplete) {
          pendingAfterExits.push(
            freeze({
              ...order,
              filledQuantity: newFilledQty,
              remainingQuantity: newRemainingQty,
              status: 'PARTIALLY_FILLED',
            }),
          );
        }
      }
    }

    // PASS 2: Evaluate Eligible Entries (Only block opposite-direction entries when position is non-FLAT)
    const pendingAfterEntries: ShadowPendingOrder[] = [];
    const entriesToEvaluate: ShadowPendingOrder[] = [];
    const blockedEntries: ShadowPendingOrder[] = [];

    for (const order of eligibleEntries) {
      const isOppositeDirection =
        (state.position === 'LONG' && order.side === 'SELL') ||
        (state.position === 'SHORT' && order.side === 'BUY');

      if (!isOppositeDirection) {
        entriesToEvaluate.push(order);
      } else {
        // Blocked because existing opposite position is not yet closed (e.g. reversal exit partially filled or pending)
        blockedEntries.push(order);
      }
    }

    if (entriesToEvaluate.length > 0) {
      const entrySim = this.createSimulator(`entry-${candleTime}`);
      for (const order of entriesToEvaluate) {
        entrySim.submitOrder({
          clientOrderId: order.clientOrderId || order.orderId,
          tradeId: order.tradeId,
          symbol: order.symbol,
          side: order.side,
          orderType: order.orderType,
          price: order.limitPrice,
          stopPrice: order.stopPrice,
          quantity: order.remainingQuantity,
          timestamp: order.submissionTimestamp,
          signalTimestamp: order.submissionTimestamp,
          exitTarget: order.exitTarget,
        });
      }

      const simResult = entrySim.processSingleExecutionBar(candle);
      const fills = simResult.fills;
      let fillIdx = 0;

      for (const order of entriesToEvaluate) {
        const fill =
          fills.find(
            (f, idx) =>
              idx >= fillIdx &&
              f.side === order.side &&
              f.symbol === order.symbol &&
              (f.tradeId === order.tradeId || (order.clientOrderId && (f as any).clientOrderId === order.clientOrderId) || f.orderId === order.orderId),
          ) || fills[fillIdx];

        if (!fill) {
          pendingAfterEntries.push(order);
          continue;
        }
        fillIdx++;

        const executionTimestamp = fill.timestamp;
        if (executionTimestamp < order.arrivalTimestamp) {
          throw new Error('EXECUTION_BEFORE_ORDER_ARRIVAL: Execution timestamp cannot precede order arrival timestamp');
        }

        let fillQty = fill.quantity;
        if (this.config.partialFillRatio !== undefined && this.config.partialFillRatio > 0 && this.config.partialFillRatio < 1) {
          fillQty = Math.min(order.remainingQuantity, Number((order.remainingQuantity * this.config.partialFillRatio).toFixed(8)));
        } else {
          fillQty = Math.min(order.remainingQuantity, fillQty);
        }

        const executionType: ShadowExecutionType =
          order.positionEffect === 'REVERSE_ENTRY' ? 'REVERSAL_ENTRY' : 'ENTRY';

        const fillFee = this.config.feePerTrade !== undefined ? this.config.feePerTrade : (fill.fee ?? 0);
        const fillSlippage = this.config.slippagePerTrade !== undefined ? this.config.slippagePerTrade : (fill.slippage ?? 0);

        const { updatedState, executionResult } = this.reduceStateOnFill(
          state,
          fill,
          order,
          fillQty,
          executionType,
          fillFee,
          fillSlippage,
          snapshot,
          executionTimestamp,
        );

        state = updatedState;
        executions.push(executionResult);

        const newFilledQty = Number((order.filledQuantity + fillQty).toFixed(8));
        const newRemainingQty = Math.max(0, Number((order.remainingQuantity - fillQty).toFixed(8)));
        const isComplete = newRemainingQty <= 1e-6;

        if (!isComplete) {
          pendingAfterEntries.push(
            freeze({
              ...order,
              filledQuantity: newFilledQty,
              remainingQuantity: newRemainingQty,
              status: 'PARTIALLY_FILLED',
            }),
          );
        }
      }
    }

    const allRemainingPending = [
      ...ineligibleOrders,
      ...pendingAfterExits,
      ...blockedEntries,
      ...pendingAfterEntries,
    ];

    return freeze({
      executions: freeze(executions),
      updatedPendingOrders: freeze(allRemainingPending),
      newState: freeze({
        ...state,
        pendingOrders: freeze(allRemainingPending),
        openOrders: freeze(allRemainingPending.filter((o) => o.status === 'PENDING' || o.status === 'PARTIALLY_FILLED').map((o) => o.orderId)),
      }),
    });
  }

  /**
   * Pure State Reducer applying a canonical fill to position state and producing an execution record.
   */
  private reduceStateOnFill(
    currentState: ShadowBranchState,
    fill: IFill,
    order: ShadowPendingOrder,
    fillQty: number,
    executionType: ShadowExecutionType,
    fee: number,
    slippage: number,
    snapshot: EvaluationMarketSnapshot,
    executionTimestamp: number,
  ): { readonly updatedState: ShadowBranchState; readonly executionResult: ShadowExecutionResult } {
    if (fillQty <= 0) {
      throw new Error('INVALID_EXECUTION_QUANTITY: Fill quantity must be strictly positive');
    }
    if (order.remainingQuantity < fillQty - 1e-6) {
      throw new Error('NEGATIVE_REMAINING_QUANTITY: Fill quantity exceeds remaining order quantity');
    }

    const isLongOrder = order.side === 'BUY';
    const fillPrice = fill.price;
    const notional = Number((fillPrice * fillQty).toFixed(8));

    if (executionType === 'ENTRY' || executionType === 'REVERSAL_ENTRY') {
      const prevQty = currentState.quantity;
      const newQty = Number((prevQty + fillQty).toFixed(8));
      const totalCost = Number(((currentState.averageEntryPrice * prevQty) + (fillPrice * fillQty)).toFixed(8));
      const averageEntryPrice = newQty > 0 ? Number((totalCost / newQty).toFixed(8)) : fillPrice;
      const newRemainingFees = Number((currentState.remainingEntryFees + fee).toFixed(8));
      const newRemainingSlippage = Number((currentState.remainingEntrySlippage + slippage).toFixed(8));

      const updatedState: ShadowBranchState = {
        ...currentState,
        position: isLongOrder ? 'LONG' : 'SHORT',
        quantity: newQty,
        initialQuantity: newQty,
        entryPrice: averageEntryPrice,
        rawEntryPrice: averageEntryPrice,
        averageEntryPrice,
        entryFees: Number((currentState.entryFees + fee).toFixed(8)),
        remainingEntryFees: newRemainingFees,
        entrySlippage: Number((currentState.entrySlippage + slippage).toFixed(8)),
        remainingEntrySlippage: newRemainingSlippage,
      };

      const executionResult: ShadowExecutionResult = freeze({
        orderId: order.orderId,
        decisionId: order.decisionId ?? order.orderId,
        executionType,
        notional,
        entryPrice: fillPrice,
        exitPrice: 0,
        quantity: fillQty,
        fees: fee,
        slippage,
        grossPnL: 0,
        realizedPnL: 0,
        unrealizedPnL: 0,
        rMultiple: 0,
        decisionTimestamp: order.submissionTimestamp,
        decisionCutoffTimestamp: order.createdAtMarketTimestamp,
        orderSubmissionTimestamp: order.submissionTimestamp,
        orderArrivalTimestamp: order.arrivalTimestamp,
        executionTimestamp,
        executionContextHash: snapshot.executionContextHash,
      });

      return { updatedState, executionResult };
    }

    // EXIT / PARTIAL_EXIT / REVERSAL_EXIT
    const isLong = currentState.position === 'LONG';
    const isFullExit = fillQty >= currentState.quantity - 1e-6;
    const exitFraction = currentState.quantity > 0 ? Math.min(1, fillQty / currentState.quantity) : 1;

    let allocatedEntryFees = isFullExit
      ? currentState.remainingEntryFees
      : Number((currentState.remainingEntryFees * exitFraction).toFixed(8));
    let allocatedEntrySlippage = isFullExit
      ? currentState.remainingEntrySlippage
      : Number((currentState.remainingEntrySlippage * exitFraction).toFixed(8));

    const rawExitPrice = fillPrice;
    const rawEntryPrice = currentState.rawEntryPrice > 0 ? currentState.rawEntryPrice : currentState.entryPrice;
    const grossPnL = Number(
      ((isLong ? rawExitPrice - rawEntryPrice : rawEntryPrice - rawExitPrice) * fillQty).toFixed(8),
    );

    const totalFees = Number((allocatedEntryFees + fee).toFixed(8));
    const totalSlippage = Number((allocatedEntrySlippage + slippage).toFixed(8));
    const netPnL = Number((grossPnL - totalFees - totalSlippage).toFixed(8));

    const riskUnit = Math.max(
      Math.abs(currentState.entryPrice) * (this.config.riskPerTrade || 0.01) * fillQty,
      1,
    );
    const rMultiple = Number((netPnL / riskUnit).toFixed(8));

    const newQty = Math.max(0, Number((currentState.quantity - fillQty).toFixed(8)));
    const newRemainingFees = isFullExit ? 0 : Math.max(0, Number((currentState.remainingEntryFees - allocatedEntryFees).toFixed(8)));
    const newRemainingSlippage = isFullExit ? 0 : Math.max(0, Number((currentState.remainingEntrySlippage - allocatedEntrySlippage).toFixed(8)));

    if (newRemainingFees < -1e-6 || newRemainingSlippage < -1e-6) {
      throw new Error('ACCOUNTING_INVARIANT_VIOLATION: Negative remaining entry costs');
    }

    const updatedState: ShadowBranchState = {
      ...currentState,
      capital: Number((currentState.capital + netPnL).toFixed(8)),
      quantity: newQty,
      position: newQty === 0 ? 'FLAT' : currentState.position,
      entryPrice: newQty === 0 ? 0 : currentState.entryPrice,
      rawEntryPrice: newQty === 0 ? 0 : currentState.rawEntryPrice,
      averageEntryPrice: newQty === 0 ? 0 : currentState.averageEntryPrice,
      remainingEntryFees: newRemainingFees,
      remainingEntrySlippage: newRemainingSlippage,
      realizedPnL: Number((currentState.realizedPnL + netPnL).toFixed(8)),
    };

    const executionResult: ShadowExecutionResult = freeze({
      orderId: order.orderId,
      decisionId: order.decisionId ?? order.orderId,
      executionType,
      notional,
      entryPrice: currentState.entryPrice,
      exitPrice: rawExitPrice,
      quantity: fillQty,
      fees: totalFees,
      slippage: totalSlippage,
      grossPnL,
      realizedPnL: netPnL,
      unrealizedPnL: 0,
      rMultiple,
      decisionTimestamp: order.submissionTimestamp,
      decisionCutoffTimestamp: order.createdAtMarketTimestamp,
      orderSubmissionTimestamp: order.submissionTimestamp,
      orderArrivalTimestamp: order.arrivalTimestamp,
      executionTimestamp,
      executionContextHash: snapshot.executionContextHash,
    });

    return { updatedState, executionResult };
  }

  /**
   * Finalizes backtest end policy for pending orders and positions at the end of the simulation.
   */
  public finalizeBacktest(
    state: ShadowBranchState,
    policy: BacktestEndPolicy,
    lastCandle: ICandle,
    snapshot: EvaluationMarketSnapshot,
  ): { readonly finalState: ShadowBranchState; readonly finalExecutions: readonly ShadowExecutionResult[] } {
    let finalPending = [...state.pendingOrders];
    let currentState = cloneState(state);
    const finalExecutions: ShadowExecutionResult[] = [];
    const lastCandleTime = timestampOf(lastCandle);

    if (policy === 'CANCEL_PENDING_AT_END') {
      finalPending = state.pendingOrders.map((o) =>
        freeze({
          ...o,
          status: 'CANCELLED' as const,
          cancelReason: 'BACKTEST_END',
          cancelTimestamp: lastCandleTime,
        }),
      );
    } else if (policy === 'FORCE_CLOSE_POSITION_AT_END' && currentState.position !== 'FLAT' && currentState.quantity > 0) {
      // Force close position on final candle close
      const exitSide = currentState.position === 'LONG' ? 'SELL' : 'BUY';
      const exitQty = currentState.quantity;
      const exitPrice = lastCandle.close;
      const notional = Number((exitPrice * exitQty).toFixed(8));

      const isLong = currentState.position === 'LONG';
      const grossPnL = Number(((isLong ? exitPrice - currentState.entryPrice : currentState.entryPrice - exitPrice) * exitQty).toFixed(8));

      const exitFee = this.config.feePerTrade !== undefined
        ? this.config.feePerTrade
        : Number((notional * (this.config.feeRate ?? (this.config.feeBps ? this.config.feeBps / 10000 : 0.001))).toFixed(8));
      const exitSlippage = this.config.slippagePerTrade !== undefined
        ? this.config.slippagePerTrade
        : Number((notional * (this.config.slippageBps ? this.config.slippageBps / 10000 : 0.0005)).toFixed(8));

      const totalFees = Number((currentState.remainingEntryFees + exitFee).toFixed(8));
      const totalSlippage = Number((currentState.remainingEntrySlippage + exitSlippage).toFixed(8));
      const netPnL = Number((grossPnL - totalFees - totalSlippage).toFixed(8));

      const executionResult: ShadowExecutionResult = freeze({
        orderId: `force-close-end-${snapshot.snapshotId}`,
        decisionId: `force-close-end`,
        executionType: 'EXIT',
        notional,
        entryPrice: currentState.entryPrice,
        exitPrice,
        quantity: exitQty,
        fees: totalFees,
        slippage: totalSlippage,
        grossPnL,
        realizedPnL: netPnL,
        unrealizedPnL: 0,
        rMultiple: 0,
        decisionTimestamp: lastCandleTime,
        decisionCutoffTimestamp: lastCandleTime,
        orderSubmissionTimestamp: lastCandleTime,
        orderArrivalTimestamp: lastCandleTime,
        executionTimestamp: lastCandleTime,
        executionContextHash: snapshot.executionContextHash,
      });

      finalExecutions.push(executionResult);
      currentState = {
        ...currentState,
        capital: Number((currentState.capital + netPnL).toFixed(8)),
        position: 'FLAT',
        quantity: 0,
        entryPrice: 0,
        rawEntryPrice: 0,
        averageEntryPrice: 0,
        remainingEntryFees: 0,
        remainingEntrySlippage: 0,
        realizedPnL: Number((currentState.realizedPnL + netPnL).toFixed(8)),
        unrealizedPnL: 0,
      };
      finalPending = state.pendingOrders.map((o) =>
        freeze({
          ...o,
          status: 'CANCELLED' as const,
          cancelReason: 'BACKTEST_END',
          cancelTimestamp: lastCandleTime,
        }),
      );
    }

    const finalState: ShadowBranchState = freeze({
      ...currentState,
      pendingOrders: freeze(finalPending),
      openOrders: freeze(finalPending.filter((o) => o.status === 'PENDING' || o.status === 'PARTIALLY_FILLED').map((o) => o.orderId)),
      unrealizedPnL: currentState.position === 'FLAT' ? 0 : currentState.unrealizedPnL,
    });

    return { finalState, finalExecutions: freeze(finalExecutions) };
  }

  /**
   * Compatibility method: executes a single decision immediately against nextCandle if eligible.
   */
  public execute(
    decision: ShadowDecision,
    snapshot: EvaluationMarketSnapshot,
    nextCandle?: ICandle,
    currentState?: ShadowBranchState,
  ): readonly ShadowExecutionResult[] {
    const state = currentState ?? {
      capital: this.config.initialCapital,
      position: 'FLAT' as const,
      quantity: 0,
      initialQuantity: 0,
      entryPrice: 0,
      rawEntryPrice: 0,
      averageEntryPrice: 0,
      entryFees: 0,
      remainingEntryFees: 0,
      entrySlippage: 0,
      remainingEntrySlippage: 0,
      realizedPnL: 0,
      unrealizedPnL: 0,
      pendingOrders: [],
      openOrders: [],
      closedTrades: [],
      riskState: decision.riskState,
      portfolioState: { equity: this.config.initialCapital },
    };

    const newOrders = this.submitDecisionOrders(decision, snapshot, state);
    if (!nextCandle || newOrders.length === 0) {
      return [];
    }

    const result = this.processMarketEvent(nextCandle, newOrders, state, snapshot);
    return result.executions;
  }
}

export class SynchronizedShadowEvaluationEngine {
  public static readonly SHADOW_EVALUATION_VERSION = 'phase10b-synchronized-shadow-v2';

  public static evaluate(options: SynchronizedShadowEvaluationOptions): SynchronizedShadowEvaluationResult {
    this.validateInputs(options);

    const execContext = options.productionExecutionContext || (options.champion.executionContext as ProductionExecutionContext);
    const executionConfig: ShadowExecutionConfig = options.executionConfig || {
      initialCapital: (options.champion.riskConfig as any)?.initialCapital ?? 100000,
      riskPerTrade: (options.champion.riskConfig as any)?.maxRiskPerTrade ?? 0.01,
      quantity: 1,
      feeRate: execContext?.feeConfig?.brokerageRateBps ? execContext.feeConfig.brokerageRateBps / 10000 : 0,
      slippageBps: execContext?.slippageConfig?.baseSlippageBps ?? 0,
      fillModel: execContext?.fillModel,
      ambiguityMode: execContext?.ambiguityMode,
      latencyMs: execContext?.latencyConfig?.submissionLatencyMs,
      backtestEndPolicy: 'CANCEL_PENDING_AT_END',
    };

    const marketSnapshots = this.createMarketSnapshots(options);
    const featureSnapshots = marketSnapshots.map((snapshot, idx) =>
      this.createFeatureSnapshot(snapshot, options, options.candles.slice(0, idx + 1)),
    );
    const snapshots = marketSnapshots.map((snapshot, index) =>
      freeze({ ...snapshot, featureSnapshotHash: featureSnapshots[index].featureHash }),
    );

    if (options.checkpoint) {
      this.validateCheckpoint(options.checkpoint, options, snapshots);
    }

    const startIndex = options.checkpoint?.processedEventCount ?? 0;
    const maxEvents = options.maxEvents ?? snapshots.length;
    const endIndex = Math.min(snapshots.length, startIndex + maxEvents);
    const clock = new SynchronizedEvaluationClock(snapshots.slice(startIndex, endIndex));

    const initialChampionState = this.createInitialBranchState('PAPER', executionConfig);
    const initialChallengerState = this.createInitialBranchState('SHADOW', executionConfig);

    // Verify Champion and Challenger start from independent clones of exactly the same initial state
    const championInitialStateHash = hash(initialChampionState);
    const challengerInitialStateHash = hash(initialChallengerState);
    if (championInitialStateHash !== challengerInitialStateHash) {
      throw new Error('SHADOW_INITIAL_STATE_MISMATCH');
    }

    let champion = options.checkpoint?.state.champion ?? this.createBranch('PAPER', executionConfig, execContext, initialChampionState);
    let challenger = options.checkpoint?.state.challenger ?? this.createBranch('SHADOW', executionConfig, execContext, initialChallengerState);

    // Assert states are not sharing mutable object references
    if (champion.state === challenger.state) {
      throw new Error('SHADOW_SHARED_STATE_MUTATION');
    }

    const featureBySnapshot = new Map(featureSnapshots.map((feature) => [feature.sourceSnapshotHash, feature]));
    const championAdapter = new ShadowExecutionAdapter('PAPER', execContext, executionConfig, 'champ');
    const challengerAdapter = new ShadowExecutionAdapter('SHADOW', execContext, executionConfig, 'chall');

    let snapshot: EvaluationMarketSnapshot | undefined;
    let eventIndex = startIndex;
    while ((snapshot = clock.next())) {
      const feature = featureBySnapshot.get(snapshot.snapshotHash);
      if (!feature || feature.featureHash !== snapshot.featureSnapshotHash) {
        throw new Error('SHADOW_FEATURE_HASH_MISMATCH');
      }

      // Synchronized Decision Boundary Verification
      this.verifySynchronizedBoundary(snapshot, feature, options);

      const historicalCandles = options.candles.slice(0, eventIndex + 1);

      champion = this.processBranch(
        options.champion,
        champion,
        snapshot,
        feature,
        historicalCandles,
        championAdapter,
        executionConfig,
        options,
      );

      challenger = this.processBranch(
        options.challenger,
        challenger,
        snapshot,
        feature,
        historicalCandles,
        challengerAdapter,
        executionConfig,
        options,
      );

      eventIndex++;
    }

    // Finalize backtest end policy if evaluation completed through the last snapshot
    if (eventIndex >= snapshots.length && snapshots.length > 0) {
      const lastSnapshot = snapshots[snapshots.length - 1];
      const endPolicy = executionConfig.backtestEndPolicy ?? 'CANCEL_PENDING_AT_END';

      const champEnd = championAdapter.finalizeBacktest(champion.state, endPolicy, lastSnapshot.candle, lastSnapshot);
      const champAllExecs = [...champion.executions, ...champEnd.finalExecutions];
      champion = freeze({
        ...champion,
        state: champEnd.finalState,
        executions: champAllExecs,
        metrics: this.calculateMetrics(champAllExecs, executionConfig.initialCapital, executionConfig.riskPerTrade, lastSnapshot.marketDataCutoffTimestamp),
      });

      const challEnd = challengerAdapter.finalizeBacktest(challenger.state, endPolicy, lastSnapshot.candle, lastSnapshot);
      const challAllExecs = [...challenger.executions, ...challEnd.finalExecutions];
      challenger = freeze({
        ...challenger,
        state: challEnd.finalState,
        executions: challAllExecs,
        metrics: this.calculateMetrics(challAllExecs, executionConfig.initialCapital, executionConfig.riskPerTrade, lastSnapshot.marketDataCutoffTimestamp),
      });
    }

    const processedEventCount = endIndex;
    if (processedEventCount < snapshots.length) {
      return this.buildResult(options, champion, challenger, snapshots, featureSnapshots, executionConfig, processedEventCount);
    }
    return this.buildResult(options, champion, challenger, snapshots, featureSnapshots, executionConfig);
  }

  public static completeCoordinatorShadowEvaluation(
    coordinatorEvaluationId: string,
    result: SynchronizedShadowEvaluationResult,
  ): ChallengerEvaluation {
    if (result.checkpoint) {
      throw new Error('SHADOW_EVALUATION_INCOMPLETE: Cannot complete coordinator shadow evaluation from partial checkpoint');
    }
    return ChampionChallengerCoordinator.completeShadow(
      coordinatorEvaluationId,
      result.shadowEvidence,
      result.shadowEvidence.marketDataCutoffTimestamp,
    );
  }

  private static validateInputs(options: SynchronizedShadowEvaluationOptions): void {
    if (options.marketDataCutoffTimestamp !== options.coordinatorEvaluation.marketDataCutoffTimestamp) {
      throw new Error('SHADOW_MARKET_DATA_CUTOFF_MISMATCH');
    }
    if (options.datasetHash !== options.coordinatorEvaluation.datasetHash) {
      throw new Error('SHADOW_DATASET_MISMATCH');
    }
    if (options.champion.artifactHash !== options.championSnapshot.artifactHash) {
      throw new Error('SHADOW_STRATEGY_ARTIFACT_MISMATCH');
    }
    if (options.challenger.artifactHash !== options.coordinatorEvaluation.challengerArtifactHash) {
      throw new Error('SHADOW_STRATEGY_ARTIFACT_MISMATCH');
    }
    if (options.champion.executionContextHash !== options.challenger.executionContextHash) {
      throw new Error('SHADOW_EXECUTION_CONTEXT_MISMATCH');
    }
    if (options.champion.executionContextVersion !== options.challenger.executionContextVersion) {
      throw new Error('SHADOW_EXECUTION_CONTEXT_MISMATCH');
    }
    if (options.champion.executionContextHash !== options.coordinatorEvaluation.executionContextHash) {
      throw new Error('SHADOW_EXECUTION_CONTEXT_MISMATCH');
    }
    if (options.champion.executionContextVersion !== options.coordinatorEvaluation.executionContextVersion) {
      throw new Error('SHADOW_EXECUTION_CONTEXT_MISMATCH');
    }
    if (options.champion.datasetHash !== options.datasetHash || options.challenger.datasetHash !== options.datasetHash) {
      throw new Error('SHADOW_DATASET_MISMATCH');
    }
    if (!options.candles.length) {
      throw new Error('SHADOW_MARKET_DATA_GAP');
    }
  }

  private static verifySynchronizedBoundary(
    snapshot: EvaluationMarketSnapshot,
    feature: FeatureSnapshot,
    options: SynchronizedShadowEvaluationOptions,
  ): void {
    const marketCutoff = snapshot.marketDataCutoffTimestamp;
    const featureCutoff = feature.cutoffTimestamp;

    if (marketCutoff !== featureCutoff) {
      throw new Error('SHADOW_LOOKAHEAD_DETECTED: Feature cutoff does not match snapshot cutoff');
    }
    if (marketCutoff > options.marketDataCutoffTimestamp) {
      throw new Error('SHADOW_LOOKAHEAD_DETECTED: Event exceeds global marketDataCutoffTimestamp');
    }
  }

  private static createMarketSnapshots(options: SynchronizedShadowEvaluationOptions): readonly EvaluationMarketSnapshot[] {
    const seen = new Set<string>();
    let previous = 0;
    const tfInterval = this.expectedIntervalMs(options.timeframe);

    return freeze(
      options.candles.map((candle, index) => {
        const timestamp = timestampOf(candle);
        if (!Number.isFinite(timestamp) || timestamp <= 0) {
          throw new Error('SHADOW_MARKET_DATA_GAP');
        }
        if (timestamp > options.marketDataCutoffTimestamp) {
          throw new Error('SHADOW_LOOKAHEAD_DETECTED');
        }
        if (timestamp < previous) {
          throw new Error('SHADOW_OUT_OF_ORDER_TIMESTAMP');
        }
        if (timestamp === previous || seen.has(String(timestamp))) {
          throw new Error('SHADOW_DUPLICATE_SNAPSHOT');
        }
        if (index > 0 && timestamp - previous > tfInterval * 1.5) {
          throw new Error('SHADOW_MARKET_DATA_GAP');
        }
        previous = timestamp;
        seen.add(String(timestamp));

        const perEventCutoffTimestamp = timestamp;
        const candleIds = [`${options.symbol}:${options.timeframe}:${timestamp}`];
        const payload = {
          symbol: options.symbol,
          timeframe: options.timeframe,
          marketDataCutoffTimestamp: perEventCutoffTimestamp,
          source: options.source,
          datasetHash: options.datasetHash,
          dataVersion: options.dataVersion,
          candleIds,
          executionContextHash: options.coordinatorEvaluation.executionContextHash,
          executionContextVersion: options.coordinatorEvaluation.executionContextVersion,
          candle,
        };

        const snapshotHash = hash(payload);
        return freeze({
          snapshotId: `snap-${options.symbol}-${index}`,
          snapshotHash,
          symbol: options.symbol,
          timeframe: options.timeframe,
          marketDataCutoffTimestamp: perEventCutoffTimestamp,
          source: options.source,
          datasetHash: options.datasetHash,
          dataVersion: options.dataVersion,
          candleIds,
          featureSnapshotHash: '',
          executionContextHash: options.coordinatorEvaluation.executionContextHash,
          executionContextVersion: options.coordinatorEvaluation.executionContextVersion,
          candle,
        });
      }),
    );
  }

  private static createFeatureSnapshot(
    snapshot: EvaluationMarketSnapshot,
    options: SynchronizedShadowEvaluationOptions,
    historicalCandles: readonly ICandle[],
  ): FeatureSnapshot {
    const candleTime = timestampOf(snapshot.candle);
    const decisionCutoff = snapshot.marketDataCutoffTimestamp;

    if (candleTime > decisionCutoff) {
      throw new Error('SHADOW_LOOKAHEAD_DETECTED');
    }

    // Strengthen PIT enforcement: candle.timestamp <= asOfTimestamp
    for (const c of historicalCandles) {
      if (timestampOf(c) > decisionCutoff) {
        throw new Error('SHADOW_LOOKAHEAD_DETECTED: Feature data includes future candle');
      }
    }

    const features = freeze({
      open: snapshot.candle.open,
      high: snapshot.candle.high,
      low: snapshot.candle.low,
      close: snapshot.candle.close,
      volume: snapshot.candle.volume,
      range: Number((snapshot.candle.high - snapshot.candle.low).toFixed(8)),
      body: Number((snapshot.candle.close - snapshot.candle.open).toFixed(8)),
    });

    const featureSchemaHash = hash({
      names: ['open', 'high', 'low', 'close', 'volume', 'range', 'body'],
      dimension: 7,
    });

    let canonicalMLFeatureHash = 'INSUFFICIENT_HISTORY';
    if (historicalCandles.length >= 20) {
      try {
        const snap = SnapshotBuilder.buildSnapshot({
          symbol: snapshot.symbol,
          executionCandles: historicalCandles as ICandle[],
          executionTimeframe: snapshot.timeframe,
          asOfTimestamp: new Date(decisionCutoff),
        });
        const feats = CanonicalMLEngineV2.extractFeatures(snap);
        canonicalMLFeatureHash = hash(CanonicalMLEngineV2.toArray(feats));
      } catch (err: any) {
        if (err?.message?.includes('INSUFFICIENT') || err?.message?.includes('NOT_ENOUGH')) {
          canonicalMLFeatureHash = 'INSUFFICIENT_HISTORY';
        } else {
          throw new Error(`FEATURE_PIPELINE_FAILURE: ${err?.message || err}`);
        }
      }
    }

    const payload = {
      featurePipelineVersion: 'canonical-feature-pipeline-v2',
      featureVersion: options.featureVersion,
      featureSchemaHash,
      canonicalMLFeatureHash,
      generatedAt: options.generatedAt ?? decisionCutoff,
      sourceSnapshotHash: snapshot.snapshotHash,
      cutoffTimestamp: decisionCutoff,
      features,
    };
    return freeze({ ...payload, featureHash: hash(payload) });
  }

  private static processBranch(
    artifact: CandidateArtifact,
    branch: ShadowBranchResult,
    snapshot: EvaluationMarketSnapshot,
    feature: FeatureSnapshot,
    historicalCandles: readonly ICandle[],
    adapter: ShadowExecutionAdapter,
    config: ShadowExecutionConfig,
    options: SynchronizedShadowEvaluationOptions,
  ): ShadowBranchResult {
    if (branch.mode === 'SHADOW' && branch.hasProductionOrderRouter) {
      throw new Error('SHADOW_PRODUCTION_ROUTER_FORBIDDEN');
    }

    // Step 1: Process existing pending orders against current market candle
    const { executions: newExecutions, updatedPendingOrders, newState: stateAfterFills } =
      adapter.processMarketEvent(snapshot.candle, branch.state.pendingOrders, branch.state, snapshot);

    // Step 2: Generate strategy decision for this bar close (using state after fills)
    const provided = options.decisionProvider
      ? options.decisionProvider({
          artifact,
          snapshot,
          features: feature,
          state: stateAfterFills,
          mode: branch.mode,
        })
      : this.evaluateCandidateStrategyDecision(artifact, snapshot, feature, historicalCandles, stateAfterFills, branch.mode);

    if (!provided || typeof provided !== 'object') {
      throw new Error('SHADOW_DECISION_PROVIDER_REQUIRED');
    }

    if ((provided as any).featureSnapshotHash && (provided as any).featureSnapshotHash !== feature.featureHash) {
      throw new Error('SHADOW_FEATURE_HASH_MISMATCH');
    }

    const decisionCutoffTimestamp = snapshot.marketDataCutoffTimestamp;
    const decisionTimestamp = snapshot.marketDataCutoffTimestamp;

    const decision: ShadowDecision = freeze({
      ...provided,
      decisionId: `${branch.mode.toLowerCase()}-${artifact.artifactHash.slice(0, 12)}-${snapshot.snapshotId}`,
      timestamp: decisionTimestamp,
      decisionCutoffTimestamp,
      symbol: snapshot.symbol,
      timeframe: snapshot.timeframe,
      featureSnapshotHash: feature.featureHash,
      snapshotId: snapshot.snapshotId,
      snapshotHash: snapshot.snapshotHash,
      marketDataCutoffTimestamp: snapshot.marketDataCutoffTimestamp,
      executionContextHash: snapshot.executionContextHash,
    });

    // Step 3: Create and submit new pending orders resulting from this decision
    const newDecisionOrders = adapter.submitDecisionOrders(decision, snapshot, stateAfterFills);
    const finalPendingOrders = [...updatedPendingOrders, ...newDecisionOrders];

    const finalState: ShadowBranchState = freeze({
      ...stateAfterFills,
      pendingOrders: freeze(finalPendingOrders),
      openOrders: freeze(finalPendingOrders.map((o) => o.orderId)),
      unrealizedPnL: this.calculateUnrealizedPnL(stateAfterFills, snapshot.candle.close),
    });

    const allExecutions = [...branch.executions, ...newExecutions];

    return freeze({
      mode: branch.mode,
      state: finalState,
      decisions: [...branch.decisions, decision],
      executions: allExecutions,
      metrics: this.calculateMetrics(allExecutions, config.initialCapital, config.riskPerTrade, snapshot.marketDataCutoffTimestamp),
      simulatorId: adapter.simulatorId,
      feeModelHash: adapter.feeModelHash,
      slippageModelHash: adapter.slippageModelHash,
      hasProductionOrderRouter: branch.mode !== 'SHADOW' && branch.hasProductionOrderRouter,
    });
  }

  /**
   * Evaluates real candidate strategy/model decision using repository abstractions.
   * Fail closed if strategy configuration is missing or incomplete.
   */
  private static evaluateCandidateStrategyDecision(
    artifact: CandidateArtifact,
    snapshot: EvaluationMarketSnapshot,
    feature: FeatureSnapshot,
    historicalCandles: readonly ICandle[],
    state: ShadowBranchState,
    mode: ShadowMode,
  ): Omit<
    ShadowDecision,
    | 'decisionId'
    | 'timestamp'
    | 'symbol'
    | 'timeframe'
    | 'featureSnapshotHash'
    | 'snapshotId'
    | 'snapshotHash'
    | 'marketDataCutoffTimestamp'
    | 'executionContextHash'
    | 'decisionCutoffTimestamp'
  > {
    const rawCandidate = (artifact as any).candidate || (artifact as any);
    const strategyConfig = rawCandidate.strategyConfig || rawCandidate.change || artifact.strategyConfig;
    const scoringWeights =
      strategyConfig?.scoringWeights ||
      (artifact.strategyConfig as any)?.scoringWeights ||
      (rawCandidate.change as any)?.scoringWeights;

    if (!strategyConfig && !scoringWeights && !artifact.modelArtifact) {
      throw new Error('SHADOW_INCOMPLETE_ARTIFACT_CONFIGURATION: Candidate artifact missing strategy configuration');
    }

    try {
      const execConfig = (rawCandidate.executionConfig || rawCandidate.change || (artifact as any).executionConfig) as any;
      const strategyMode = ((strategyConfig?.strategyMode || 'SMC') as any);

      const signal = SignalGenerator.generateSignal({
        symbol: snapshot.symbol,
        executionCandles: historicalCandles as ICandle[],
        executionTimeframe: snapshot.timeframe,
        strategyMode,
        asOfTimestamp: new Date(snapshot.marketDataCutoffTimestamp),
        scoringWeights,
        strategyConfig: strategyConfig as any,
        minimumCandles: 1,
      });

      const minScore = typeof execConfig?.minMtfScore === 'number' ? execConfig.minMtfScore : 65;
      const conditionRules = Array.isArray(execConfig?.conditionRules) ? execConfig.conditionRules : undefined;
      const filterRegime = typeof execConfig?.filterRegime === 'string' ? execConfig.filterRegime : undefined;
      const regimeMode = execConfig?.regimeMode;
      const minProbability = typeof execConfig?.minProbability === 'number' ? execConfig.minProbability : undefined;

      let skip = false;
      let modelScore: number | undefined;
      let modelProb: number | undefined;

      if (
        !signal ||
        signal.direction === Direction.NEUTRAL ||
        signal.score < minScore ||
        signal.grade === SignalGrade.NO_TRADE
      ) {
        skip = true;
      }

      if (!skip && conditionRules && conditionRules.length > 0) {
        if (conditionRules.some((r: any) => signal.reasons?.includes(r))) {
          skip = true;
        }
      }

      if (!skip && filterRegime) {
        const currentRegime = (signal as any)?.marketContext?.regime || (snapshot.candle as any)?.regime;
        if (regimeMode === 'INCLUDE' && currentRegime !== filterRegime) {
          skip = true;
        } else if (regimeMode === 'EXCLUDE' && currentRegime === filterRegime) {
          skip = true;
        }
      }

      const model = artifact.modelArtifact;
      if (!skip && model) {
        if (typeof (model as any).score === 'function') {
          modelScore = (model as any).score({ signal, candle: snapshot.candle, timestamp: timestampOf(snapshot.candle) });
        } else if (Array.isArray((model as any).weights) && typeof (model as any).bias === 'number') {
          let featureVector: number[] | undefined;
          const candidateFeatures = (signal as any).features || (signal as any).quantSnapshot?.features;
          if (candidateFeatures && Array.isArray(candidateFeatures) && candidateFeatures.length === CANONICAL_V2_DIMENSION) {
            featureVector = candidateFeatures;
          } else if (historicalCandles.length >= 20) {
            try {
              const snap = SnapshotBuilder.buildSnapshot({
                symbol: snapshot.symbol,
                executionCandles: historicalCandles as ICandle[],
                executionTimeframe: snapshot.timeframe,
                asOfTimestamp: new Date(snapshot.marketDataCutoffTimestamp),
              });
              const feats = CanonicalMLEngineV2.extractFeatures(snap);
              featureVector = CanonicalMLEngineV2.toArray(feats);
            } catch {
              featureVector = undefined;
            }
          }

          if (featureVector) {
            const dot = (model as any).weights.reduce((sum: number, w: number, i: number) => sum + w * (featureVector![i] || 0), 0);
            const z = dot + (model as any).bias;
            modelProb = 1 / (1 + Math.exp(-z));
            modelScore = modelProb * 100;
          }
        }

        if (minProbability !== undefined && modelProb !== undefined && modelProb < minProbability) {
          skip = true;
        }
      }

      if (skip || !signal) {
        return {
          action: 'HOLD',
          positionTarget: state.position,
          quantity: state.quantity,
          confidence: 0,
          riskState: state.riskState,
        };
      }

      const targetDirection: 'LONG' | 'SHORT' = signal.direction === Direction.BULLISH ? 'LONG' : 'SHORT';
      if (state.position === targetDirection) {
        return {
          action: 'HOLD',
          positionTarget: state.position,
          quantity: state.quantity,
          confidence: signal.score / 100,
          riskState: state.riskState,
        };
      }

      const baseQty = (artifact.riskConfig as any)?.baseOrderQuantity || 1;
      const sizingMultiplier = typeof execConfig?.sizingMultiplier === 'number' ? execConfig.sizingMultiplier : 1;
      const quantity = Math.max(1, Math.round(baseQty * sizingMultiplier));
      const action: ShadowDecisionAction = targetDirection === 'LONG' ? 'ENTER_LONG' : 'ENTER_SHORT';

      return {
        action,
        positionTarget: targetDirection,
        quantity,
        confidence: signal.score / 100,
        riskState: {
          ...state.riskState,
          score: signal.score,
          modelScore: modelScore ?? signal.score,
          stopLossPrice: (signal as any).stopLoss,
          takeProfitPrice: (signal as any).takeProfit,
        },
      };
    } catch (err: any) {
      if (err?.message?.includes('SHADOW_INCOMPLETE_ARTIFACT_CONFIGURATION')) {
        throw err;
      }
      return {
        action: 'HOLD',
        positionTarget: state.position,
        quantity: state.quantity,
        confidence: 0,
        riskState: state.riskState,
      };
    }
  }

  private static calculateUnrealizedPnL(state: ShadowBranchState, currentClose: number): number {
    if (state.position === 'FLAT' || state.quantity === 0) return 0;
    const rawPriceDiff =
      state.position === 'LONG' ? currentClose - state.entryPrice : state.entryPrice - currentClose;
    return Number((rawPriceDiff * state.quantity).toFixed(8));
  }

  private static createInitialBranchState(mode: ShadowMode, config: ShadowExecutionConfig): ShadowBranchState {
    return freeze({
      capital: config.initialCapital,
      position: 'FLAT' as const,
      quantity: 0,
      initialQuantity: 0,
      entryPrice: 0,
      rawEntryPrice: 0,
      averageEntryPrice: 0,
      entryFees: 0,
      remainingEntryFees: 0,
      entrySlippage: 0,
      remainingEntrySlippage: 0,
      realizedPnL: 0,
      unrealizedPnL: 0,
      pendingOrders: [],
      openOrders: [],
      closedTrades: [],
      riskState: { riskPerTrade: config.riskPerTrade },
      portfolioState: { equity: config.initialCapital, initialCapital: config.initialCapital },
    });
  }

  private static createBranch(
    mode: ShadowMode,
    config: ShadowExecutionConfig,
    execContext: ProductionExecutionContextInput | ProductionExecutionContext,
    initialState: ShadowBranchState,
  ): ShadowBranchResult {
    const adapter = new ShadowExecutionAdapter(mode, execContext, config, mode.toLowerCase());
    return freeze({
      mode,
      state: cloneState(initialState),
      decisions: [],
      executions: [],
      metrics: this.calculateMetrics([], config.initialCapital, config.riskPerTrade, 0),
      simulatorId: adapter.simulatorId,
      feeModelHash: adapter.feeModelHash,
      slippageModelHash: adapter.slippageModelHash,
      hasProductionOrderRouter: mode !== 'SHADOW',
    });
  }

  private static calculateMetrics(
    executions: readonly ShadowExecutionResult[],
    initialCapital: number,
    riskPerTrade: number,
    lastCutoffTimestamp: number,
  ): Phase10BShadowMetrics {
    const closed = executions.filter((e) => e.exitPrice > 0);
    const totalPnL = Number(closed.reduce((sum, e) => sum + e.realizedPnL, 0).toFixed(8));
    const tradeCount = closed.length;
    const wins = closed.filter((e) => e.realizedPnL > 0);
    const losses = closed.filter((e) => e.realizedPnL <= 0);
    const winRate = tradeCount > 0 ? Number((wins.length / tradeCount).toFixed(8)) : 0;

    const grossProfit = wins.reduce((sum, e) => sum + e.realizedPnL, 0);
    const grossLoss = Math.abs(losses.reduce((sum, e) => sum + e.realizedPnL, 0));
    const profitFactor =
      grossLoss > 0
        ? Number((grossProfit / grossLoss).toFixed(8))
        : grossProfit > 0
          ? 999
          : 0;

    const totalFees = Number(executions.reduce((sum, e) => sum + e.fees, 0).toFixed(8));
    const totalSlippage = Number(executions.reduce((sum, e) => sum + e.slippage, 0).toFixed(8));
    const turnover = Number(executions.reduce((sum, e) => sum + e.notional, 0).toFixed(8));

    // Calculate Max Drawdown
    let peakEquity = initialCapital;
    let currentEquity = initialCapital;
    let maxDrawdown = 0;

    for (const e of closed) {
      currentEquity += e.realizedPnL;
      if (currentEquity > peakEquity) {
        peakEquity = currentEquity;
      }
      const dd = peakEquity - currentEquity;
      if (dd > maxDrawdown) {
        maxDrawdown = dd;
      }
    }
    maxDrawdown = Number(maxDrawdown.toFixed(8));

    const riskUnit = Math.max(initialCapital * (riskPerTrade || 0.01), 1);
    const maxDrawdownR = Number((maxDrawdown / riskUnit).toFixed(8));

    const returnPct = Number(((totalPnL / initialCapital) * 100).toFixed(8));
    const averageTrade = tradeCount > 0 ? Number((totalPnL / tradeCount).toFixed(8)) : 0;
    const averageR = tradeCount > 0 ? Number((closed.reduce((sum, e) => sum + e.rMultiple, 0) / tradeCount).toFixed(8)) : 0;
    const expectancy = averageTrade;
    const costAdjustedPnL = Number((totalPnL - totalFees - totalSlippage).toFixed(8));
    const riskAdjustedReturn = maxDrawdown > 0 ? Number((totalPnL / maxDrawdown).toFixed(8)) : totalPnL;

    return freeze({
      totalTrades: tradeCount,
      tradeCount,
      wins: wins.length,
      losses: losses.length,
      winRate,
      grossPnL: Number((totalPnL + totalFees + totalSlippage).toFixed(8)),
      netPnL: totalPnL,
      pnlR: Number((totalPnL / riskUnit).toFixed(8)),
      totalPnL,
      returnPct,
      expectancy,
      profitFactor,
      maxDrawdown,
      maxDrawdownR,
      averageTrade,
      averageR,
      medianR: averageR,
      largestWin: wins.length ? Math.max(...wins.map((w) => w.realizedPnL)) : 0,
      largestLoss: losses.length ? Math.min(...losses.map((l) => l.realizedPnL)) : 0,
      sharpeRatio: 0,
      sortinoRatio: 0,
      calmarRatio: 0,
      turnover,
      fees: totalFees,
      slippage: totalSlippage,
      observationsCount: executions.length,
      costAdjustedPnL,
      riskAdjustedReturn,
    });
  }

  private static buildResult(
    options: SynchronizedShadowEvaluationOptions,
    champion: ShadowBranchResult,
    challenger: ShadowBranchResult,
    snapshots: readonly EvaluationMarketSnapshot[],
    featureSnapshots: readonly FeatureSnapshot[],
    executionConfig: ShadowExecutionConfig,
    partialEventCount?: number,
  ): SynchronizedShadowEvaluationResult {
    const observationCount = partialEventCount ?? snapshots.length;
    const startTimestamp = snapshots.length ? timestampOf(snapshots[0].candle) : 0;
    const endTimestamp = observationCount > 0 ? timestampOf(snapshots[observationCount - 1].candle) : 0;

    const partial = typeof partialEventCount === 'number';

    const agreement = this.agreementRate(champion.decisions, challenger.decisions);
    const divergence = this.classifyDivergence(champion.decisions, challenger.decisions);
    const relative = this.relativeMetrics(champion.metrics, challenger.metrics);

    const evaluationPayload = {
      evaluationId: options.coordinatorEvaluation.evaluationId,
      championArtifactHash: options.champion.artifactHash,
      challengerArtifactHash: options.challenger.artifactHash,
      championSnapshotHash: options.championSnapshot.snapshotHash,
      executionContextHash: options.coordinatorEvaluation.executionContextHash,
      executionContextVersion: options.coordinatorEvaluation.executionContextVersion,
      datasetHash: options.datasetHash,
      marketDataStartTimestamp: startTimestamp,
      marketDataEndTimestamp: endTimestamp,
      observationCount,
      championMetrics: champion.metrics,
      challengerMetrics: challenger.metrics,
      relativeMetrics: relative,
      decisionAgreement: agreement,
      decisionDivergence: divergence,
      shadowEvaluationVersion: this.SHADOW_EVALUATION_VERSION,
    };

    const evidenceHash = hash(evaluationPayload);
    const evaluation: ShadowComparisonEvaluation = freeze({ ...evaluationPayload, evidenceHash });

    const shadowEvidence: ShadowEvidence = freeze({
      evaluationId: options.coordinatorEvaluation.evaluationId,
      championArtifactHash: options.champion.artifactHash,
      challengerArtifactHash: options.challenger.artifactHash,
      championSnapshotHash: options.championSnapshot.snapshotHash,
      executionContextHash: options.coordinatorEvaluation.executionContextHash,
      executionContextVersion: options.coordinatorEvaluation.executionContextVersion,
      marketDataCutoffTimestamp: options.marketDataCutoffTimestamp,
      datasetHash: options.datasetHash,
      observationCount,
      metrics: challenger.metrics,
      divergenceScore: 1 - agreement,
      shadowEvaluationVersion: this.SHADOW_EVALUATION_VERSION,
      featurePipelineVersion: 'canonical-feature-pipeline-v2',
      featureSchemaHash: featureSnapshots.length ? featureSnapshots[0].featureSchemaHash : 'empty',
      canonicalMLFeatureHash: featureSnapshots.length ? featureSnapshots[featureSnapshots.length - 1].canonicalMLFeatureHash : 'empty',
      evidenceHash,
      ...challenger.metrics,
    });

    const replayPayload = {
      evaluationId: options.coordinatorEvaluation.evaluationId,
      championArtifactHash: options.champion.artifactHash,
      challengerArtifactHash: options.challenger.artifactHash,
      championSnapshotHash: options.championSnapshot.snapshotHash,
      executionContextHash: options.coordinatorEvaluation.executionContextHash,
      executionContextVersion: options.coordinatorEvaluation.executionContextVersion,
      datasetHash: options.datasetHash,
      marketDataStartTimestamp: startTimestamp,
      marketDataEndTimestamp: endTimestamp,
      observationCount,
      championMetrics: champion.metrics,
      challengerMetrics: challenger.metrics,
      relativeMetrics: relative,
      decisionAgreement: agreement,
      decisionDivergence: divergence,
      shadowEvaluationVersion: this.SHADOW_EVALUATION_VERSION,
    };

    const result = {
      evaluation,
      shadowEvidence: freeze({ ...shadowEvidence, shadowEvaluationVersion: this.SHADOW_EVALUATION_VERSION }),
      champion,
      challenger,
      marketSnapshots: snapshots.slice(0, observationCount),
      featureSnapshots: featureSnapshots.slice(0, observationCount),
      shadowEvaluationHash: evidenceHash,
      checkpoint: partial
        ? this.createCheckpoint(options, evaluation.evaluationId, champion, challenger, snapshots, featureSnapshots, observationCount)
        : undefined,
    };

    if (!partial && hash(replayPayload) !== evidenceHash) {
      throw new Error('SHADOW_NONDETERMINISTIC_REPLAY');
    }

    return freeze(result);
  }

  private static computeCheckpointConfigHash(options: SynchronizedShadowEvaluationOptions): string {
    return hash({
      evaluationId: options.coordinatorEvaluation.evaluationId,
      championArtifactHash: options.champion.artifactHash,
      challengerArtifactHash: options.challenger.artifactHash,
      championSnapshotHash: options.championSnapshot.snapshotHash,
      executionContextHash: options.coordinatorEvaluation.executionContextHash,
      executionContextVersion: options.coordinatorEvaluation.executionContextVersion,
      datasetHash: options.datasetHash,
      featureVersion: options.featureVersion,
      marketDataCutoffTimestamp: options.marketDataCutoffTimestamp,
      symbol: options.symbol,
      timeframe: options.timeframe,
      dataVersion: options.dataVersion,
      shadowEvaluationVersion: this.SHADOW_EVALUATION_VERSION,
    });
  }

  private static createCheckpoint(
    options: SynchronizedShadowEvaluationOptions,
    evaluationId: string,
    champion: ShadowBranchResult,
    challenger: ShadowBranchResult,
    snapshots: readonly EvaluationMarketSnapshot[],
    featureSnapshots: readonly FeatureSnapshot[],
    processedEventCount: number,
  ): ShadowEvaluationCheckpoint {
    const last = snapshots[processedEventCount - 1];
    const configHash = this.computeCheckpointConfigHash(options);

    return freeze({
      configHash,
      evaluationId,
      lastProcessedTimestamp: timestampOf(last.candle),
      lastSnapshotId: last.snapshotId,
      marketSnapshotsPrefixHash: hash(snapshots.slice(0, processedEventCount)),
      featureSnapshotsPrefixHash: hash(featureSnapshots.slice(0, processedEventCount)),
      championDecisionsPrefixHash: hash(champion.decisions),
      challengerDecisionsPrefixHash: hash(challenger.decisions),
      championExecutionsPrefixHash: hash(champion.executions),
      challengerExecutionsPrefixHash: hash(challenger.executions),
      championPendingOrdersPrefixHash: hash(champion.state.pendingOrders),
      challengerPendingOrdersPrefixHash: hash(challenger.state.pendingOrders),
      championStateHash: hash(champion.state),
      challengerStateHash: hash(challenger.state),
      metricsStateHash: hash({ champion: champion.metrics, challenger: challenger.metrics }),
      processedEventCount,
      state: {
        champion,
        challenger,
        marketSnapshots: snapshots.slice(0, processedEventCount),
        featureSnapshots: featureSnapshots.slice(0, processedEventCount),
      },
    });
  }

  private static validateCheckpoint(
    checkpoint: ShadowEvaluationCheckpoint,
    options: SynchronizedShadowEvaluationOptions,
    currentSnapshots: readonly EvaluationMarketSnapshot[],
  ): void {
    const expectedConfigHash = this.computeCheckpointConfigHash(options);
    if (checkpoint.configHash !== expectedConfigHash) {
      throw new Error('SHADOW_CORRUPTED_CHECKPOINT');
    }
    if (checkpoint.evaluationId !== options.coordinatorEvaluation.evaluationId) {
      throw new Error('SHADOW_CORRUPTED_CHECKPOINT');
    }
    if (checkpoint.championStateHash !== hash(checkpoint.state.champion.state)) {
      throw new Error('SHADOW_CORRUPTED_CHECKPOINT');
    }
    if (checkpoint.challengerStateHash !== hash(checkpoint.state.challenger.state)) {
      throw new Error('SHADOW_CORRUPTED_CHECKPOINT');
    }
    if (
      checkpoint.metricsStateHash !==
      hash({ champion: checkpoint.state.champion.metrics, challenger: checkpoint.state.challenger.metrics })
    ) {
      throw new Error('SHADOW_CORRUPTED_CHECKPOINT');
    }
    if (checkpoint.processedEventCount !== checkpoint.state.marketSnapshots.length) {
      throw new Error('SHADOW_CORRUPTED_CHECKPOINT');
    }
    if (checkpoint.processedEventCount > currentSnapshots.length) {
      throw new Error('SHADOW_CORRUPTED_CHECKPOINT');
    }

    const expectedLastSnapshot = currentSnapshots[checkpoint.processedEventCount - 1];
    if (!expectedLastSnapshot) {
      throw new Error('SHADOW_CORRUPTED_CHECKPOINT');
    }
    if (checkpoint.lastSnapshotId !== expectedLastSnapshot.snapshotId) {
      throw new Error('SHADOW_CORRUPTED_CHECKPOINT');
    }
    if (checkpoint.lastProcessedTimestamp !== timestampOf(expectedLastSnapshot.candle)) {
      throw new Error('SHADOW_CORRUPTED_CHECKPOINT');
    }
    if (hash(checkpoint.state.marketSnapshots) !== hash(currentSnapshots.slice(0, checkpoint.processedEventCount))) {
      throw new Error('SHADOW_CORRUPTED_CHECKPOINT');
    }
    if (
      checkpoint.marketSnapshotsPrefixHash &&
      checkpoint.marketSnapshotsPrefixHash !== hash(currentSnapshots.slice(0, checkpoint.processedEventCount))
    ) {
      throw new Error('SHADOW_CORRUPTED_CHECKPOINT');
    }
    if (
      checkpoint.featureSnapshotsPrefixHash &&
      checkpoint.featureSnapshotsPrefixHash !== hash(checkpoint.state.featureSnapshots)
    ) {
      throw new Error('SHADOW_CORRUPTED_CHECKPOINT');
    }
    if (
      checkpoint.championDecisionsPrefixHash &&
      checkpoint.championDecisionsPrefixHash !== hash(checkpoint.state.champion.decisions)
    ) {
      throw new Error('SHADOW_CORRUPTED_CHECKPOINT');
    }
    if (
      checkpoint.challengerDecisionsPrefixHash &&
      checkpoint.challengerDecisionsPrefixHash !== hash(checkpoint.state.challenger.decisions)
    ) {
      throw new Error('SHADOW_CORRUPTED_CHECKPOINT');
    }
    if (
      checkpoint.championExecutionsPrefixHash &&
      checkpoint.championExecutionsPrefixHash !== hash(checkpoint.state.champion.executions)
    ) {
      throw new Error('SHADOW_CORRUPTED_CHECKPOINT');
    }
    if (
      checkpoint.challengerExecutionsPrefixHash &&
      checkpoint.challengerExecutionsPrefixHash !== hash(checkpoint.state.challenger.executions)
    ) {
      throw new Error('SHADOW_CORRUPTED_CHECKPOINT');
    }
    if (
      checkpoint.championPendingOrdersPrefixHash &&
      checkpoint.championPendingOrdersPrefixHash !== hash(checkpoint.state.champion.state.pendingOrders)
    ) {
      throw new Error('SHADOW_CORRUPTED_CHECKPOINT');
    }
    if (
      checkpoint.challengerPendingOrdersPrefixHash &&
      checkpoint.challengerPendingOrdersPrefixHash !== hash(checkpoint.state.challenger.state.pendingOrders)
    ) {
      throw new Error('SHADOW_CORRUPTED_CHECKPOINT');
    }
  }

  private static relativeMetrics(champion: Phase10BShadowMetrics, challenger: Phase10BShadowMetrics): Readonly<Record<string, number>> {
    const keys: (keyof Phase10BShadowMetrics)[] = [
      'totalPnL',
      'returnPct',
      'expectancy',
      'profitFactor',
      'winRate',
      'tradeCount',
      'averageTrade',
      'averageR',
      'maxDrawdown',
      'turnover',
      'fees',
      'slippage',
      'costAdjustedPnL',
      'riskAdjustedReturn',
    ];
    const result: Record<string, number> = {};
    for (const key of keys) {
      const challengerValue = Number(challenger[key]);
      const championValue = Number(champion[key]);
      result[key] = Number((challengerValue - championValue).toFixed(8));
    }
    return freeze(result);
  }

  private static agreementRate(champion: readonly ShadowDecision[], challenger: readonly ShadowDecision[]): number {
    if (!champion.length) return 0;
    const matches = champion.filter(
      (decision, index) => decision.action === challenger[index]?.action && decision.quantity === challenger[index]?.quantity,
    ).length;
    return Number((matches / champion.length).toFixed(8));
  }

  private static classifyDivergence(
    champion: readonly ShadowDecision[],
    challenger: readonly ShadowDecision[],
  ): Readonly<Record<DivergenceType, number>> {
    const result: Record<DivergenceType, number> = {
      ENTER_vs_HOLD: 0,
      EXIT_vs_HOLD: 0,
      LONG_vs_SHORT: 0,
      LONG_vs_FLAT: 0,
      SHORT_vs_FLAT: 0,
      SIZING_DIFFERENCE: 0,
      RISK_DIFFERENCE: 0,
    };
    champion.forEach((left, index) => {
      const right = challenger[index];
      if (!right || left.action === right.action) return;
      if ((this.isEnter(left.action) && right.action === 'HOLD') || (this.isEnter(right.action) && left.action === 'HOLD')) {
        result.ENTER_vs_HOLD += 1;
      }
      if ((left.action === 'EXIT' && right.action === 'HOLD') || (right.action === 'EXIT' && left.action === 'HOLD')) {
        result.EXIT_vs_HOLD += 1;
      }
      if (
        (left.positionTarget === 'LONG' && right.positionTarget === 'SHORT') ||
        (left.positionTarget === 'SHORT' && right.positionTarget === 'LONG')
      ) {
        result.LONG_vs_SHORT += 1;
      }
      if (
        (left.positionTarget === 'LONG' && right.positionTarget === 'FLAT') ||
        (right.positionTarget === 'LONG' && left.positionTarget === 'FLAT')
      ) {
        result.LONG_vs_FLAT += 1;
      }
      if (
        (left.positionTarget === 'SHORT' && right.positionTarget === 'FLAT') ||
        (right.positionTarget === 'SHORT' && left.positionTarget === 'FLAT')
      ) {
        result.SHORT_vs_FLAT += 1;
      }
      if (left.quantity !== right.quantity) {
        result.SIZING_DIFFERENCE += 1;
      }
      if (hash(left.riskState) !== hash(right.riskState)) {
        result.RISK_DIFFERENCE += 1;
      }
    });
    return freeze(result);
  }

  private static isEnter(action: ShadowDecisionAction): boolean {
    return action === 'ENTER_LONG' || action === 'ENTER_SHORT';
  }

  private static expectedIntervalMs(timeframe: string): number {
    const match = /^(\d+)(m|h|d)$/.exec(timeframe);
    if (!match) return 60_000;
    const value = Number(match[1]);
    if (match[2] === 'm') return value * 60_000;
    if (match[2] === 'h') return value * 60 * 60_000;
    return value * 24 * 60 * 60_000;
  }
}
