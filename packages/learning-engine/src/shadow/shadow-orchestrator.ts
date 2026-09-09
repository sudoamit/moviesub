import * as path from 'path';
import { createHash } from 'crypto';
import { Direction, IBacktestTrade, ICandle, SignalState } from '@quant/shared';
import {
  ExecutionSimulator,
  FillModel,
  IFill,
  IOrder,
  SameCandleAmbiguityMode,
} from '@quant/backtesting';
import {
  DEFAULT_PARTIAL_EXIT_POLICY,
  PositionLot,
  PositionSizer,
  TradeLifecycleManager,
} from '@quant/risk-engine';
import {
  CanonicalMLEngineV2,
  SignalGenerator,
  SnapshotBuilder,
} from '@quant/trading-engine';
import { CandidateArtifact, ShadowEvaluationMetrics, ShadowEvaluationResult } from '../types';
import { ModelRegistry } from '../model-registry';
import { CandidateBacktestRunner } from '../candidate-backtest-runner';
import {
  CandidateProductionComparison,
  DEFAULT_SHADOW_WINDOW_CONFIG,
  DriftEvent,
  ShadowAuditRecord,
  ShadowHealthState,
  ShadowLedgerData,
  ShadowObservation,
  ShadowProcessingResult,
  ShadowSignalSnapshot,
  ShadowWindowConfig,
} from './shadow-types';
import { ShadowLedger } from './shadow-ledger';
import {
  DEFAULT_PERFORMANCE_DRIFT_THRESHOLDS,
  PerformanceDriftDetector,
  PerformanceDriftThresholds,
} from './performance-drift-detector';
import {
  DEFAULT_FEATURE_DRIFT_THRESHOLDS,
  FeatureDriftBaseline,
  FeatureDriftDetector,
  FeatureDriftThresholds,
} from './feature-drift-detector';
import {
  DEFAULT_REGIME_DRIFT_THRESHOLDS,
  RegimeDriftDetector,
  RegimeDriftThresholds,
  RegimeObservation,
} from './regime-drift-detector';
import {
  DEFAULT_EXECUTION_DRIFT_THRESHOLDS,
  ExecutionDriftDetector,
  ExecutionDriftThresholds,
} from './execution-drift-detector';
import { CandidateProductionComparator } from './candidate-production-comparator';
import {
  DEFAULT_HEALTH_MACHINE_CONFIG,
  HealthMachineConfig,
  ShadowHealthMachine,
} from './shadow-health-machine';

export interface ShadowOrchestratorOptions {
  readonly windowConfig?: ShadowWindowConfig;
  readonly performanceThresholds?: PerformanceDriftThresholds;
  readonly featureThresholds?: FeatureDriftThresholds;
  readonly regimeThresholds?: RegimeDriftThresholds;
  readonly executionThresholds?: ExecutionDriftThresholds;
  readonly healthConfig?: HealthMachineConfig;
  readonly persistenceDir?: string;
  readonly enableAutomaticPaperRollback?: boolean;
}

interface ActiveCandidateContext {
  readonly candidateId: string;
  readonly artifact: CandidateArtifact;
  readonly ledger: ShadowLedger;
  readonly execSim: ExecutionSimulator;
  readonly candles: ICandle[];
  readonly regimeHistory: RegimeObservation[];
  readonly featureVectors: number[][];
  activeLot: PositionLot | null;
  featureBaseline?: FeatureDriftBaseline;
  baselineMetrics: {
    expectancyR: number;
    winRate: number;
    profitFactor: number;
    maxDrawdownR?: number;
  };
  referenceRegime: {
    volatilityRegime: 'LOW_VOLATILITY' | 'NORMAL_VOLATILITY' | 'HIGH_VOLATILITY';
    trendRegime?: 'TRENDING_BULLISH' | 'TRENDING_BEARISH' | 'RANGING';
  };
  tradeCounter: number;
}

export class ShadowOrchestrator {
  // STRICT SAFETY GUARANTEE: LIVE TRADING MODIFICATION IS PERMANENTLY DISABLED IN SHADOW ORCHESTRATOR
  public static readonly AUTOMATIC_LIVE_TRADING_ROLLBACK_ENABLED = false;
  public static readonly AUTOMATIC_LIVE_PROMOTION_ENABLED = false;

  private readonly activeCandidates: Map<string, ActiveCandidateContext> = new Map();
  private readonly options: ShadowOrchestratorOptions;

  constructor(options: ShadowOrchestratorOptions = {}) {
    this.options = {
      windowConfig: DEFAULT_SHADOW_WINDOW_CONFIG,
      performanceThresholds: DEFAULT_PERFORMANCE_DRIFT_THRESHOLDS,
      featureThresholds: DEFAULT_FEATURE_DRIFT_THRESHOLDS,
      regimeThresholds: DEFAULT_REGIME_DRIFT_THRESHOLDS,
      executionThresholds: DEFAULT_EXECUTION_DRIFT_THRESHOLDS,
      healthConfig: DEFAULT_HEALTH_MACHINE_CONFIG,
      enableAutomaticPaperRollback: true,
      ...options,
    };
  }

