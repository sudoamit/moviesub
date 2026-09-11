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

export interface ShadowExecutionResult {
  readonly orderId: string;
  readonly decisionId: string;
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
  readonly slippageBps?: number;
  readonly riskPerTrade: number;
  readonly quantity: number;
  readonly fillModel?: string;
  readonly ambiguityMode?: string;
  readonly latencyMs?: number;
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
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Object.getOwnPropertyNames(value)) freeze((value as Record<string, unknown>)[key]);
  return value;
}

function hash(value: unknown): string {
  return createHash('sha256').update(canonicalJsonStringify(value)).digest('hex');
}

function timestampOf(candle: ICandle): number {
  return candle.timestamp instanceof Date ? candle.timestamp.getTime() : new Date(candle.timestamp).getTime();
}

function cloneState(state: ShadowBranchState): ShadowBranchState {
  return freeze(JSON.parse(JSON.stringify(state)));
}

export class SynchronizedEvaluationClock {
  private index = -1;
  public constructor(private readonly snapshots: readonly EvaluationMarketSnapshot[]) {}

  public next(): EvaluationMarketSnapshot | undefined {
    this.index += 1;
    return this.snapshots[this.index];
  }

  public currentTimestamp(): number | undefined {
    return this.snapshots[this.index]?.candle ? timestampOf(this.snapshots[this.index].candle) : undefined;
  }

  public currentCutoff(): number | undefined {
    return this.snapshots[this.index]?.marketDataCutoffTimestamp;
  }

  public snapshotId(): string | undefined {
    return this.snapshots[this.index]?.snapshotId;
  }
}

/**
 * Restricted Shadow Execution Adapter wrapping the canonical ExecutionSimulator.
 * Exposes simulation capabilities only and strictly forbids live order routing for shadow branches.
 * Enforces true causal temporal eligibility and rejects synthetic fallback fills.
 */
export class ShadowExecutionAdapter {
  private readonly simulator: ExecutionSimulator;
  public readonly simulatorId: string;
  public readonly feeModelHash: string;
  public readonly slippageModelHash: string;
  public readonly hasProductionOrderRouter: boolean;
  private readonly fillModel: FillModel;
  private readonly latencyMs: number;
  private readonly symbol: string;

  public constructor(
    private readonly mode: ShadowMode,
    private readonly executionContext: ProductionExecutionContextInput | ProductionExecutionContext,
    private readonly config: ShadowExecutionConfig,
    runId = 'shadow-eval',
  ) {
    // Challenger in SHADOW mode strictly has NO live order router
    this.hasProductionOrderRouter = mode !== 'SHADOW';
    this.simulatorId = `canonical-execution-simulator-${runId}`;
    this.symbol = executionContext.symbol;

    this.fillModel = ((executionContext.fillModel || config.fillModel || 'OHLC_PATH') as FillModel);
    const ambiguityMode = ((executionContext.ambiguityMode || config.ambiguityMode || 'CONSERVATIVE') as SameCandleAmbiguityMode);
    const latencyConfig: ILatencyConfig = executionContext.latencyConfig || {
      submissionLatencyMs: config.latencyMs ?? 15,
      processingLatencyMs: 5,
    };
    this.latencyMs = latencyConfig.submissionLatencyMs;

    let feeConfig: IFeeConfig | undefined = executionContext.feeConfig;
    if (!feeConfig && config.feePerTrade !== undefined) {
      feeConfig = { brokerageFlat: config.feePerTrade };
    } else if (!feeConfig && config.feeRate !== undefined) {
      feeConfig = { brokerageRateBps: config.feeRate * 10000 };
    }

    let slippageConfig: ISlippageConfig | undefined = executionContext.slippageConfig;
    if (!slippageConfig && config.slippageBps !== undefined) {
      slippageConfig = {
        baseSlippageBps: config.slippageBps,
        volatilityMultiplier: 1.0,
        impactMultiplier: 1.0,
        maxSlippageBps: Math.max(25.0, config.slippageBps * 2),
      };
    } else if (!slippageConfig && config.slippagePerTrade !== undefined) {
      slippageConfig = {
        baseSlippageBps: 0,
        volatilityMultiplier: 0,
        impactMultiplier: 0,
        maxSlippageBps: 0,
      };
    }

    const spreadConfig: ISpreadConfig | undefined =
      executionContext.spreadConfig ||
      (config.feePerTrade !== undefined || config.slippagePerTrade !== undefined
        ? { baseSpreadBps: 0, illiquidMultiplier: 1.0 }
        : undefined);
    const costStressConfig: ExecutionCostStressConfig | undefined = executionContext.costStressConfig;

    this.feeModelHash = hash(feeConfig ?? { type: 'zero-fee' });
    this.slippageModelHash = hash(slippageConfig ?? { type: 'zero-slippage' });

    this.simulator = new ExecutionSimulator(
      this.fillModel,
      ambiguityMode,
      latencyConfig,
      runId,
      slippageConfig,
      feeConfig,
      spreadConfig,
      costStressConfig,
    );
  }