  /**
   * Submits resting protective stop and take profit target orders for an active position lot.
   */
  public static submitRestingExitOrders(
    execSim: ExecutionSimulator,
    lot: PositionLot,
    symbol: string,
    policy = DEFAULT_PARTIAL_EXIT_POLICY,
    timestamp: number,
  ): void {
    const isLong = lot.direction === Direction.BULLISH;
    const exitSide = isLong ? 'SELL' : 'BUY';
    const remainingQty = lot.remainingQuantity;
    if (remainingQty <= 0) return;

    const val = TradeLifecycleManager.validatePartialExitPolicy(policy);
    if (!val.isValid) {
      throw new Error(`Invalid partial exit policy: ${val.reason}`);
    }

    const existingOrders = execSim.getTradeOrders(lot.tradeId);
    const hasStop = existingOrders.some((o: IOrder) => o.orderType === 'STOP');
    const hasAlreadyTp1 = existingOrders.some((o: any) => o.exitTarget === 'TP1');
    const hasAlreadyTp2 = existingOrders.some((o: any) => o.exitTarget === 'TP2');
    const hasAlreadyTp3 = existingOrders.some((o: any) => o.exitTarget === 'TP3');

    // Restore is reconstructible: fill any missing resting order from the lot,
    // while preserving the exact orders already restored from persistence.
    if (!hasStop) {
      execSim.submitOrder({
        tradeId: lot.tradeId,
        symbol,
        side: exitSide,
        orderType: 'STOP',
        stopPrice: lot.currentStopLoss,
        quantity: remainingQty,
        timestamp,
        exitTarget: lot.currentStopLoss === lot.entryPrice ? 'TRAILING_STOP' : 'SL',
      });
    }

    const tp1Qty = Math.round(lot.initialQuantity * policy.tp1Ratio);
    const tp2Qty =
      policy.tp3Ratio > 0
        ? Math.round(lot.initialQuantity * policy.tp2Ratio)
        : lot.initialQuantity - tp1Qty;
    const tp3Qty = policy.tp3Ratio > 0 ? lot.initialQuantity - (tp1Qty + tp2Qty) : 0;

    if (!hasAlreadyTp1 && tp1Qty > 0 && typeof lot.tp1 === 'number' && lot.tp1 > 0) {
      execSim.submitOrder({
        tradeId: lot.tradeId,
        symbol,
        side: exitSide,
        orderType: 'LIMIT',
        price: lot.tp1,
        quantity: Math.min(remainingQty, tp1Qty),
        timestamp,
        exitTarget: 'TP1',
        referencePrice: lot.entryPrice,
      });
    }

    if (!hasAlreadyTp2 && tp2Qty > 0 && typeof lot.tp2 === 'number' && lot.tp2 > 0) {
      execSim.submitOrder({
        tradeId: lot.tradeId,
        symbol,
        side: exitSide,
        orderType: 'LIMIT',
        price: lot.tp2,
        quantity: Math.min(remainingQty, tp2Qty),
        timestamp,
        exitTarget: 'TP2',
      });
    }

    if (!hasAlreadyTp3 && tp3Qty > 0 && typeof lot.tp3 === 'number' && lot.tp3 > 0) {
      execSim.submitOrder({
        tradeId: lot.tradeId,
        symbol,
        side: exitSide,
        orderType: 'LIMIT',
        price: lot.tp3,
        quantity: Math.min(remainingQty, tp3Qty),
        timestamp,
        exitTarget: 'TP3',
      });
    }
  }

  /**
   * Registers and starts a candidate approved for shadow execution.
   */
  public startCandidate(
    candidateId: string,
    options?: {
      featureBaseline?: FeatureDriftBaseline;
      baselineExpectancyR?: number;
      baselineWinRate?: number;
      baselineProfitFactor?: number;
      persistenceFilePath?: string;
    },
  ): void {
    // 1. Retrieve and validate candidate artifact from ModelRegistry
    // First get raw artifact to check symbol/executionConfig before integrity validation (fail-closed on missing identity)
    const rawArtifact = ModelRegistry.getRawArtifact(candidateId);
    if (!rawArtifact) {
      throw new Error(`CANDIDATE_NOT_FOUND: Candidate artifact '${candidateId}' not found in registry`);
    }

    // 2. Resolve Dynamic Symbol & Execution Configuration (Strict Fail-Closed) — before integrity check
    const symbol =
      (rawArtifact as any).symbol ||
      (rawArtifact.executionConfig as any)?.symbol ||
      (rawArtifact.strategyConfig as any)?.symbol ||
      (rawArtifact as any).provenance?.symbol;

    if (!symbol || typeof symbol !== 'string' || symbol.trim() === '') {
      throw new Error(`MISSING_SYMBOL: Candidate '${candidateId}' artifact does not declare an authoritative symbol`);
    }

    const execConfig = rawArtifact.executionConfig as any;
    if (!execConfig) {
      throw new Error(`MISSING_EXECUTION_CONFIG: Candidate '${candidateId}' artifact is missing authoritative executionConfig`);
    }
    const fillModel = execConfig.fillModel;
    if (!fillModel) {
      throw new Error(`MISSING_FILL_MODEL: Candidate '${candidateId}' executionConfig is missing fillModel`);
    }
    if (!execConfig.ambiguityMode) {
      throw new Error(`MISSING_AMBIGUITY_MODE: Candidate '${candidateId}' executionConfig is missing ambiguityMode`);
    }
    if (typeof execConfig.latencyMs !== 'number' || !Number.isFinite(execConfig.latencyMs)) {
      throw new Error(`MISSING_LATENCY_CONFIG: Candidate '${candidateId}' executionConfig is missing latencyMs`);
    }

    // Now perform full integrity validation
    const artifact = ModelRegistry.getCandidateArtifact(candidateId);
    if (!artifact) {
      throw new Error(`CANDIDATE_NOT_FOUND: Candidate artifact '${candidateId}' not found in registry`);
    }

    if (!artifact.executionConfig) {
      throw new Error(`MISSING_EXECUTION_CONFIG: Candidate '${candidateId}' artifact does not contain executionConfig`);
    }

    const val = CandidateBacktestRunner.validateArtifactIntegrity(artifact);
    if (!val.isValid) {
      throw new Error(`ARTIFACT_INTEGRITY_VIOLATION: Candidate artifact corrupted: ${val.reason}`);
    }

    // Candidate must be in SHADOW_PENDING or SHADOW_ACTIVE
    if (artifact.status === 'SHADOW_PENDING') {
      ModelRegistry.updateCandidateStatus(
        candidateId,
        'SHADOW_ACTIVE',
        'Continuous Shadow Orchestrator started shadow stream',
      );
    } else if (artifact.status !== 'SHADOW_ACTIVE') {
      throw new Error(
        `INVALID_CANDIDATE_STATUS: Cannot start shadow on candidate with status '${artifact.status}' (must be SHADOW_PENDING or SHADOW_ACTIVE)`,
      );
    }

    const ambiguityMode = execConfig.ambiguityMode as SameCandleAmbiguityMode;
    const latency = {
      submissionLatencyMs: execConfig.latencyMs,
      processingLatencyMs: 5,
    };

    // 3. Baseline metrics check (Strict Fail-Closed)
    const baselineExpectancy =
      options?.baselineExpectancyR ??
      (artifact as any).evidence?.expectancyAfterHistorical ??
      (artifact as any).evidence?.expectancyBefore ??
      (artifact.strategyConfig as any)?.evidence?.expectancyAfterHistorical ??
      (artifact.strategyConfig as any)?.evidence?.expectancyBefore;

    if (baselineExpectancy === undefined || typeof baselineExpectancy !== 'number' || isNaN(baselineExpectancy)) {
      throw new Error(
        `SHADOW_BASELINE_MISSING: Candidate '${candidateId}' artifact is missing baseline performance evidence (expectancy)`,
      );
    }

    const baselineWinRate =
      options?.baselineWinRate ??
      (artifact as any).evidence?.winRate ??
      (artifact.strategyConfig as any)?.evidence?.winRate;
    const baselineProfitFactor =
      options?.baselineProfitFactor ??
      (artifact as any).evidence?.profitFactor ??
      (artifact.strategyConfig as any)?.evidence?.profitFactor;

    // 4. Initialize ShadowLedger
    const persistencePath =
      options?.persistenceFilePath ||
      (this.options.persistenceDir ? path.join(this.options.persistenceDir, `shadow-${candidateId}.json`) : undefined);

    const ledger = new ShadowLedger({
      candidateId: artifact.candidateId,
      candidateVersion: artifact.candidateVersion,
      strategyVersion: artifact.strategyVersion,
      featureSchemaHash: artifact.featureSchemaHash,
      artifactHash: artifact.artifactHash,
      symbol,
      persistencePath,
    });

    // 5. Initialize Authoritative ExecutionSimulator
    const execSim = new ExecutionSimulator(
      fillModel,
      ambiguityMode,
      latency,
      `shadow_${candidateId}`,
    );

    // 6. Restore persisted state and pending orders into ExecutionSimulator
    const recoveredCandles = [...ledger.getRecentCandles()];
    const frozenLot = ledger.getActiveLot();
    const recoveredActiveLot = frozenLot ? ShadowOrchestrator.thawPositionLot(frozenLot) : null;
    const recoveredRegimeHistory = [...ledger.getRegimeHistory()];
    const recoveredFeatureVectors = [...ledger.getFeatureVectors().map((v) => [...v])];
    const recoveredPendingOrders = [...ledger.getPendingOrders()];
    execSim.restoreOrders(recoveredPendingOrders);

    if (recoveredActiveLot && recoveredActiveLot.remainingQuantity > 0) {
      const partialPolicy = (artifact.riskConfig as any)?.partialExitPolicy || DEFAULT_PARTIAL_EXIT_POLICY;
      ShadowOrchestrator.submitRestingExitOrders(
        execSim,
        recoveredActiveLot,
        symbol,
        partialPolicy,
        ledger.getLastMarketTimestamp() || Date.now(),
      );
      const liveOrders = execSim.getTradeOrders(recoveredActiveLot.tradeId);
      ShadowOrchestrator.validateRestoredExecutionState(
        recoveredActiveLot,
        liveOrders,
        symbol,
        partialPolicy,
      );
    }

    const context: ActiveCandidateContext = {
      candidateId,
      artifact,
      ledger,
      execSim,
      candles: recoveredCandles,
      regimeHistory: recoveredRegimeHistory,
      featureVectors: recoveredFeatureVectors,
      activeLot: recoveredActiveLot,
      featureBaseline: options?.featureBaseline,
      baselineMetrics: {
        expectancyR: baselineExpectancy,
        winRate: typeof baselineWinRate === 'number' ? baselineWinRate : Number.NaN,
        profitFactor: typeof baselineProfitFactor === 'number' ? baselineProfitFactor : Number.NaN,
      },
      referenceRegime: {
        volatilityRegime: 'NORMAL_VOLATILITY',
        trendRegime: 'RANGING',
      },
      tradeCounter: ledger.getTrades().length,
    };

    this.activeCandidates.set(candidateId, context);

    // Emit SHADOW_STARTED audit event
    ledger.recordAuditEvent({
      eventId: `evt-start-${candidateId}-${Date.now()}`,
      candidateId,
      candidateVersion: artifact.candidateVersion,
      strategyVersion: artifact.strategyVersion,
      timestamp: Date.now(),
      marketTimestamp: ledger.getLastMarketTimestamp(),
      eventType: 'SHADOW_STARTED',
      evidenceHash: artifact.artifactHash,
      metadata: { persistencePath, symbol, recoveredObservations: ledger.getObservations().length },
    });

    ledger.saveToFile();
  }