  /**
   * Simulates decision execution strictly via the canonical ExecutionSimulator.
   * Enforces temporal causality: decisionTimestamp -> orderSubmission -> orderArrival -> execution.
   * NO synthetic fallback fills are allowed.
   */
  public execute(
    decision: ShadowDecision,
    snapshot: EvaluationMarketSnapshot,
    nextCandle?: ICandle,
    currentState?: ShadowBranchState,
  ): readonly ShadowExecutionResult[] {
    if (this.mode === 'SHADOW' && this.hasProductionOrderRouter) {
      throw new Error('SHADOW_PRODUCTION_ROUTER_FORBIDDEN');
    }

    const decisionCutoffTimestamp = decision.decisionCutoffTimestamp;
    const decisionTimestamp = decision.timestamp;

    // Temporal requirement: decisionTimestamp >= decisionCutoffTimestamp
    if (decisionTimestamp < decisionCutoffTimestamp) {
      throw new Error('SHADOW_LOOKAHEAD_DETECTED: Decision timestamp cannot precede decision cutoff');
    }
    if (decisionCutoffTimestamp > snapshot.marketDataCutoffTimestamp) {
      throw new Error('SHADOW_LOOKAHEAD_DETECTED: Decision cutoff exceeds snapshot cutoff');
    }

    const orderSubmissionTimestamp = decisionTimestamp;
    const orderArrivalTimestamp = orderSubmissionTimestamp + this.latencyMs;

    let state: ShadowBranchState = currentState ?? {
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
      openOrders: [],
      closedTrades: [],
      riskState: decision.riskState,
      portfolioState: { equity: this.config.initialCapital },
    };

    const results: ShadowExecutionResult[] = [];
    const action = decision.action;

    if (action === 'HOLD') {
      return results;
    }

    // P1 #3: Close-of-Bar execution semantics
    // Orders generated at close of candle T are executed on nextCandle (candle T+1).
    // If no nextCandle is available yet, no fill can occur.
    if (!nextCandle) {
      return results;
    }

    // Handle EXIT or REVERSAL when an active position exists
    if (state.position !== 'FLAT') {
      const isClosing =
        action === 'EXIT' ||
        (state.position === 'LONG' && action === 'ENTER_SHORT') ||
        (state.position === 'SHORT' && action === 'ENTER_LONG');

      if (isClosing) {
        const exitSide = state.position === 'LONG' ? 'SELL' : 'BUY';
        const isPartial = action === 'EXIT' && decision.quantity > 0 && decision.quantity < state.quantity;
        const exitQty = isPartial ? decision.quantity : state.quantity;

        const exitOrder = this.simulator.submitOrder({
          tradeId: `trade-${decision.decisionId}-exit`,
          symbol: this.symbol,
          side: exitSide,
          orderType: 'MARKET',
          quantity: exitQty,
          timestamp: orderSubmissionTimestamp,
          referencePrice: snapshot.candle.close,
          signalTimestamp: decisionTimestamp,
          exitTarget: 'SL',
        });

        const simResult = this.simulator.processSingleExecutionBar(nextCandle);
        const fill = simResult.fills.find((f) => f.orderId === exitOrder.orderId);

        // P1 #2 & P2 #12: NO synthetic fallback fills. If not filled, return no fill.
        if (!fill) {
          return results;
        }

        const executionTimestamp = fill.timestamp;

        // P1 #1: Enforce true execution eligibility
        if (executionTimestamp < orderArrivalTimestamp) {
          throw new Error('SHADOW_LOOKAHEAD_DETECTED: Execution timestamp cannot precede order arrival timestamp');
        }

        const isLong = state.position === 'LONG';
        // P1 #6: Canonical simulator controls fill price
        const rawExitPrice = fill.price;
        const rawEntryPrice = state.rawEntryPrice > 0 ? state.rawEntryPrice : state.entryPrice;

        const grossPnL = Number(
          ((isLong ? (rawExitPrice - rawEntryPrice) : (rawEntryPrice - rawExitPrice)) * fill.quantity).toFixed(8),
        );

        // P1 #4: Partial exit cost allocation
        const exitFraction = state.quantity > 0 ? fill.quantity / state.quantity : 1;
        const allocatedEntryFees = Number((state.remainingEntryFees * exitFraction).toFixed(8));
        const allocatedEntrySlippage = Number((state.remainingEntrySlippage * exitFraction).toFixed(8));

        const exitFee = this.config.feePerTrade !== undefined ? this.config.feePerTrade : (fill.fee ?? 0);
        const exitSlippage = this.config.slippagePerTrade !== undefined ? this.config.slippagePerTrade : (fill.slippage ?? 0);

        const totalFees = Number((allocatedEntryFees + exitFee).toFixed(8));
        const totalSlippage = Number((allocatedEntrySlippage + exitSlippage).toFixed(8));
        const netPnL = Number((grossPnL - totalFees - totalSlippage).toFixed(8));

        const riskUnit = Math.max(Math.abs(state.entryPrice) * (this.config.riskPerTrade || 0.01) * fill.quantity, 1);
        const rMultiple = Number((netPnL / riskUnit).toFixed(8));

        const exitResult: ShadowExecutionResult = freeze({
          orderId: exitOrder.orderId,
          decisionId: decision.decisionId,
          entryPrice: state.entryPrice,
          exitPrice: rawExitPrice,
          quantity: fill.quantity,
          fees: totalFees,
          slippage: totalSlippage,
          grossPnL,
          realizedPnL: netPnL,
          unrealizedPnL: 0,
          rMultiple,
          decisionTimestamp,
          decisionCutoffTimestamp,
          orderSubmissionTimestamp,
          orderArrivalTimestamp,
          executionTimestamp,
          executionContextHash: snapshot.executionContextHash,
        });

        results.push(exitResult);

        // Update state after closing/partial exit to maintain atomicity
        const newQty = Math.max(0, state.quantity - fill.quantity);
        const newRemainingFees = Math.max(0, Number((state.remainingEntryFees - allocatedEntryFees).toFixed(8)));
        const newRemainingSlippage = Math.max(0, Number((state.remainingEntrySlippage - allocatedEntrySlippage).toFixed(8)));

        state = {
          ...state,
          capital: Number((state.capital + netPnL).toFixed(8)),
          quantity: newQty,
          position: newQty === 0 ? 'FLAT' : state.position,
          entryPrice: newQty === 0 ? 0 : state.entryPrice,
          rawEntryPrice: newQty === 0 ? 0 : state.rawEntryPrice,
          averageEntryPrice: newQty === 0 ? 0 : state.averageEntryPrice,
          remainingEntryFees: newRemainingFees,
          remainingEntrySlippage: newRemainingSlippage,
          realizedPnL: Number((state.realizedPnL + netPnL).toFixed(8)),
        };
      }
    }

    // Handle ENTRY (either from FLAT or as second half of an atomic reversal)
    const isEntering =
      (action === 'ENTER_LONG' && state.position !== 'LONG') ||
      (action === 'ENTER_SHORT' && state.position !== 'SHORT');

    if (isEntering) {
      const enterSide = action === 'ENTER_LONG' ? 'BUY' : 'SELL';
      const enterQty = decision.quantity > 0 ? decision.quantity : 1;

      const enterOrder = this.simulator.submitOrder({
        tradeId: `trade-${decision.decisionId}-enter`,
        symbol: this.symbol,
        side: enterSide,
        orderType: 'MARKET',
        quantity: enterQty,
        timestamp: orderSubmissionTimestamp,
        referencePrice: snapshot.candle.close,
        signalTimestamp: decisionTimestamp,
        exitTarget: 'ENTRY',
      });

      const simResult = this.simulator.processSingleExecutionBar(nextCandle);
      const fill = simResult.fills.find((f) => f.orderId === enterOrder.orderId);

      // P1 #2 & P2 #12: NO synthetic fallback fills. If not filled, return results.
      if (!fill) {
        return results;
      }

      const executionTimestamp = fill.timestamp;

      // P1 #1: Enforce true execution eligibility
      if (executionTimestamp < orderArrivalTimestamp) {
        throw new Error('SHADOW_LOOKAHEAD_DETECTED: Execution timestamp cannot precede order arrival timestamp');
      }

      const fillFee = this.config.feePerTrade !== undefined ? this.config.feePerTrade : (fill.fee ?? 0);
      const fillSlippage = this.config.slippagePerTrade !== undefined ? this.config.slippagePerTrade : (fill.slippage ?? 0);

      // P1 #6: Canonical simulator controls fill price
      const enterResult: ShadowExecutionResult = freeze({
        orderId: enterOrder.orderId,
        decisionId: decision.decisionId,
        entryPrice: fill.price,
        exitPrice: 0,
        quantity: fill.quantity,
        fees: fillFee,
        slippage: fillSlippage,
        grossPnL: 0,
        realizedPnL: 0,
        unrealizedPnL: 0,
        rMultiple: 0,
        decisionTimestamp,
        decisionCutoffTimestamp,
        orderSubmissionTimestamp,
        orderArrivalTimestamp,
        executionTimestamp,
        executionContextHash: snapshot.executionContextHash,
      });

      results.push(enterResult);
    }

    return freeze(results);
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

      const nextSnapshot = eventIndex < snapshots.length - 1 ? snapshots[eventIndex + 1] : undefined;
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
        nextSnapshot?.candle,
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
        nextSnapshot?.candle,
      );