  /**
   * Processes a newly closed market candle incrementally through the causal feature and execution pipeline.
   */
  public processCandle(
    candidateId: string,
    candle: ICandle,
    productionSignal?: ShadowSignalSnapshot,
    now = Date.now(),
  ): ShadowProcessingResult {
    const ctx = this.activeCandidates.get(candidateId);
    if (!ctx) {
      throw new Error(`CANDIDATE_NOT_ACTIVE: Candidate '${candidateId}' is not running in shadow orchestrator`);
    }

    const symbol = ctx.ledger.getSymbol();

    // 1. Strict Causal Market Candle Validation (Fail-closed)
    this.validateCandleStrict(candle, ctx.candles, symbol);

    const candleTime =
      candle.timestamp instanceof Date ? candle.timestamp.getTime() : new Date(candle.timestamp).getTime();

    // 2. Authoritative Execution Simulation on Incoming Candle Bar (Next-Candle Execution)
    // Execute pending resting orders against incoming candle before computing new close-of-candle signals
    const closedTrades: IBacktestTrade[] = [];
    const execBarRes = ctx.execSim.processSingleExecutionBar(candle);
    const newFills = execBarRes.fills;

    // Process Fills and manage Trade Lifecycles authoritatively
    const partialPolicy = (ctx.artifact.riskConfig as any)?.partialExitPolicy || DEFAULT_PARTIAL_EXIT_POLICY;

    for (const fill of newFills) {
      const order = ctx.execSim.getOrder(fill.orderId);
      if (!order) continue;

      if (order.exitTarget === 'ENTRY') {
        const isLong = order.side === 'BUY';
        const refPrice = order.referencePrice || (order as any).calculatedEntryOptimal || fill.price;
        const initialStop = (order as any).calculatedStopLoss ?? (isLong ? fill.price * 0.98 : fill.price * 1.02);

        const dummySignal: any = {
          id: order.tradeId,
          symbol,
          direction: isLong ? Direction.BULLISH : Direction.BEARISH,
          stopLoss: initialStop,
          takeProfits: {
            tp1: (order as any).calculatedTp1,
            tp2: (order as any).calculatedTp2,
            tp3: (order as any).calculatedTp3,
          },
          entryZone: { optimal: refPrice, min: refPrice, max: refPrice },
        };

        // createPositionLot returns a mutable lot; ensure it stays mutable for fill tracking
        ctx.activeLot = ShadowOrchestrator.thawPositionLot(
          TradeLifecycleManager.createPositionLot(
            dummySignal,
            fill.price,
            fill.quantity,
            fill.timestamp,
            order.orderId,
            fill.fee,
            fill.slippage,
          ),
        );

        // Submit resting exit orders (SL, TP1, TP2, TP3)
        ShadowOrchestrator.submitRestingExitOrders(
          ctx.execSim,
          ctx.activeLot,
          symbol,
          partialPolicy,
          fill.timestamp,
        );
      } else {
        // Exit order filled (SL, TP1, TP2, TP3, TRAILING_STOP)
        if (ctx.activeLot && ctx.activeLot.tradeId === order.tradeId) {
          const isLong = ctx.activeLot.direction === Direction.BULLISH;
          const fillQty = fill.quantity;
          const chunkDiff = isLong
            ? fill.price - ctx.activeLot.entryPrice
            : ctx.activeLot.entryPrice - fill.price;
          const grossPnl = Number((chunkDiff * fillQty).toFixed(2));
          const initialRiskPerUnit = Math.max(
            0.0001,
            Math.abs(ctx.activeLot.entryPrice - ctx.activeLot.initialStopLoss),
          );
          const chunkR = Number((chunkDiff / initialRiskPerUnit).toFixed(2));

          ctx.activeLot.realizedPnl = Number((ctx.activeLot.realizedPnl + grossPnl).toFixed(2));
          ctx.activeLot.remainingQuantity = Number(
            Math.max(0, ctx.activeLot.remainingQuantity - fillQty).toFixed(4),
          );

          const targetType =
            order.exitTarget ||
            (order.orderType === 'STOP'
              ? ctx.activeLot.currentStopLoss === ctx.activeLot.entryPrice
                ? 'TRAILING_STOP'
                : 'SL'
              : 'TP1');

          const newFillRecord = {
            fillId: fill.fillId,
            targetType: targetType as any,
            timestamp: fill.timestamp,
            price: fill.price,
            quantity: fillQty,
            remainingQuantity: ctx.activeLot.remainingQuantity,
            realizedPnl: grossPnl,
            realizedR: chunkR,
            fee: fill.fee,
            slippage: fill.slippage,
            exitOrderId: fill.orderId,
            exitOrderCreatedAt: fill.exitOrderCreatedAt,
            exitOrderSubmittedAt: fill.exitOrderSubmittedAt,
            exitTriggerTimestamp: fill.exitTriggerTimestamp,
            exitFillTimestamp: fill.exitFillTimestamp,
            segmentIndex: fill.segmentIndex,
            segmentType: fill.segmentType,
          };

          ctx.activeLot.partialFills = [...(ctx.activeLot.partialFills || []), newFillRecord];

          if (ctx.activeLot.remainingQuantity <= 0) {
            ctx.activeLot.status = 'CLOSED';
            ctx.activeLot.closedAt = fill.timestamp;
            ctx.activeLot.unrealizedPnl = 0;
            ctx.execSim.cancelTradeOrders(ctx.activeLot.tradeId);

            const lastFill = ctx.activeLot.partialFills[ctx.activeLot.partialFills.length - 1];

            const exitReason =
              (lastFill?.targetType as string) === 'SL' ||
              (lastFill?.targetType as string) === 'STOP' ||
              lastFill?.targetType === 'STOP_LOSS'
                ? SignalState.SL_HIT
                : (lastFill?.targetType as string) === 'TP1'
                ? SignalState.TP1_HIT
                : (lastFill?.targetType as string) === 'TP2'
                ? SignalState.TP2_HIT
                : (lastFill?.targetType as string) === 'TP3'
                ? SignalState.TP3_HIT
                : SignalState.INVALIDATED;

            const tradeRecord = TradeLifecycleManager.createCompletedTrade(
              ctx.activeLot,
              exitReason,
              String(ctx.execSim['fillModel']),
              String(ctx.execSim['ambiguityMode']),
            );

            closedTrades.push(tradeRecord);
            ctx.activeLot = null;
          } else {
            ctx.activeLot.status = 'PARTIALLY_CLOSED';
            if (targetType === 'TP1' && partialPolicy.moveStopToBreakevenOnTp1) {
              ctx.activeLot.currentStopLoss = ctx.activeLot.entryPrice;
              const slOrder = ctx.execSim.getTradeOrders(ctx.activeLot.tradeId).find((o) => o.orderType === 'STOP');
              if (slOrder) {
                slOrder.stopPrice = ctx.activeLot.entryPrice;
                (slOrder as any).exitTarget = 'TRAILING_STOP';
              }
            }
          }
        }
      }
    }

    // 3. Append Candle & Extract Causal Features / Regime
    ctx.candles.push(candle);
    const regimeObs = RegimeDriftDetector.classifyCausalRegime(ctx.candles);
    ctx.regimeHistory.push(regimeObs);

    let featureVectorHash = createHash('sha256').update(`feat_schema_${ctx.artifact.featureSchemaHash}`).digest('hex');
    let featureVector: number[] = [];

    if (ctx.candles.length >= 20) {
      try {
        const snapshot = SnapshotBuilder.buildSnapshot({
          symbol,
          executionCandles: ctx.candles,
        });
        const extracted = CanonicalMLEngineV2.extractFeatures(snapshot);
        const mlFeatures = CanonicalMLEngineV2.toArray(extracted);
        if (mlFeatures && mlFeatures.length > 0) {
          featureVector = mlFeatures;
          featureVectorHash = createHash('sha256').update(JSON.stringify(mlFeatures)).digest('hex');
          ctx.featureVectors.push(mlFeatures);
        }
      } catch {
        // Feature extraction warmup
      }
    }

    // 4. Candidate Signal Generation using Authoritative Candidate Strategy
    const candidateSignal = this.generateCandidateSignal(ctx, candle, symbol);

    // 5. Candidate vs Production Comparison (if production signal provided)
    let comparison: CandidateProductionComparison | undefined;
    let divergenceDrift: DriftEvent | undefined;
    if (productionSignal) {
      const compRes = CandidateProductionComparator.compareSignals(
        candidateId,
        candleTime,
        candidateSignal,
        productionSignal,
        now,
      );
      comparison = compRes.comparison;
      divergenceDrift = compRes.divergenceEvent;
      ctx.ledger.recordComparison(comparison);
      if (divergenceDrift) {
        ctx.ledger.recordDrifts([divergenceDrift]);
      }
    }

    // 6. Submit New Orders (if no active position and signal is directional)
    // Order submitted at candle close T will execute on candle T+1
    const newOrders: IOrder[] = [];
    if (!ctx.activeLot && (candidateSignal.direction === 'LONG' || candidateSignal.direction === 'SHORT')) {
      ctx.tradeCounter++;
      const tradeId = `shadow_trade_${candidateId}_${ctx.tradeCounter}`;
      const side = candidateSignal.direction === 'LONG' ? 'BUY' : 'SELL';
      const entryPrice = candle.close;
      const stopPrice =
        candidateSignal.stopLoss ??
        (side === 'BUY' ? entryPrice * 0.98 : entryPrice * 1.02);
      const riskPerShare = Math.abs(entryPrice - stopPrice) || 1.0;
      const capital = (ctx.artifact.riskConfig as any)?.initialCapital ?? 10000;
      const riskFraction = (ctx.artifact.riskConfig as any)?.maxRiskPerTrade ?? 0.01;
      const initialQty = Math.max(1, Math.floor((capital * riskFraction) / riskPerShare));

      const entryOrder = ctx.execSim.submitOrder({
        tradeId,
        symbol,
        side,
        orderType: 'MARKET',
        price: entryPrice,
        quantity: initialQty,
        timestamp: candleTime,
        exitTarget: 'ENTRY',
      });
      (entryOrder as any).calculatedStopLoss = stopPrice;
      (entryOrder as any).calculatedTp1 = candidateSignal.targets?.tp1 ?? candidateSignal.takeProfit;
      (entryOrder as any).calculatedTp2 = candidateSignal.targets?.tp2;
      (entryOrder as any).calculatedTp3 = candidateSignal.targets?.tp3;
      newOrders.push(entryOrder);
    }

    // 7. Record in ShadowLedger
    const observation: ShadowObservation = {
      candidateId,
      candidateVersion: ctx.artifact.candidateVersion,
      strategyVersion: ctx.artifact.strategyVersion,
      timestamp: now,
      marketTimestamp: candleTime,
      featureVectorHash,
      featureSchemaHash: ctx.artifact.featureSchemaHash,
      features: featureVector.length > 0 ? featureVector : undefined,
      signal: candidateSignal,
      execution:
        newFills.length > 0
          ? {
              orderId: newFills[0].orderId,
              fillId: newFills[0].fillId,
              filledPrice: newFills[0].price,
              quantity: newFills[0].quantity,
              fees: newFills[0].fee,
              slippage: newFills[0].slippage,
            }
          : undefined,
    };

    ctx.ledger.recordObservation(observation);
    if (newOrders.length > 0) ctx.ledger.recordOrders(newOrders);
    if (newFills.length > 0) ctx.ledger.recordFills(newFills);
    if (closedTrades.length > 0) ctx.ledger.recordClosedTrades(closedTrades);

    // 8. Rolling Window & Multi-Tier Drift Detection
    const detectedDrifts: DriftEvent[] = [];

    // A. Performance Drift
    const rollingShort = ctx.ledger.computeRollingMetrics(
      'SHORT',
      this.options.windowConfig?.shortWindowSize || 20,
      ctx.baselineMetrics.expectancyR,
      ctx.baselineMetrics.winRate,
    );
    if (rollingShort) {
      const perfDrifts = PerformanceDriftDetector.evaluatePerformanceDrift(
        candidateId,
        rollingShort,
        ctx.baselineMetrics,
        this.options.performanceThresholds,
        now,
      );
      detectedDrifts.push(...perfDrifts);
    }

    // B. Feature Drift
    if (ctx.featureBaseline && ctx.featureVectors.length >= 25) {
      const featDrifts = FeatureDriftDetector.evaluateFeatureDrift(
        candidateId,
        ctx.featureVectors.slice(-50),
        ctx.artifact.featureSchemaHash,
        ctx.featureBaseline,
        this.options.featureThresholds,
        candleTime,
        now,
      );
      detectedDrifts.push(...featDrifts);
    }

    // C. Regime Drift
    if (ctx.regimeHistory.length >= 20) {
      const regDrifts = RegimeDriftDetector.evaluateRegimeDrift(
        candidateId,
        ctx.regimeHistory.slice(-50),
        ctx.referenceRegime,
        this.options.regimeThresholds,
        now,
      );
      detectedDrifts.push(...regDrifts);
    }

    // D. Execution Drift
    if (ctx.ledger.getTrades().length >= 10) {
      const execDrifts = ExecutionDriftDetector.evaluateExecutionDrift(
        candidateId,
        ctx.ledger.getTrades().slice(-30),
        ctx.ledger.getFills().slice(-60),
        this.options.executionThresholds,
        now,
      );
      detectedDrifts.push(...execDrifts);
    }

    if (detectedDrifts.length > 0) {
      ctx.ledger.recordDrifts(detectedDrifts);
    }

    // 9. Health State Machine Evaluation
    const prevHealth = ctx.ledger.getHealthState();
    const nextHealth = ShadowHealthMachine.evaluateNextState(
      prevHealth,
      ctx.ledger.getObservations().length,
      ctx.ledger.getTrades().length,
      ctx.ledger.getDrifts(),
      this.options.healthConfig,
      now,
    );
    ctx.ledger.setHealthState(nextHealth);

    // 10. Automated Paper Rollback upon FAILED state
    if (nextHealth.status === 'FAILED' && prevHealth.status !== 'FAILED') {
      this.executePaperRollback(ctx, nextHealth.statusReason || 'CRITICAL_DRIFT_FAILURE', now);
    }

    // 11. Audit event emission
    if (closedTrades.length > 0) {
      ctx.ledger.recordAuditEvent({
        eventId: `evt-trade-close-${candidateId}-${candleTime}`,
        candidateId,
        candidateVersion: ctx.artifact.candidateVersion,
        strategyVersion: ctx.artifact.strategyVersion,
        timestamp: now,
        marketTimestamp: candleTime,
        eventType: 'SHADOW_TRADE_CLOSED',
        evidenceHash: createHash('sha256').update(JSON.stringify(closedTrades)).digest('hex'),
        metadata: { tradeCount: closedTrades.length, pnl: closedTrades[0].pnl },
      });
    }

    if (nextHealth.status !== prevHealth.status) {
      const eventType =
        nextHealth.status === 'DEGRADED'
          ? 'SHADOW_DEGRADED'
          : nextHealth.status === 'HEALTHY'
          ? 'SHADOW_RECOVERED'
          : nextHealth.status === 'FAILED'
          ? 'SHADOW_FAILED'
          : 'SHADOW_OBSERVATION';

      ctx.ledger.recordAuditEvent({
        eventId: `evt-health-${candidateId}-${candleTime}-${nextHealth.status}`,
        candidateId,
        candidateVersion: ctx.artifact.candidateVersion,
        strategyVersion: ctx.artifact.strategyVersion,
        timestamp: now,
        marketTimestamp: candleTime,
        eventType,
        evidenceHash: createHash('sha256').update(`${candidateId}|${nextHealth.status}|${candleTime}`).digest('hex'),
        metadata: { previousStatus: prevHealth.status, newStatus: nextHealth.status, reason: nextHealth.statusReason },
      });
    }

    // 12. Atomic persistence to disk including restart state and pending orders
    ctx.ledger.setActiveLot(ctx.activeLot);
    ctx.ledger.setPendingOrders(ctx.execSim.getAllOrders().filter((o) => o.status === 'PENDING'));
    ctx.ledger.setRecentCandles(ctx.candles.slice(-100));
    ctx.ledger.setRegimeHistory(ctx.regimeHistory.slice(-50));
    ctx.ledger.setFeatureVectors(ctx.featureVectors.slice(-50));
    ctx.ledger.saveToFile();

    return {
      candidateId,
      marketTimestamp: candleTime,
      observation,
      newOrders,
      newFills,
      closedTrades,
      openPositionsCount: ctx.activeLot ? 1 : 0,
      healthState: nextHealth,
      activeDrifts: detectedDrifts,
      comparisonWithProduction: comparison,
    };
  }

  /**
   * Generates authoritative structured ShadowEvaluationResult for PromotionGate verification.
   */
  public evaluateCandidate(candidateId: string, now = Date.now()): ShadowEvaluationResult {
    const ctx = this.activeCandidates.get(candidateId);
    if (!ctx) {
      throw new Error(`CANDIDATE_NOT_ACTIVE: Candidate '${candidateId}' is not active in orchestrator`);
    }

    const health = ctx.ledger.getHealthState();
    const baselineComplete =
      Number.isFinite(ctx.baselineMetrics.expectancyR) &&
      Number.isFinite(ctx.baselineMetrics.winRate) &&
      Number.isFinite(ctx.baselineMetrics.profitFactor);
    const trades = ctx.ledger.getTrades();
    const observations = ctx.ledger.getObservations();
    const allFills = ctx.ledger.getFills();

    const startTimestamp = observations.length > 0 ? observations[0].marketTimestamp : 0;
    const endTimestamp = observations.length > 0 ? observations[observations.length - 1].marketTimestamp : 0;

    const rMultiples = trades.map((t) => t.pnlRMultiple || 0);
    const wins = trades.filter((t) => t.pnl > 0);
    const losses = trades.filter((t) => t.pnl < 0);
    const grossProfit = wins.reduce((sum, t) => sum + t.pnl, 0);
    const grossLoss = losses.reduce((sum, t) => sum + Math.abs(t.pnl), 0);
    const totalPnL = Number(trades.reduce((sum, t) => sum + t.pnl, 0).toFixed(2));
    const winRate = trades.length > 0 ? Number(((wins.length / trades.length) * 100).toFixed(1)) : 0;
    const expectancyR = trades.length > 0 ? Number((rMultiples.reduce((sum, r) => sum + r, 0) / trades.length).toFixed(3)) : 0;
    const medianR = ctx.ledger.calculateMedianR();
    const profitFactor =
      grossLoss === 0
        ? grossProfit > 0
          ? Infinity
          : 0
        : Number((grossProfit / grossLoss).toFixed(2));

    let peakR = 0;
    let currentR = 0;
    let maxDrawdownR = 0;
    for (const r of rMultiples) {
      currentR += r;
      if (currentR > peakR) peakR = currentR;
      const dd = peakR - currentR;
      if (dd > maxDrawdownR) maxDrawdownR = dd;
    }

    // Authoritative calculations directly from ledger without synthetic placeholders
    const totalFees =
      Number(allFills.reduce((sum, f) => sum + (f.fee || 0), 0).toFixed(2)) ||
      Number(trades.reduce((sum, t) => sum + (t.exitFees || 0) + (t.entryFees || 0), 0).toFixed(2));
    const totalSlippage =
      Number(allFills.reduce((sum, f) => sum + (f.slippage || 0), 0).toFixed(2)) ||
      Number(trades.reduce((sum, t) => sum + (t.exitSlippage || 0) + (t.entrySlippage || 0), 0).toFixed(2));
    const pnlValues = trades.map((t) => t.pnl);
    const largestLoss = pnlValues.length > 0 ? Number(Math.min(0, ...pnlValues).toFixed(2)) : 0;
    const largestWin = pnlValues.length > 0 ? Number(Math.max(0, ...pnlValues).toFixed(2)) : 0;

    const metrics: ShadowEvaluationMetrics = {
      totalTrades: trades.length,
      wins: wins.length,
      losses: losses.length,
      winRate,
      grossPnL: Number(grossProfit.toFixed(2)),
      netPnL: totalPnL,
      pnlR: Number(rMultiples.reduce((s, r) => s + r, 0).toFixed(2)),
      profitFactor,
      maxDrawdown: Number(maxDrawdownR.toFixed(2)),
      maxDrawdownR: Number(maxDrawdownR.toFixed(2)),
      expectancy: expectancyR,
      averageR: expectancyR,
      medianR,
      largestLoss,
      largestWin,
      fees: totalFees,
      slippage: totalSlippage,
      observationsCount: observations.length,
    };

    const isHealthy =
      baselineComplete &&
      health.status === 'HEALTHY' &&
      trades.length >= (this.options.windowConfig?.minTradesForEvaluation || 10);
    const sampleInsufficient = trades.length < (this.options.windowConfig?.minTradesForEvaluation || 10);
    const reasons: string[] = [];
    if (!baselineComplete) {
      reasons.push('SHADOW_BASELINE_MISSING: immutable baseline evidence is incomplete');
    } else if (isHealthy) {
      reasons.push('Shadow candidate maintained healthy performance, feature stability, and zero critical drift');
    }

    const shadowDatasetHash = ctx.ledger.getShadowDatasetHash();
    const marketDatasetHash = ctx.artifact.marketDatasetHash || ctx.artifact.datasetHash || shadowDatasetHash;

    return {
      candidateId,
      passed: isHealthy,
      metrics,
      reasons,
      rejectionReason: !isHealthy
        ? sampleInsufficient
          ? 'INSUFFICIENT_SAMPLE_SIZE'
          : !baselineComplete
          ? 'SHADOW_BASELINE_MISSING'
          : health.statusReason || `Shadow candidate is not healthy (status: ${health.status})`
        : undefined,
      window: {
        candidateId,
        marketDatasetHash,
        startTimestamp,
        endTimestamp,
        minimumObservations: this.options.windowConfig?.minObservationsForEvaluation || 30,
        minimumTrades: this.options.windowConfig?.minTradesForEvaluation || 10,
      },
      shadowDatasetHash,
      shadowStartTimestamp: startTimestamp,
      shadowEndTimestamp: endTimestamp,
      evaluatedAt: now,
    };
  }