      eventIndex++;
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
    if (snapshot.executionContextHash !== options.coordinatorEvaluation.executionContextHash) {
      throw new Error('SHADOW_EXECUTION_CONTEXT_MISMATCH');
    }
    if (feature.sourceSnapshotHash !== snapshot.snapshotHash) {
      throw new Error('SHADOW_FEATURE_HASH_MISMATCH');
    }
    if (feature.cutoffTimestamp !== snapshot.marketDataCutoffTimestamp) {
      throw new Error('SHADOW_MARKET_DATA_CUTOFF_MISMATCH');
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

        // Point-in-time per-event marketDataCutoffTimestamp: strictly for THIS event
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
        const featureSeedHash = hash({ featureVersion: options.featureVersion, candle, cutoff: perEventCutoffTimestamp });
        const snapshotHash = hash(payload);
        return {
          snapshotId: `shadow-snapshot-${index}-${timestamp}`,
          snapshotHash,
          ...payload,
          featureSnapshotHash: featureSeedHash,
        };
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

    // Reject lookahead leakage: decisionCutoff must cover the candle
    if (candleTime > decisionCutoff) {
      throw new Error('SHADOW_LOOKAHEAD_DETECTED');
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

    let canonicalMLFeatureHash = 'none';
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
      } catch {
        canonicalMLFeatureHash = 'none';
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
    nextCandle?: ICandle,
  ): ShadowBranchResult {
    if (branch.mode === 'SHADOW' && branch.hasProductionOrderRouter) {
      throw new Error('SHADOW_PRODUCTION_ROUTER_FORBIDDEN');
    }

    const provided = options.decisionProvider
      ? options.decisionProvider({
          artifact,
          snapshot,
          features: feature,
          state: branch.state,
          mode: branch.mode,
        })
      : this.evaluateCandidateStrategyDecision(artifact, snapshot, feature, historicalCandles, branch.state, branch.mode);

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

    // Invoke canonical execution adapter
    const newExecutions = adapter.execute(decision, snapshot, nextCandle, branch.state);
    const executions = [...branch.executions, ...newExecutions];
    const state = this.updateState(branch.state, decision, newExecutions, config, snapshot.candle.close);

    return freeze({
      mode: branch.mode,
      state,
      decisions: [...branch.decisions, decision],
      executions,
      metrics: this.calculateMetrics(executions, config.initialCapital, config.riskPerTrade, snapshot.marketDataCutoffTimestamp),
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
    const strategyConfig = artifact.strategyConfig;
    const execConfig = artifact.executionConfig as Record<string, any> | undefined;

    // P1 #7: Incomplete artifact configuration must fail closed
    if (!strategyConfig && !artifact.modelArtifact) {
      throw new Error('SHADOW_INCOMPLETE_ARTIFACT_CONFIGURATION: Candidate artifact is missing strategyConfig and modelArtifact');
    }
    if (strategyConfig && !strategyConfig.strategyMode && !artifact.modelArtifact) {
      throw new Error('SHADOW_INCOMPLETE_ARTIFACT_CONFIGURATION: Candidate artifact is missing strategyMode in strategyConfig');
    }
    if (strategyConfig && !strategyConfig.scoringWeights && !artifact.modelArtifact) {
      throw new Error('SHADOW_INCOMPLETE_ARTIFACT_CONFIGURATION: Candidate artifact is missing scoringWeights in strategyConfig');
    }

    try {
      const scoringWeights = (strategyConfig?.scoringWeights as any);
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

      const minScore = typeof execConfig?.minMtfScore === 'number' ? execConfig.minMtfScore : 50;
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

          if (featureVector && featureVector.length === CANONICAL_V2_DIMENSION) {
            const scalerParams = (model as any).scalerArtifact?.scalerParameters || artifact.scalerArtifact?.scalerParameters;
            let z = (model as any).bias;
            for (let j = 0; j < (model as any).weights.length; j++) {
              const featName = CANONICAL_FEATURE_NAMES_V2[j];
              const rawVal = featureVector[j];
              const scaledVal = scalerParams && featName && scalerParams[featName]
                ? scalerParams[featName].std < 1e-5 ? 0 : (rawVal - scalerParams[featName].mean) / scalerParams[featName].std
                : rawVal;
              z += (model as any).weights[j] * scaledVal;
            }
            const prob = 1.0 / (1.0 + Math.exp(-Math.max(-15, Math.min(15, z))));
            modelProb = prob;
            modelScore = Math.round(prob * 100);
          }
        }

        const requiredMinScore = typeof minProbability === 'number'
          ? (minProbability > 1 ? minProbability : minProbability * 100)
          : minScore;
        if (typeof modelScore === 'number' && modelScore < requiredMinScore) {
          skip = true;
        }
      }

      if (!skip && signal) {
        const isLong = signal.direction === Direction.BULLISH;
        let action: ShadowDecisionAction;
        let positionTarget: 'LONG' | 'SHORT' | 'FLAT';

        if (isLong) {
          action = state.position === 'LONG' ? 'HOLD' : 'ENTER_LONG';
          positionTarget = 'LONG';
        } else {
          action = state.position === 'SHORT' ? 'HOLD' : 'ENTER_SHORT';
          positionTarget = 'SHORT';
        }

        let quantity = 1;
        const sizingMult = typeof execConfig?.sizingMultiplier === 'number' ? execConfig.sizingMultiplier : undefined;
        if (sizingMult && sizingMult > 0) {
          quantity = Math.max(1, Math.round(quantity * sizingMult));
        }

        return {
          action,
          confidence: signal.score / 100,
          positionTarget,
          quantity,
          riskState: state.riskState,
        };
      }

      return {
        action: 'HOLD',
        confidence: 0,
        positionTarget: state.position,
        quantity: state.quantity,
        riskState: state.riskState,
      };
    } catch (err: any) {
      if (err.message?.includes('SHADOW_INCOMPLETE_ARTIFACT_CONFIGURATION')) {
        throw err;
      }
      throw new Error(`SHADOW_DECISION_PROVIDER_REQUIRED: ${err.message || 'Strategy execution failed'}`);
    }
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

  private static updateState(
    state: ShadowBranchState,
    decision: ShadowDecision,
    executions: readonly ShadowExecutionResult[],
    config: ShadowExecutionConfig,
    currentClose: number,
  ): ShadowBranchState {
    let capital = state.capital;
    let position = state.position;
    let quantity = state.quantity;
    let initialQuantity = state.initialQuantity;
    let entryPrice = state.entryPrice;
    let rawEntryPrice = state.rawEntryPrice;
    let averageEntryPrice = state.averageEntryPrice;
    let entryFees = state.entryFees;
    let remainingEntryFees = state.remainingEntryFees;
    let entrySlippage = state.entrySlippage;
    let remainingEntrySlippage = state.remainingEntrySlippage;
    let realizedPnL = state.realizedPnL;
    const closedTrades = [...state.closedTrades];

    for (const exec of executions) {
      if (exec.exitPrice > 0) {
        // Exit or partial exit execution
        realizedPnL = Number((realizedPnL + exec.realizedPnL).toFixed(8));
        capital = Number((capital + exec.realizedPnL).toFixed(8));
        closedTrades.push(exec);
        const exitFraction = quantity > 0 ? exec.quantity / quantity : 1;
        const allocatedFees = Number((remainingEntryFees * exitFraction).toFixed(8));
        const allocatedSlippage = Number((remainingEntrySlippage * exitFraction).toFixed(8));

        quantity = Math.max(0, quantity - exec.quantity);
        remainingEntryFees = Math.max(0, Number((remainingEntryFees - allocatedFees).toFixed(8)));
        remainingEntrySlippage = Math.max(0, Number((remainingEntrySlippage - allocatedSlippage).toFixed(8)));

        if (quantity === 0) {
          position = 'FLAT';
          initialQuantity = 0;
          entryPrice = 0;
          rawEntryPrice = 0;
          averageEntryPrice = 0;
          entryFees = 0;
          remainingEntryFees = 0;
          entrySlippage = 0;
          remainingEntrySlippage = 0;
        }
      } else {
        // Entry execution
        position = decision.positionTarget;
        quantity = exec.quantity;
        initialQuantity = exec.quantity;
        entryPrice = exec.entryPrice;
        rawEntryPrice = exec.entryPrice;
        averageEntryPrice = exec.entryPrice;
        entryFees = exec.fees;
        remainingEntryFees = exec.fees;
        entrySlippage = exec.slippage;
        remainingEntrySlippage = exec.slippage;
      }
    }

    let unrealizedPnL = 0;
    if (position !== 'FLAT' && quantity > 0) {
      const isLong = position === 'LONG';
      unrealizedPnL = Number((((isLong ? currentClose - entryPrice : entryPrice - currentClose) * quantity)).toFixed(8));
    }

    const equity = Number((capital + unrealizedPnL).toFixed(8));

    return freeze({
      capital,
      position,
      quantity,
      initialQuantity,
      entryPrice,
      rawEntryPrice,
      averageEntryPrice,
      entryFees,
      remainingEntryFees,
      entrySlippage,
      remainingEntrySlippage,
      realizedPnL,
      unrealizedPnL,
      openOrders: executions.length > 0 ? [] : state.openOrders,
      closedTrades,
      riskState: { ...decision.riskState },
      portfolioState: { equity, initialCapital: config.initialCapital, capital },
    });
  }

  private static calculateMetrics(
    executions: readonly ShadowExecutionResult[],
    initialCapital: number,
    riskPerTrade: number,
    observationsCount: number,
  ): Phase10BShadowMetrics {
    // Only completed trades (exits) contribute to realized PnL and trade statistics
    const closedTrades = executions.filter((exec) => exec.exitPrice > 0);
    const wins = closedTrades.filter((t) => t.realizedPnL > 0);
    const losses = closedTrades.filter((t) => t.realizedPnL < 0);

    const grossProfit = wins.reduce((sum, t) => sum + Math.max(0, t.grossPnL), 0);
    const grossLoss = Math.abs(losses.reduce((sum, t) => sum + Math.min(0, t.grossPnL), 0));
    const grossPnL = Number((grossProfit - grossLoss).toFixed(8));

    const fees = Number(closedTrades.reduce((sum, t) => sum + t.fees, 0).toFixed(8));
    const slippage = Number(closedTrades.reduce((sum, t) => sum + t.slippage, 0).toFixed(8));

    // netPnL = grossPnL - fees - slippage. Exactly single cost deduction.
    const netPnL = Number(closedTrades.reduce((sum, t) => sum + t.realizedPnL, 0).toFixed(8));
    const totalPnL = netPnL;
    const costAdjustedPnL = netPnL;

    const rValues = closedTrades.map((t) => t.rMultiple);
    const pnlR = Number(rValues.reduce((sum, value) => sum + value, 0).toFixed(8));

    let peak = 0;
    let curve = 0;
    let maxDrawdown = 0;
    for (const trade of closedTrades) {
      curve += trade.realizedPnL;
      peak = Math.max(peak, curve);
      maxDrawdown = Math.max(maxDrawdown, peak - curve);
    }

    const riskUnit = Math.max(1, initialCapital * (riskPerTrade || 0.01));
    const maxDrawdownR = Number((maxDrawdown / riskUnit).toFixed(8));

    const sortedR = [...rValues].sort((a, b) => a - b);
    const medianR = sortedR.length === 0 ? 0 : sortedR.length % 2 === 1
      ? sortedR[Math.floor(sortedR.length / 2)]
      : (sortedR[sortedR.length / 2 - 1] + sortedR[sortedR.length / 2]) / 2;

    const totalTrades = closedTrades.length;
    const averageTrade = totalTrades ? Number((totalPnL / totalTrades).toFixed(8)) : 0;

    // P2 #10: Turnover includes all executed notional (both entry and exit sides)
    const turnover = Number(
      executions.reduce((sum, t) => sum + Math.abs(t.quantity * (t.exitPrice > 0 ? t.exitPrice : t.entryPrice)), 0).toFixed(8),
    );

    return freeze({
      totalTrades,
      wins: wins.length,
      losses: losses.length,
      winRate: totalTrades ? Number(((wins.length / totalTrades) * 100).toFixed(8)) : 0,
      grossPnL,
      netPnL,
      pnlR,
      profitFactor: grossLoss > 0 ? Number((grossProfit / grossLoss).toFixed(8)) : grossProfit > 0 ? Number.POSITIVE_INFINITY : 0,
      maxDrawdown: Number(maxDrawdown.toFixed(8)),
      maxDrawdownR,
      expectancy: totalTrades ? Number((pnlR / totalTrades).toFixed(8)) : 0,
      averageR: totalTrades ? Number((pnlR / totalTrades).toFixed(8)) : 0,
      medianR: Number(medianR.toFixed(8)),
      largestLoss: losses.length ? Number(Math.min(...losses.map((t) => t.realizedPnL)).toFixed(8)) : 0,
      largestWin: wins.length ? Number(Math.max(...wins.map((t) => t.realizedPnL)).toFixed(8)) : 0,
      fees,
      slippage,
      observationsCount,
      totalPnL,
      returnPct: Number(((totalPnL / initialCapital) * 100).toFixed(8)),
      tradeCount: totalTrades,
      averageTrade,
      turnover,
      costAdjustedPnL,
      riskAdjustedReturn: maxDrawdown > 0 ? Number((totalPnL / maxDrawdown).toFixed(8)) : totalPnL,
    });
  }

  private static buildResult(
    options: SynchronizedShadowEvaluationOptions,
    champion: ShadowBranchResult,
    challenger: ShadowBranchResult,
    snapshots: readonly EvaluationMarketSnapshot[],
    featureSnapshots: readonly FeatureSnapshot[],
    executionConfig: ShadowExecutionConfig,
    processedEventCount?: number,
  ): SynchronizedShadowEvaluationResult {
    const observationCount = processedEventCount ?? snapshots.length;
    const partial = processedEventCount !== undefined && processedEventCount < snapshots.length;
    const relativeMetrics = this.relativeMetrics(champion.metrics, challenger.metrics);
    const decisionDivergence = this.classifyDivergence(champion.decisions, challenger.decisions);
    const decisionAgreement = this.agreementRate(champion.decisions, challenger.decisions);

    const evaluationSeed = {
      evaluationId: options.coordinatorEvaluation.evaluationId,
      championArtifactHash: options.champion.artifactHash,
      challengerArtifactHash: options.challenger.artifactHash,
      championSnapshotHash: options.championSnapshot.snapshotHash,
      executionContextHash: options.coordinatorEvaluation.executionContextHash,
      executionContextVersion: options.coordinatorEvaluation.executionContextVersion,
      datasetHash: options.datasetHash,
      marketDataStartTimestamp: timestampOf(snapshots[0].candle),
      marketDataEndTimestamp: timestampOf(snapshots[observationCount - 1].candle),
      observationCount,
      championMetrics: champion.metrics,
      challengerMetrics: challenger.metrics,
      relativeMetrics,
      decisionAgreement,
      decisionDivergence,
      shadowEvaluationVersion: this.SHADOW_EVALUATION_VERSION,
    };

    const replayPayload = {
      ...evaluationSeed,
      featureHash: hash(featureSnapshots.slice(0, observationCount)),
      snapshots: snapshots.slice(0, observationCount),
      championDecisions: champion.decisions,
      challengerDecisions: challenger.decisions,
      championExecutions: champion.executions,
      challengerExecutions: challenger.executions,
    };
    const evidenceHash = hash(replayPayload);
    const evaluation: ShadowComparisonEvaluation = freeze({ ...evaluationSeed, evidenceHash });

    const shadowEvidence: ShadowEvidence = freeze({
      ...challenger.metrics,
      challengerArtifactHash: options.challenger.artifactHash,
      championArtifactHash: options.champion.artifactHash,
      championSnapshotHash: options.championSnapshot.snapshotHash,
      executionContextHash: options.coordinatorEvaluation.executionContextHash,
      executionContextVersion: options.coordinatorEvaluation.executionContextVersion,
      datasetHash: options.datasetHash,
      marketDataCutoffTimestamp: options.marketDataCutoffTimestamp,
      shadowEvaluationVersion: this.SHADOW_EVALUATION_VERSION,
    });

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

    // P2 #11: Causal prefix integrity verification
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