  /**
   * Gracefully stops a candidate.
   */
  public stopCandidate(candidateId: string, reason: string, now = Date.now()): void {
    const ctx = this.activeCandidates.get(candidateId);
    if (!ctx) return;

    // Cancel all orders in ExecutionSimulator and clear lot
    ctx.execSim.cancelAllOrders();
    ctx.activeLot = null;
    ctx.ledger.setActiveLot(null);
    ctx.ledger.setPendingOrders([]);

    ctx.ledger.setHealthState({
      ...ctx.ledger.getHealthState(),
      status: 'STOPPED',
      statusReason: `STOPPED: ${reason}`,
      updatedAt: now,
    });

    ctx.ledger.recordAuditEvent({
      eventId: `evt-stop-${candidateId}-${now}`,
      candidateId,
      candidateVersion: ctx.artifact.candidateVersion,
      strategyVersion: ctx.artifact.strategyVersion,
      timestamp: now,
      marketTimestamp: ctx.ledger.getLastMarketTimestamp(),
      eventType: 'SHADOW_STOPPED',
      evidenceHash: createHash('sha256').update(`${candidateId}|STOPPED|${now}`).digest('hex'),
      metadata: { reason },
    });

    ctx.ledger.saveToFile();
    this.activeCandidates.delete(candidateId);
  }

  public getCandidateLedger(candidateId: string): ShadowLedger | undefined {
    return this.activeCandidates.get(candidateId)?.ledger;
  }

  /**
   * Returns a fully mutable deep copy of a PositionLot, unfreezing all nested arrays and objects.
   */
  public static thawPositionLot(lot: Readonly<PositionLot>): PositionLot {
    return {
      ...lot,
      partialFills: lot.partialFills ? lot.partialFills.map((f) => ({ ...f })) : [],
      events: (lot as any).events ? [...(lot as any).events] : [],
      entrySnapshot: lot.entrySnapshot ? { ...lot.entrySnapshot } : undefined,
    } as PositionLot;
  }

  public static validateRestoredExecutionState(
    lot: Readonly<PositionLot>,
    orders: readonly IOrder[],
    symbol: string,
    policy = DEFAULT_PARTIAL_EXIT_POLICY,
  ): void {
    const seenTargets = new Set<string>();
    for (const order of orders) {
      if (order.tradeId !== lot.tradeId || order.symbol !== symbol || order.quantity <= 0) {
        throw new Error(`SHADOW_EXECUTION_STATE_MISMATCH: Restored order identity or quantity does not match active lot`);
      }
      if (order.exitTarget && seenTargets.has(order.exitTarget)) {
        throw new Error(`SHADOW_EXECUTION_STATE_MISMATCH: Duplicate restored exit target '${order.exitTarget}'`);
      }
      if (order.exitTarget) seenTargets.add(order.exitTarget);
    }

    const stopOrder = orders.find((order) => order.orderType === 'STOP');
    if (!stopOrder || stopOrder.quantity !== lot.remainingQuantity) {
      throw new Error(`SHADOW_EXECUTION_STATE_MISMATCH: Restored protective stop does not cover remaining quantity`);
    }

    const filledTargets = new Set(lot.partialFills.map((fill) => fill.targetType));
    const targetOrders: Array<{ target: 'TP1' | 'TP2' | 'TP3'; price: number; ratio: number }> = [
      { target: 'TP1', price: lot.tp1, ratio: policy.tp1Ratio },
      { target: 'TP2', price: lot.tp2, ratio: policy.tp2Ratio },
      { target: 'TP3', price: lot.tp3, ratio: policy.tp3Ratio },
    ];
    for (const target of targetOrders) {
      if (filledTargets.has(target.target) || target.ratio <= 0) continue;
      const order = orders.find((candidate) => candidate.exitTarget === target.target);
      if (order && order.price !== target.price) {
        throw new Error(`SHADOW_EXECUTION_STATE_MISMATCH: Restored ${target.target} price does not match active lot`);
      }
    }
  }

  private validateCandleStrict(candle: ICandle, candleHistory: readonly ICandle[], expectedSymbol?: string): void {
    if (!candle || typeof candle !== 'object') {
      throw new Error('INVALID_CANDLE: Candle object is undefined or null');
    }

    const candleSym = (candle as any).symbol;
    if (candleSym && expectedSymbol && candleSym !== expectedSymbol) {
      throw new Error(`SYMBOL_MISMATCH: Candle symbol '${candleSym}' does not match expected '${expectedSymbol}'`);
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
      throw new Error('INVALID_CANDLE_OHLC: Non-finite or NaN numeric price detected');
    }

    if (high < low || close < low || close > high || open < low || open > high) {
      throw new Error(`INVALID_CANDLE_BOUNDS: High (${high}) < Low (${low}) or Open/Close outside bounds`);
    }

    const candleTime = timestamp instanceof Date ? timestamp.getTime() : new Date(timestamp).getTime();
    if (Number.isNaN(candleTime) || candleTime <= 0) {
      throw new Error('INVALID_CANDLE_TIMESTAMP: Invalid timestamp value');
    }

    if (candleHistory.length > 0) {
      const prev = candleHistory[candleHistory.length - 1];
      const prevTime = prev.timestamp instanceof Date ? prev.timestamp.getTime() : new Date(prev.timestamp).getTime();
      if (candleTime === prevTime) {
        throw new Error(`DUPLICATE_CANDLE_TIMESTAMP: Duplicate candle timestamp ${candleTime} rejected`);
      }
      if (candleTime < prevTime) {
        throw new Error(
          `TIMESTAMP_REGRESSION: Out-of-order candle timestamp ${candleTime} < previous timestamp ${prevTime}`,
        );
      }
    }
  }

  private generateCandidateSignal(
    ctx: ActiveCandidateContext,
    candle: ICandle,
    symbol: string,
  ): ShadowSignalSnapshot {
    if (ctx.candles.length < 15) {
      return { direction: 'FLAT' };
    }

    // Extract candidate strategy configuration
    const strategyConfig = {
      ...(ctx.artifact.strategyConfig || {}),
      ...(ctx.artifact.executionConfig || {}),
      minMtfScore: ctx.artifact.executionConfig?.minMtfScore,
      stopLossAtrMultiplier: ctx.artifact.executionConfig?.stopLossAtrMultiplier,
      sizingMultiplier: ctx.artifact.executionConfig?.sizingMultiplier,
      highVolatilitySizingMultiplier: ctx.artifact.executionConfig?.highVolatilitySizingMultiplier,
      minProbability: ctx.artifact.executionConfig?.minProbability,
      filterRegime: ctx.artifact.executionConfig?.filterRegime,
      regimeMode: ctx.artifact.executionConfig?.regimeMode,
      modelArtifact: ctx.artifact.modelArtifact,
      scalerArtifact: ctx.artifact.scalerArtifact,
      modelWeights: (ctx.artifact as any).modelWeights || (ctx.artifact.modelArtifact as any)?.weights,
    };

    const signalSetup = SignalGenerator.generateSignal({
      symbol,
      executionCandles: ctx.candles,
      strategyConfig,
      scoringWeights: (ctx.artifact.strategyConfig as any)?.scoringWeights,
      minimumCandles: 15,
    });

    const isLong = signalSetup.direction === Direction.BULLISH;
    const isShort = signalSetup.direction === Direction.BEARISH;
    const requiredScore = typeof ctx.artifact.executionConfig?.minMtfScore === 'number' ? ctx.artifact.executionConfig.minMtfScore : 65;
    const isActionable = (isLong || isShort) && signalSetup.score >= requiredScore;

    const direction: 'LONG' | 'SHORT' | 'FLAT' = isActionable ? (isLong ? 'LONG' : 'SHORT') : 'FLAT';
    const confidence = signalSetup.score ? Math.min(1.0, signalSetup.score / 100) : 0.65;

    return {
      direction,
      confidence,
      score: signalSetup.score,
      stopLoss: signalSetup.stopLoss,
      takeProfit: signalSetup.takeProfits?.tp1,
      targets: signalSetup.takeProfits,
      regime: ctx.regimeHistory.length > 0 ? ctx.regimeHistory[ctx.regimeHistory.length - 1].volatilityRegime : undefined,
    };
  }

  private executePaperRollback(ctx: ActiveCandidateContext, reason: string, now: number): void {
    if (!this.options.enableAutomaticPaperRollback) return;

    // 1. Cancel active paper position and pending orders in ExecutionSimulator and ledger
    ctx.execSim.cancelAllOrders();
    ctx.activeLot = null;
    ctx.ledger.setActiveLot(null);
    ctx.ledger.setPendingOrders([]);

    // 2. Mark candidate REJECTED in ModelRegistry
    try {
      ModelRegistry.updateCandidateStatus(
        ctx.candidateId,
        'REJECTED',
        `AUTOMATIC_PAPER_ROLLBACK: ${reason}`,
      );
    } catch {
      // Status update recorded
    }

    // 3. Record PAPER_ROLLBACK audit event
    ctx.ledger.recordAuditEvent({
      eventId: `evt-rollback-${ctx.candidateId}-${now}`,
      candidateId: ctx.candidateId,
      candidateVersion: ctx.artifact.candidateVersion,
      strategyVersion: ctx.artifact.strategyVersion,
      timestamp: now,
      marketTimestamp: ctx.ledger.getLastMarketTimestamp(),
      eventType: 'PAPER_ROLLBACK',
      evidenceHash: createHash('sha256').update(`${ctx.candidateId}|PAPER_ROLLBACK|${reason}|${now}`).digest('hex'),
      metadata: { reason, liveMoneyModified: false },
    });
  }
}
