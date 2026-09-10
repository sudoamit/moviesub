import * as path from 'path';
import { createHash } from 'crypto';
import { Direction, IBacktestTrade, ICandle, ISignalSetup, SignalState } from '@quant/shared';
import {
  ExecutionSimulator,
  FillModel,
  IFill,
  IOrder,
  SameCandleAmbiguityMode,
} from '@quant/backtesting';
import {
  DEFAULT_PARTIAL_EXIT_POLICY,
  IPartialExitPolicy,
  PositionLot,
  PositionSizer,
  TradeLifecycleManager,
} from '@quant/risk-engine';
import {
  CanonicalMLEngineV2,
  SignalGenerator,
  SnapshotBuilder,
} from '@quant/trading-engine';
import { CandidateArtifact, ShadowEvaluationMetrics, ShadowEvaluationResult, ValidatedCandidateArtifact } from '../types';
import { ModelRegistry } from '../model-registry';
import { CandidateBacktestRunner } from '../candidate-backtest-runner';
import { CandidateArtifactValidator } from '../candidate-artifact-validator';
import { canonicalJsonStringify } from '../canonical-serializer';
import {
  CandidateProductionComparison,
  DEFAULT_SHADOW_WINDOW_CONFIG,
  DriftEvent,
  ShadowAuditRecord,
  ShadowEvaluationEvidence,
  ShadowMarketData,
  ShadowObservation,
  ShadowProcessingResult,
  ShadowSignalSnapshot,
  ShadowStateSnapshot,
  ShadowWindowConfig,
  validateShadowMarketData,
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
  readonly maxAllowedGapMs?: number;
}

interface ActiveCandidateContext {
  readonly candidateId: string;
  readonly artifact: ValidatedCandidateArtifact;
  readonly ledger: ShadowLedger;
  readonly execSim: ExecutionSimulator;
  readonly candles: ICandle[];
  readonly regimeHistory: RegimeObservation[];
  readonly featureVectors: number[][];
  readonly pendingEntrySignals: Map<string, ISignalSetup>;
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
  readonly windowConfig: ShadowWindowConfig;
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
    policy: IPartialExitPolicy = DEFAULT_PARTIAL_EXIT_POLICY,
    timestamp: number,
  ): IOrder[] {
    const isLong = lot.direction === Direction.BULLISH;
    const exitSide = isLong ? 'SELL' : 'BUY';
    const remainingQty = lot.remainingQuantity;
    if (remainingQty <= 0) return [];

    const val = TradeLifecycleManager.validatePartialExitPolicy(policy);
    if (!val.isValid) {
      throw new Error(`Invalid partial exit policy: ${val.reason}`);
    }

    const createdOrders: IOrder[] = [];
    const existingOrders = execSim.getTradeOrders(lot.tradeId);
    const hasStop = existingOrders.some((o: IOrder) => o.orderType === 'STOP');
    const hasAlreadyTp1 = existingOrders.some((o: any) => o.exitTarget === 'TP1');
    const hasAlreadyTp2 = existingOrders.some((o: any) => o.exitTarget === 'TP2');
    const hasAlreadyTp3 = existingOrders.some((o: any) => o.exitTarget === 'TP3');

    const filledTargets = new Set((lot.partialFills || []).map((fill) => fill.targetType));
    const hasFilledTp1 = filledTargets.has('TP1');
    const hasFilledTp2 = filledTargets.has('TP2');
    const hasFilledTp3 = filledTargets.has('TP3');

    // Restore is reconstructible: fill any missing resting order from the lot,
    // while preserving the exact orders already restored from persistence.
    if (!hasStop) {
      const stopOrder = execSim.submitOrder({
        tradeId: lot.tradeId,
        symbol,
        side: exitSide,
        orderType: 'STOP',
        stopPrice: lot.currentStopLoss,
        quantity: remainingQty,
        timestamp,
        exitTarget: lot.currentStopLoss === lot.entryPrice ? 'TRAILING_STOP' : 'SL',
      });
      createdOrders.push(stopOrder);
    }

    const tp1Qty = Math.round(lot.initialQuantity * policy.tp1Ratio);
    const tp2Qty =
      policy.tp3Ratio > 0
        ? Math.round(lot.initialQuantity * policy.tp2Ratio)
        : lot.initialQuantity - tp1Qty;
    const tp3Qty = policy.tp3Ratio > 0 ? lot.initialQuantity - (tp1Qty + tp2Qty) : 0;

    if (!hasAlreadyTp1 && !hasFilledTp1 && tp1Qty > 0 && typeof lot.tp1 === 'number' && lot.tp1 > 0) {
      const tp1Order = execSim.submitOrder({
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
      createdOrders.push(tp1Order);
    }

    if (!hasAlreadyTp2 && !hasFilledTp2 && tp2Qty > 0 && typeof lot.tp2 === 'number' && lot.tp2 > 0) {
      const tp2Order = execSim.submitOrder({
        tradeId: lot.tradeId,
        symbol,
        side: exitSide,
        orderType: 'LIMIT',
        price: lot.tp2,
        quantity: Math.min(remainingQty, tp2Qty),
        timestamp,
        exitTarget: 'TP2',
      });
      createdOrders.push(tp2Order);
    }

    if (!hasAlreadyTp3 && !hasFilledTp3 && tp3Qty > 0 && typeof lot.tp3 === 'number' && lot.tp3 > 0) {
      const tp3Order = execSim.submitOrder({
        tradeId: lot.tradeId,
        symbol,
        side: exitSide,
        orderType: 'LIMIT',
        price: lot.tp3,
        quantity: Math.min(remainingQty, tp3Qty),
        timestamp,
        exitTarget: 'TP3',
      });
      createdOrders.push(tp3Order);
    }

    return createdOrders;
  }

  /**
   * Registers and starts a candidate approved for shadow execution.
   * Consumes strictly ValidatedCandidateArtifact (either directly or via ModelRegistry).
   */
  public startCandidate(
    candidate: string | ValidatedCandidateArtifact,
    options?: {
      featureBaseline?: FeatureDriftBaseline;
      baselineExpectancyR?: number;
      baselineWinRate?: number;
      baselineProfitFactor?: number;
      persistenceFilePath?: string;
    },
  ): void {
    let candidateId: string;
    let validatedArtifact: ValidatedCandidateArtifact;

    if (typeof candidate === 'string') {
      candidateId = candidate;
      const rawArtifact = ModelRegistry.getCandidateArtifact(candidateId) || ModelRegistry.getRawArtifact(candidateId);
      if (!rawArtifact) {
        throw new Error(`CANDIDATE_NOT_FOUND: Candidate artifact '${candidateId}' not found in registry`);
      }
      if (!rawArtifact.executionConfig) {
        throw new Error(`MISSING_EXECUTION_CONFIG: Candidate '${candidateId}' artifact is missing authoritative executionConfig`);
      }
      validatedArtifact = CandidateArtifactValidator.validate(rawArtifact);
    } else {
      if (!candidate || typeof candidate !== 'object' || !('executionConfig' in candidate) || !candidate.executionConfig) {
        throw new Error(`MISSING_EXECUTION_CONFIG: Candidate artifact is missing authoritative executionConfig`);
      }
      validatedArtifact = CandidateArtifactValidator.validate(candidate);
      candidateId = validatedArtifact.candidateId;
    }

    const symbol = validatedArtifact.symbol;
    const execConfig = validatedArtifact.executionConfig;
    const fillModel = execConfig.fillModel;
    const ambiguityMode = execConfig.ambiguityMode as SameCandleAmbiguityMode;
    const latency = {
      submissionLatencyMs: execConfig.latencyMs,
      processingLatencyMs: 5,
    };

    // Candidate must be in SHADOW_PENDING or SHADOW_ACTIVE
    if (validatedArtifact.status === 'SHADOW_PENDING') {
      try {
        ModelRegistry.updateCandidateStatus(
          candidateId,
          'SHADOW_ACTIVE',
          'Continuous Shadow Orchestrator started shadow stream',
        );
      } catch {
        // Continue if running in standalone test mode
      }
    } else if (validatedArtifact.status !== 'SHADOW_ACTIVE') {
      throw new Error(
        `INVALID_CANDIDATE_STATUS: Cannot start shadow on candidate with status '${validatedArtifact.status}' (must be SHADOW_PENDING or SHADOW_ACTIVE)`,
      );
    }

    // Initialize ShadowLedger FIRST so we can read persisted baseline/regime/signals if present
    const persistencePath =
      options?.persistenceFilePath ||
      (this.options.persistenceDir ? path.join(this.options.persistenceDir, `shadow-${candidateId}.json`) : undefined);

    const ledger = new ShadowLedger({
      candidateId: validatedArtifact.candidateId,
      candidateVersion: validatedArtifact.candidateVersion,
      strategyVersion: validatedArtifact.strategyVersion,
      featureSchemaHash: validatedArtifact.featureSchemaHash,
      artifactHash: validatedArtifact.artifactHash,
      symbol,
      persistencePath,
    });

    // Risk Configuration Validation (Strict Fail-Closed — No synthetic defaults)
    const riskCfg = validatedArtifact.riskConfig;
    if (typeof riskCfg.initialCapital !== 'number' || !Number.isFinite(riskCfg.initialCapital) || riskCfg.initialCapital <= 0) {
      throw new Error(`SHADOW_RISK_CONFIG_MISSING: Candidate '${candidateId}' riskConfig is missing valid initialCapital`);
    }
    if (typeof riskCfg.maxRiskPerTrade !== 'number' || !Number.isFinite(riskCfg.maxRiskPerTrade) || riskCfg.maxRiskPerTrade <= 0) {
      throw new Error(`SHADOW_RISK_CONFIG_MISSING: Candidate '${candidateId}' riskConfig is missing valid maxRiskPerTrade`);
    }
    const partialPolicyVal = TradeLifecycleManager.validatePartialExitPolicy(riskCfg.partialExitPolicy);
    if (!partialPolicyVal.isValid) {
      throw new Error(`SHADOW_RISK_CONFIG_MISSING: Candidate '${candidateId}' partialExitPolicy is invalid: ${partialPolicyVal.reason}`);
    }

    // Baseline metrics check (Strict Fail-Closed — Check options -> persisted ledger -> candidate artifact evidence)
    const persistedBaselines = ledger.getBaselineMetrics();
    const evidence = validatedArtifact.evidence as Record<string, unknown> | undefined;
    const baselineExpectancy =
      options?.baselineExpectancyR ??
      persistedBaselines?.expectancyR ??
      (typeof evidence?.expectancyAfterHistorical === 'number' ? evidence.expectancyAfterHistorical : undefined) ??
      (typeof evidence?.expectancyBefore === 'number' ? evidence.expectancyBefore : undefined);

    if (baselineExpectancy === undefined || typeof baselineExpectancy !== 'number' || !Number.isFinite(baselineExpectancy)) {
      throw new Error(
        `SHADOW_BASELINE_MISSING: Candidate '${candidateId}' artifact is missing baseline performance evidence (expectancy)`,
      );
    }

    const baselineWinRate =
      options?.baselineWinRate ??
      persistedBaselines?.winRate ??
      (typeof evidence?.winRate === 'number' ? evidence.winRate : undefined);

    if (baselineWinRate === undefined || typeof baselineWinRate !== 'number' || !Number.isFinite(baselineWinRate)) {
      throw new Error(
        `SHADOW_BASELINE_MISSING: Candidate '${candidateId}' artifact is missing baseline performance evidence (winRate)`,
      );
    }

    const baselineProfitFactor =
      options?.baselineProfitFactor ??
      persistedBaselines?.profitFactor ??
      (typeof evidence?.profitFactor === 'number' ? evidence.profitFactor : undefined);

    if (baselineProfitFactor === undefined || typeof baselineProfitFactor !== 'number' || !Number.isFinite(baselineProfitFactor)) {
      throw new Error(
        `SHADOW_BASELINE_MISSING: Candidate '${candidateId}' artifact is missing baseline performance evidence (profitFactor)`,
      );
    }

    // Feature baseline resolution
    const featureBaseline = options?.featureBaseline ?? ledger.getFeatureBaseline();

    // Reference regime validation from options / persisted ledger / immutable candidate evidence with robust normalization
    const persistedRefRegime = ledger.getReferenceRegime();
    const rawRefRegime =
      persistedRefRegime ??
      (evidence?.referenceRegime as Record<string, unknown> | undefined) ??
      (evidence?.primaryRegime as Record<string, unknown> | undefined);

    if (!rawRefRegime || !rawRefRegime.volatilityRegime) {
      throw new Error(
        `REFERENCE_REGIME_MISSING: Candidate '${candidateId}' artifact is missing immutable reference regime evidence (volatilityRegime and trendRegime required)`,
      );
    }

    const volStr = String(rawRefRegime.volatilityRegime).toUpperCase();
    let normalizedVol: 'NORMAL_VOLATILITY' | 'LOW_VOLATILITY' | 'HIGH_VOLATILITY';
    if (volStr === 'NORMAL' || volStr === 'NORMAL_VOLATILITY') {
      normalizedVol = 'NORMAL_VOLATILITY';
    } else if (volStr === 'LOW' || volStr === 'LOW_VOLATILITY') {
      normalizedVol = 'LOW_VOLATILITY';
    } else if (volStr === 'HIGH' || volStr === 'HIGH_VOLATILITY') {
      normalizedVol = 'HIGH_VOLATILITY';
    } else {
      throw new Error(`INVALID_REFERENCE_REGIME: Unsupported volatility regime '${volStr}'`);
    }

    const trendStr = rawRefRegime.trendRegime ? String(rawRefRegime.trendRegime).toUpperCase() : undefined;
    let normalizedTrend: 'TRENDING_BULLISH' | 'TRENDING_BEARISH' | 'RANGING' | undefined;
    if (trendStr) {
      if (trendStr === 'BULLISH' || trendStr === 'TRENDING_BULLISH') {
        normalizedTrend = 'TRENDING_BULLISH';
      } else if (trendStr === 'BEARISH' || trendStr === 'TRENDING_BEARISH') {
        normalizedTrend = 'TRENDING_BEARISH';
      } else if (trendStr === 'RANGING') {
        normalizedTrend = 'RANGING';
      } else {
        throw new Error(`INVALID_REFERENCE_REGIME: Unsupported trend regime '${trendStr}'`);
      }
    }

    const referenceRegime = {
      volatilityRegime: normalizedVol,
      trendRegime: normalizedTrend,
    };

    // Store baseline metrics, feature baseline, reference regime, and windowConfig in ledger for self-contained restart
    ledger.setBaselineMetrics({
      expectancyR: baselineExpectancy,
      winRate: baselineWinRate,
      profitFactor: baselineProfitFactor,
    });
    if (featureBaseline) {
      ledger.setFeatureBaseline(featureBaseline);
    }
    ledger.setReferenceRegime(referenceRegime);

    // Strict windowConfig resolution (Options -> Persisted Ledger -> Candidate Artifact -> Canonical Default)
    let resolvedWindowConfig: ShadowWindowConfig;
    if (this.options.windowConfig) {
      resolvedWindowConfig = this.options.windowConfig;
    } else if (ledger.getWindowConfig()) {
      resolvedWindowConfig = ledger.getWindowConfig()!;
    } else if (evidence && typeof evidence.windowConfig === 'object' && evidence.windowConfig !== null) {
      resolvedWindowConfig = evidence.windowConfig as ShadowWindowConfig;
    } else {
      resolvedWindowConfig = DEFAULT_SHADOW_WINDOW_CONFIG;
    }

    if (
      !resolvedWindowConfig ||
      typeof resolvedWindowConfig.shortWindowSize !== 'number' ||
      !Number.isFinite(resolvedWindowConfig.shortWindowSize) ||
      resolvedWindowConfig.shortWindowSize <= 0 ||
      typeof resolvedWindowConfig.mediumWindowSize !== 'number' ||
      !Number.isFinite(resolvedWindowConfig.mediumWindowSize) ||
      resolvedWindowConfig.mediumWindowSize <= 0 ||
      typeof resolvedWindowConfig.longWindowSize !== 'number' ||
      !Number.isFinite(resolvedWindowConfig.longWindowSize) ||
      resolvedWindowConfig.longWindowSize <= 0
    ) {
      throw new Error(`INVALID_SHADOW_WINDOW_CONFIG: Candidate '${candidateId}' has invalid window configuration`);
    }
    ledger.setWindowConfig(resolvedWindowConfig);

    // Initialize Authoritative ExecutionSimulator
    const execSim = new ExecutionSimulator(
      fillModel as FillModel,
      ambiguityMode,
      latency,
      `shadow_${candidateId}`,
    );

    // Restore persisted state, fills, pending orders, and pending entry signals into ExecutionSimulator & context
    const recoveredCandles = [...ledger.getRecentCandles()];
    const frozenLot = ledger.getActiveLot();
    const recoveredActiveLot = frozenLot ? ShadowOrchestrator.thawPositionLot(frozenLot) : null;
    const recoveredRegimeHistory = [...ledger.getRegimeHistory()];
    const recoveredFeatureVectors = [...ledger.getFeatureVectors().map((v) => [...v])];
    const recoveredPendingOrders = [...ledger.getPendingOrders()];
    const recoveredFills = [...ledger.getFills()];
    const recoveredSequences = ledger.getExecutionSequences();
    const recoveredPendingSignals = ledger.getPendingEntrySignals();
    if (recoveredSequences) {
      execSim.setExecutionSequences(recoveredSequences);
    }
    execSim.restoreOrders(recoveredPendingOrders);
    execSim.restoreFills(recoveredFills);

    if (recoveredActiveLot && recoveredActiveLot.remainingQuantity > 0) {
      const lastMktTs = ledger.getLastMarketTimestamp();
      if (!lastMktTs || lastMktTs <= 0) {
        throw new Error(
          `SHADOW_EXECUTION_STATE_CORRUPT: Active position lot exists in persistence for candidate '${candidateId}' but lastMarketTimestamp is missing or invalid`,
        );
      }
      ShadowOrchestrator.submitRestingExitOrders(
        execSim,
        recoveredActiveLot,
        symbol,
        validatedArtifact.riskConfig.partialExitPolicy || DEFAULT_PARTIAL_EXIT_POLICY,
        lastMktTs,
      );
    }

    // Register Active Candidate Context
    const ctx: ActiveCandidateContext = {
      candidateId,
      artifact: validatedArtifact,
      ledger,
      execSim,
      candles: recoveredCandles,
      pendingEntrySignals: recoveredPendingSignals,
      featureBaseline,
      baselineMetrics: {
        expectancyR: baselineExpectancy,
        winRate: baselineWinRate,
        profitFactor: baselineProfitFactor,
      },
      referenceRegime,
      windowConfig: resolvedWindowConfig,
      regimeHistory: recoveredRegimeHistory,
      featureVectors: recoveredFeatureVectors,
      activeLot: recoveredActiveLot,
      tradeCounter: recoveredActiveLot ? 1 : 0,
    };

    this.activeCandidates.set(candidateId, ctx);

    // Initial Shadow Audit Event with deterministic candidate/market timestamp/sequence
    const initialMarketTs = ledger.getLastMarketTimestamp() || 0;
    const seq = ledger.getAuditEvents().length + 1;
    ledger.recordAuditEvent({
      eventId: `evt_${candidateId}_SHADOW_STARTED_${initialMarketTs}_${seq}`,
      candidateId,
      candidateVersion: validatedArtifact.candidateVersion,
      strategyVersion: validatedArtifact.strategyVersion,
      timestamp: Date.now(),
      marketTimestamp: ledger.getLastMarketTimestamp(),
      eventType: 'SHADOW_STARTED',
      evidenceHash: validatedArtifact.artifactHash,
      metadata: { persistencePath, symbol, recoveredObservations: ledger.getObservations().length },
    });

    ledger.saveToFile();
  }

  /**
   * Processes an incoming batch of continuous market data (candles, optional ticks / book snapshots)
   * after validating schema, timestamp monotony, and symbol continuity.
   */
  public processMarketData(
    candidateId: string,
    marketData: ShadowMarketData,
    productionSignal?: ShadowSignalSnapshot,
    now = Date.now(),
  ): ShadowProcessingResult[] {
    const ctx = this.activeCandidates.get(candidateId);
    if (!ctx) {
      throw new Error(`CANDIDATE_NOT_ACTIVE: Candidate '${candidateId}' is not running in shadow orchestrator`);
    }

    const symbol = ctx.ledger.getSymbol();
    validateShadowMarketData(marketData, symbol);

    const results: ShadowProcessingResult[] = [];
    for (const candle of marketData.candles) {
      const res = this.processCandle(candidateId, candle, productionSignal, now);
      results.push(res);
    }
    return results;
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
    const newOrders: IOrder[] = [];
    const closedTrades: IBacktestTrade[] = [];
    const execBarRes = ctx.execSim.processSingleExecutionBar(candle);
    const newFills = execBarRes.fills;

    // Process Fills and manage Trade Lifecycles authoritatively via TradeLifecycleManager
    const partialPolicy = ctx.artifact.riskConfig.partialExitPolicy || DEFAULT_PARTIAL_EXIT_POLICY;

    for (const fill of newFills) {
      const order = ctx.execSim.getOrder(fill.orderId);
      if (!order) continue;

      if (order.exitTarget === 'ENTRY') {
        const actualSignal = ctx.pendingEntrySignals.get(order.tradeId);
        if (!actualSignal) {
          throw new Error(`MISSING_ENTRY_SIGNAL: Actual SignalGenerator output for trade '${order.tradeId}' not found`);
        }

        // Initialize authoritative PositionLot directly from actual signal setup output
        ctx.activeLot = ShadowOrchestrator.thawPositionLot(
          TradeLifecycleManager.createPositionLot(
            actualSignal,
            fill.price,
            fill.quantity,
            fill.timestamp,
            order.orderId,
            fill.fee,
            fill.slippage,
          ),
        );
        ctx.pendingEntrySignals.delete(order.tradeId);

        // Submit resting exit orders (SL, TP1, TP2, TP3)
        const restingOrders = ShadowOrchestrator.submitRestingExitOrders(
          ctx.execSim,
          ctx.activeLot,
          symbol,
          partialPolicy,
          fill.timestamp,
        );
        newOrders.push(...restingOrders);
      } else {
        // Exit order filled (SL, TP1, TP2, TP3, TRAILING_STOP)
        if (ctx.activeLot && ctx.activeLot.tradeId === order.tradeId) {
          const targetType =
            order.exitTarget ||
            (order.orderType === 'STOP'
              ? ctx.activeLot.currentStopLoss === ctx.activeLot.entryPrice
                ? 'TRAILING_STOP'
                : 'SL'
              : 'TP1');

          const exitResult = TradeLifecycleManager.processExitFill(
            ctx.activeLot,
            {
              ...fill,
              targetType,
            },
            partialPolicy,
            String(ctx.execSim['fillModel']),
            String(ctx.execSim['ambiguityMode']),
          );

          ctx.activeLot = exitResult.lot;

          if (exitResult.isBreakevenStopTriggered) {
            const slOrder = ctx.execSim.getTradeOrders(ctx.activeLot.tradeId).find((o) => o.orderType === 'STOP');
            if (slOrder) {
              slOrder.stopPrice = ctx.activeLot.entryPrice;
              slOrder.exitTarget = 'TRAILING_STOP';
            }
          }

          if (exitResult.isClosed) {
            ctx.execSim.cancelTradeOrders(ctx.activeLot.tradeId);
            if (exitResult.completedTrade) {
              closedTrades.push(exitResult.completedTrade);
            }
            ctx.activeLot = null;
          }
        }
      }
    }

    // 3. Append Candle & Extract Causal Features / Regime
    ctx.candles.push(candle);
    ctx.ledger.recordCandle(candle);
    const windowedCandles = ctx.candles.length > 100 ? ctx.candles.slice(-100) : ctx.candles;
    const regimeObs = RegimeDriftDetector.classifyCausalRegime(windowedCandles);
    ctx.regimeHistory.push(regimeObs);

    let featureVectorHash = createHash('sha256').update(`feat_schema_${ctx.artifact.featureSchemaHash}`).digest('hex');
    let featureVector: number[] = [];

    const requiredWarmup = 20;
    if (ctx.candles.length >= requiredWarmup) {
      const snapshot = SnapshotBuilder.buildSnapshot({
        symbol,
        executionCandles: windowedCandles,
      });
      const extracted = CanonicalMLEngineV2.extractFeatures(snapshot);
      const mlFeatures = CanonicalMLEngineV2.toArray(extracted);
      if (!mlFeatures || mlFeatures.length === 0) {
        throw new Error(
          `FEATURE_EXTRACTION_FAILED: Candidate '${candidateId}' produced empty feature vector after warmup (${ctx.candles.length} candles)`,
        );
      }
      featureVector = mlFeatures;
      featureVectorHash = createHash('sha256').update(canonicalJsonStringify(mlFeatures)).digest('hex');
      ctx.featureVectors.push(mlFeatures);
    }

    // 4. Candidate Signal Generation using Authoritative Candidate Strategy
    const candidateSignalRes = this.generateCandidateSignal(ctx, candle, symbol);
    const candidateSignal = candidateSignalRes.snapshot;
    const signalSetup = candidateSignalRes.signalSetup;

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
    if (!ctx.activeLot && (candidateSignal.direction === 'LONG' || candidateSignal.direction === 'SHORT')) {
      if (typeof candidateSignal.stopLoss !== 'number' || !Number.isFinite(candidateSignal.stopLoss) || candidateSignal.stopLoss <= 0) {
        throw new Error(`SHADOW_RISK_CONFIG_MISSING: Candidate '${candidateId}' directional signal is missing stopLoss`);
      }
      const tp1 = candidateSignal.targets?.tp1 ?? candidateSignal.takeProfit;
      if (typeof tp1 !== 'number' || !Number.isFinite(tp1) || tp1 <= 0) {
        throw new Error(`SHADOW_RISK_CONFIG_MISSING: Candidate '${candidateId}' directional signal is missing takeProfit target`);
      }

      ctx.tradeCounter++;
      const tradeId = `shadow_trade_${candidateId}_${ctx.tradeCounter}`;
      const side = candidateSignal.direction === 'LONG' ? 'BUY' : 'SELL';
      const entryPrice = candle.close;
      const stopPrice = candidateSignal.stopLoss;

      const riskCfg = ctx.artifact.riskConfig;
      const sizing = PositionSizer.calculatePosition({
        accountBalance: riskCfg.initialCapital,
        riskPercentage: (riskCfg.maxRiskPerTrade <= 0.2 ? riskCfg.maxRiskPerTrade * 100 : riskCfg.maxRiskPerTrade),
        entryPrice,
        stopLoss: stopPrice,
        lotSize: riskCfg.lotSize ?? 1,
        contractSize: riskCfg.contractSize ?? 1,
        maxRiskPercentage: riskCfg.maxAccountRiskLimit !== undefined ? riskCfg.maxAccountRiskLimit * 100 : undefined,
        maxLeverage: riskCfg.maxLeverage,
        regime: ctx.regimeHistory.length > 0 ? ctx.regimeHistory[ctx.regimeHistory.length - 1].volatilityRegime : undefined,
      });

      if (!sizing.isValid || sizing.roundedUnits <= 0) {
        throw new Error(`SHADOW_RISK_CONFIG_MISSING: PositionSizer failed to calculate valid position: ${sizing.rejectionReason || 'Invalid sizing'}`);
      }
      const initialQty = sizing.roundedUnits;

      if (!signalSetup) {
        throw new Error(`MISSING_SIGNAL_SETUP: Signal setup was not produced for actionable signal on trade '${tradeId}'`);
      }
      // Retain authoritative SignalGenerator setup for lifecycle lot creation on entry fill
      const actualSignalSetup: ISignalSetup = {
        ...signalSetup,
        symbol,
        id: tradeId,
      };
      ctx.pendingEntrySignals.set(tradeId, actualSignalSetup);

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

    // A. Multi-Horizon Performance Drift (SHORT, MEDIUM, LONG)
    const rollingShort = ctx.ledger.computeRollingMetrics(
      'SHORT',
      ctx.windowConfig.shortWindowSize,
      ctx.baselineMetrics.expectancyR,
      ctx.baselineMetrics.winRate,
    );
    const rollingMedium = ctx.ledger.computeRollingMetrics(
      'MEDIUM',
      ctx.windowConfig.mediumWindowSize,
      ctx.baselineMetrics.expectancyR,
      ctx.baselineMetrics.winRate,
    );
    const rollingLong = ctx.ledger.computeRollingMetrics(
      'LONG',
      ctx.windowConfig.longWindowSize,
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
    if (rollingMedium) {
      const mediumDrifts = PerformanceDriftDetector.evaluatePerformanceDrift(
        candidateId,
        rollingMedium,
        ctx.baselineMetrics,
        this.options.performanceThresholds,
        now,
      ).map((d) => ({
        ...d,
        details: `[MEDIUM_HORIZON] Persistent degradation: ${d.details}`,
      }));
      detectedDrifts.push(...mediumDrifts);
    }
    if (rollingLong) {
      const longDrifts = PerformanceDriftDetector.evaluatePerformanceDrift(
        candidateId,
        rollingLong,
        ctx.baselineMetrics,
        this.options.performanceThresholds,
        now,
      ).map((d) => ({
        ...d,
        severity: 'CRITICAL' as const,
        details: `[LONG_HORIZON] Structural degradation: ${d.details}`,
      }));
      detectedDrifts.push(...longDrifts);
    }

    // B. Feature Drift
    const isMlCandidate =
      !!ctx.artifact.modelArtifact ||
      !!ctx.artifact.scalerArtifact ||
      (Array.isArray(ctx.artifact.selectedFeatures) &&
        ctx.artifact.selectedFeatures.length > 0 &&
        ctx.artifact.selectedFeatures[0] !== 'none');

    if (isMlCandidate && !ctx.featureBaseline) {
      detectedDrifts.push({
        id: `drift_feat_unavail_${candidateId}_${candleTime}`,
        candidateId,
        type: 'FEATURE',
        severity: 'WARNING',
        timestamp: now,
        marketTimestamp: candleTime,
        metric: 'FEATURE_DRIFT_UNAVAILABLE',
        baselineValue: 0,
        observedValue: 0,
        threshold: 0,
        windowStart: candleTime,
        windowEnd: candleTime,
        evidenceHash: createHash('sha256').update(`FEATURE_DRIFT_UNAVAILABLE|${candidateId}|${candleTime}`).digest('hex'),
        details: `FEATURE_DRIFT_UNAVAILABLE: ML candidate '${candidateId}' is missing authoritative featureBaseline for drift evaluation`,
      });
    } else if (ctx.featureBaseline && ctx.featureVectors.length >= 25) {
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

    // 9. Health State Machine Evaluation (Evaluates Currently Active Drift Conditions)
    const prevHealth = ctx.ledger.getHealthState();
    // Active drifts include newly detected drifts from the current evaluation cycle
    // and any unexpired ledger drifts within the current rolling window horizon
    const activeDriftLookbackMs = this.options.healthConfig?.activeDriftLookbackMs ?? 3600000;
    const unexpiredLedgerDrifts = ctx.ledger
      .getDrifts()
      .filter((d) => Math.abs(candleTime - d.marketTimestamp) <= activeDriftLookbackMs);
    const activeDrifts = [...unexpiredLedgerDrifts, ...detectedDrifts];

    const nextHealth = ShadowHealthMachine.evaluateNextState(
      prevHealth,
      ctx.ledger.getObservations().length,
      ctx.ledger.getTrades().length,
      activeDrifts,
      this.options.healthConfig,
      now,
    );
    ctx.ledger.setHealthState(nextHealth);

    // 10. Automated Paper Rollback upon FAILED state
    if (nextHealth.status === 'FAILED' && prevHealth.status !== 'FAILED') {
      this.executePaperRollback(ctx, nextHealth.statusReason || 'CRITICAL_DRIFT_FAILURE', now);
    }

    // 11. Audit event emission with deterministic IDs
    if (closedTrades.length > 0) {
      const seq = ctx.ledger.getAuditEvents().length + 1;
      ctx.ledger.recordAuditEvent({
        eventId: `evt_${candidateId}_SHADOW_TRADE_CLOSED_${candleTime}_${seq}`,
        candidateId,
        candidateVersion: ctx.artifact.candidateVersion,
        strategyVersion: ctx.artifact.strategyVersion,
        timestamp: now,
        marketTimestamp: candleTime,
        eventType: 'SHADOW_TRADE_CLOSED',
        evidenceHash: createHash('sha256').update(canonicalJsonStringify(closedTrades)).digest('hex'),
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

      const seq = ctx.ledger.getAuditEvents().length + 1;
      ctx.ledger.recordAuditEvent({
        eventId: `evt_${candidateId}_${eventType}_${candleTime}_${seq}`,
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

    // 12. Atomic persistence to disk including restart state, pending orders, and pending entry signals
    ctx.ledger.setActiveLot(ctx.activeLot);
    ctx.ledger.setPendingOrders(ctx.execSim.getAllOrders().filter((o) => o.status === 'PENDING'));
    ctx.ledger.setPendingEntrySignals(ctx.pendingEntrySignals);
    ctx.ledger.setRecentCandles(ctx.candles.slice(-100));
    ctx.ledger.setRegimeHistory(ctx.regimeHistory.slice(-50));
    ctx.ledger.setFeatureVectors(ctx.featureVectors.slice(-50));
    ctx.ledger.setExecutionSequences(ctx.execSim.getExecutionSequences());
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

    const minObs = this.options.windowConfig?.minObservationsForEvaluation || 30;
    const minTrades = this.options.windowConfig?.minTradesForEvaluation || 10;
    const obsSufficient = observations.length >= minObs;
    const sampleInsufficient = trades.length < minTrades || !obsSufficient;

    const isMlCandidate =
      !!ctx.artifact.modelArtifact ||
      !!ctx.artifact.scalerArtifact ||
      (Array.isArray(ctx.artifact.selectedFeatures) &&
        ctx.artifact.selectedFeatures.length > 0 &&
        ctx.artifact.selectedFeatures[0] !== 'none');
    const featureBaselineMissing = isMlCandidate && !ctx.featureBaseline;

    const isHealthy =
      baselineComplete &&
      !featureBaselineMissing &&
      health.status === 'HEALTHY' &&
      !sampleInsufficient;

    const reasons: string[] = [];
    if (!baselineComplete) {
      reasons.push('SHADOW_BASELINE_MISSING: immutable baseline evidence is incomplete');
    } else if (featureBaselineMissing) {
      reasons.push('FEATURE_DRIFT_UNAVAILABLE: ML candidate is missing authoritative featureBaseline');
    } else if (isHealthy) {
      reasons.push('Shadow candidate maintained healthy performance, feature stability, and zero critical drift');
    }

    const shadowDatasetHash = ctx.ledger.getShadowDatasetHash();

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
          : featureBaselineMissing
          ? 'FEATURE_DRIFT_UNAVAILABLE'
          : health.statusReason || `Shadow candidate is not healthy (status: ${health.status})`
        : undefined,
      window: {
        candidateId,
        marketDatasetHash: shadowDatasetHash,
        startTimestamp,
        endTimestamp,
        minimumObservations: minObs,
        minimumTrades: minTrades,
      },
      shadowDatasetHash,
      shadowStartTimestamp: startTimestamp,
      shadowEndTimestamp: endTimestamp,
      evaluatedAt: now,
    };
  }

  /**
   * Generates immutable, canonical ShadowEvaluationEvidence for PromotionGate and ModelRegistry.
   */
  public generateEvaluationEvidence(candidateId: string, now = Date.now()): ShadowEvaluationEvidence {
    const ctx = this.activeCandidates.get(candidateId);
    if (!ctx) {
      throw new Error(`CANDIDATE_NOT_ACTIVE: Candidate '${candidateId}' is not active in orchestrator`);
    }

    const evalResult = this.evaluateCandidate(candidateId, now);
    const health = ctx.ledger.getHealthState();
    const drifts = ctx.ledger.getDrifts();
    const observations = ctx.ledger.getObservations();

    const startTimestamp = observations.length > 0 ? observations[0].marketTimestamp : 0;
    const endTimestamp = observations.length > 0 ? observations[observations.length - 1].marketTimestamp : 0;
    const shadowDatasetHash = ctx.ledger.getShadowDatasetHash();
    const windowConfig = ctx.ledger.getWindowConfig() || this.options.windowConfig;
    const windowConfigHash = windowConfig
      ? createHash('sha256').update(canonicalJsonStringify(windowConfig)).digest('hex')
      : undefined;

    const rawEvidence = {
      candidateId: ctx.artifact.candidateId,
      artifactHash: ctx.artifact.artifactHash,
      observationCount: observations.length,
      completedTradeCount: evalResult.metrics.totalTrades,
      evaluationStart: new Date(startTimestamp),
      evaluationEnd: new Date(endTimestamp),
      performanceMetrics: evalResult.metrics,
      featureDriftEvents: drifts.filter((d) => d.type === 'FEATURE'),
      regimeDriftEvents: drifts.filter((d) => d.type === 'REGIME'),
      executionDriftEvents: drifts.filter((d) => d.type === 'EXECUTION'),
      healthState: health,
      marketDatasetHash: shadowDatasetHash,
      shadowDatasetHash,
      windowConfigHash,
      windowConfig,
      stateHash: ctx.ledger.getStateHash(),
    };

    const evidenceHash = createHash('sha256')
      .update(canonicalJsonStringify(rawEvidence))
      .digest('hex');

    return {
      evidenceHash,
      ...rawEvidence,
    };
  }

  /**
   * Gracefully stops a candidate.
   */
  public stopCandidate(candidateId: string, reason: string, now = Date.now()): void {
    const ctx = this.activeCandidates.get(candidateId);
    if (!ctx) return;

    // Cancel all orders in ExecutionSimulator and clear lot & pending signals
    ctx.execSim.cancelAllOrders();
    ctx.activeLot = null;
    ctx.pendingEntrySignals.clear();
    ctx.ledger.setActiveLot(null);
    ctx.ledger.setPendingOrders([]);
    ctx.ledger.setPendingEntrySignals(new Map());

    ctx.ledger.setHealthState({
      ...ctx.ledger.getHealthState(),
      status: 'STOPPED',
      statusReason: `STOPPED: ${reason}`,
      updatedAt: now,
    });

    const marketTs = ctx.ledger.getLastMarketTimestamp() || 0;
    const seq = ctx.ledger.getAuditEvents().length + 1;
    ctx.ledger.recordAuditEvent({
      eventId: `evt_${candidateId}_SHADOW_STOPPED_${marketTs}_${seq}`,
      candidateId,
      candidateVersion: ctx.artifact.candidateVersion,
      strategyVersion: ctx.artifact.strategyVersion,
      timestamp: now,
      marketTimestamp: ctx.ledger.getLastMarketTimestamp(),
      eventType: 'SHADOW_STOPPED',
      evidenceHash: createHash('sha256').update(`${candidateId}|STOPPED|${now}`).digest('hex'),
      metadata: { reason },
    });

    ctx.ledger.setExecutionSequences(ctx.execSim.getExecutionSequences());
    ctx.ledger.saveToFile();
    this.activeCandidates.delete(candidateId);
  }

  public getCandidateLedger(candidateId: string): ShadowLedger | undefined {
    return this.activeCandidates.get(candidateId)?.ledger;
  }

  public getCandidateActiveLot(candidateId: string): PositionLot | null {
    return this.activeCandidates.get(candidateId)?.activeLot || null;
  }

  public getCandidateStateSnapshot(candidateId: string): ShadowStateSnapshot {
    const ctx = this.activeCandidates.get(candidateId);
    if (!ctx) {
      throw new Error(`CANDIDATE_NOT_ACTIVE: Candidate '${candidateId}' is not active in orchestrator`);
    }
    return ctx.ledger.getCanonicalStateSnapshot();
  }

  /**
   * Returns a fully mutable deep copy of a PositionLot, unfreezing all nested arrays and objects.
   */
  public static thawPositionLot(lot: Readonly<PositionLot>): PositionLot {
    return {
      ...lot,
      partialFills: lot.partialFills ? lot.partialFills.map((f) => ({ ...f })) : [],
      events: lot.events ? [...lot.events] : [],
      entrySnapshot: lot.entrySnapshot ? { ...lot.entrySnapshot } : undefined,
    } as PositionLot;
  }

  public static validateRestoredExecutionState(
    lot: Readonly<PositionLot>,
    orders: readonly IOrder[],
    symbol: string,
    policy = DEFAULT_PARTIAL_EXIT_POLICY,
  ): void {
    const exitFilledQty = (lot.partialFills || [])
      .filter((f) => f.targetType !== 'ENTRY')
      .reduce((sum, f) => sum + (f.quantity || 0), 0);
    const conservedSum = Number((exitFilledQty + lot.remainingQuantity).toFixed(4));
    const expectedInitial = Number(lot.initialQuantity.toFixed(4));
    if (conservedSum !== expectedInitial) {
      throw new Error(
        `SHADOW_EXECUTION_STATE_MISMATCH: Conservation of quantity violated: exit fills (${exitFilledQty}) + remaining (${lot.remainingQuantity}) = ${conservedSum} !== initial (${expectedInitial})`,
      );
    }

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

    const candleSym = 'symbol' in candle && typeof candle.symbol === 'string' ? candle.symbol : undefined;
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
      if (this.options.maxAllowedGapMs) {
        const delta = candleTime - prevTime;
        if (delta > this.options.maxAllowedGapMs) {
          throw new Error(
            `MARKET_DATA_GAP: Candle timestamp gap ${delta}ms exceeds maximum allowed threshold ${this.options.maxAllowedGapMs}ms`,
          );
        }
      }
    }
  }

  private generateCandidateSignal(
    ctx: ActiveCandidateContext,
    candle: ICandle,
    symbol: string,
  ): { snapshot: ShadowSignalSnapshot; signalSetup?: ISignalSetup } {
    const stratCfg = (ctx.artifact.strategyConfig || {}) as Record<string, unknown>;
    const execCfg = (ctx.artifact.executionConfig || {}) as Record<string, unknown>;
    const modelArt = (ctx.artifact.modelArtifact || {}) as Record<string, unknown>;

    const hasDet = !!(stratCfg.deterministicSignal || stratCfg.deterministicSignals);
    if (!hasDet && ctx.candles.length < 15) {
      return {
        snapshot: { direction: 'FLAT' },
      };
    }

    // Extract candidate strategy configuration
    const strategyConfig = {
      ...stratCfg,
      ...execCfg,
      deterministicSignal: stratCfg.deterministicSignal,
      deterministicSignals: stratCfg.deterministicSignals,
      minMtfScore: ctx.artifact.executionConfig?.minMtfScore,
      stopLossAtrMultiplier: ctx.artifact.executionConfig?.stopLossAtrMultiplier,
      sizingMultiplier: ctx.artifact.executionConfig?.sizingMultiplier,
      highVolatilitySizingMultiplier: ctx.artifact.executionConfig?.highVolatilitySizingMultiplier,
      minProbability: ctx.artifact.executionConfig?.minProbability,
      filterRegime: ctx.artifact.executionConfig?.filterRegime,
      regimeMode: ctx.artifact.executionConfig?.regimeMode,
      modelArtifact: ctx.artifact.modelArtifact,
      scalerArtifact: ctx.artifact.scalerArtifact,
      modelWeights: (ctx.artifact as unknown as Record<string, unknown>).modelWeights || modelArt.weights,
    };

    const signalSetup = SignalGenerator.generateSignal({
      symbol,
      executionCandles: ctx.candles.length > 200 ? ctx.candles.slice(-200) : ctx.candles,
      strategyConfig,
      scoringWeights: stratCfg.scoringWeights as Record<string, number> | undefined,
      minimumCandles: hasDet ? 1 : 15,
    });

    const isLong = signalSetup.direction === Direction.BULLISH;
    const isShort = signalSetup.direction === Direction.BEARISH;
    const rawRequiredScore =
      ctx.artifact.executionConfig?.minMtfScore ??
      (typeof stratCfg.minMtfScore === 'number' ? stratCfg.minMtfScore : undefined) ??
      (typeof execCfg.minScore === 'number' ? execCfg.minScore : undefined) ??
      (typeof stratCfg.minScore === 'number' ? stratCfg.minScore : undefined);

    if (!hasDet && (typeof rawRequiredScore !== 'number' || !Number.isFinite(rawRequiredScore))) {
      throw new Error(
        `MISSING_MIN_MTF_SCORE: Candidate '${ctx.candidateId}' artifact is missing required minMtfScore in execution/strategy configuration`,
      );
    }
    const requiredScore = typeof rawRequiredScore === 'number' ? rawRequiredScore : 0;
    const isActionable = (isLong || isShort) && signalSetup.score >= requiredScore;

    const direction: 'LONG' | 'SHORT' | 'FLAT' = isActionable ? (isLong ? 'LONG' : 'SHORT') : 'FLAT';
    const confidence =
      typeof signalSetup.score === 'number' && !Number.isNaN(signalSetup.score)
        ? Math.min(1.0, Math.max(0.0, signalSetup.score / 100))
        : undefined;

    return {
      snapshot: {
        direction,
        confidence,
        score: signalSetup.score,
        stopLoss: signalSetup.stopLoss,
        takeProfit: signalSetup.takeProfits?.tp1,
        targets: signalSetup.takeProfits,
        regime: ctx.regimeHistory.length > 0 ? ctx.regimeHistory[ctx.regimeHistory.length - 1].volatilityRegime : undefined,
      },
      signalSetup,
    };
  }

  private executePaperRollback(ctx: ActiveCandidateContext, reason: string, now: number): void {
    if (!this.options.enableAutomaticPaperRollback) return;

    // 1. Cancel active paper position, pending orders, and pending signals in ExecutionSimulator and ledger
    ctx.execSim.cancelAllOrders();
    ctx.activeLot = null;
    ctx.pendingEntrySignals.clear();
    ctx.ledger.setActiveLot(null);
    ctx.ledger.setPendingOrders([]);
    ctx.ledger.setPendingEntrySignals(new Map());

    // 2. Mark candidate REJECTED in ModelRegistry (strict fail-closed)
    try {
      ModelRegistry.updateCandidateStatus(
        ctx.candidateId,
        'REJECTED',
        `AUTOMATIC_PAPER_ROLLBACK: ${reason}`,
      );
    } catch (err: any) {
      throw new Error(`PAPER_ROLLBACK_PERSISTENCE_FAILURE: Failed to persist candidate rollback status: ${err.message}`);
    }

    // 3. Record PAPER_ROLLBACK audit event
    const marketTs = ctx.ledger.getLastMarketTimestamp() || 0;
    const seq = ctx.ledger.getAuditEvents().length + 1;
    ctx.ledger.recordAuditEvent({
      eventId: `evt_${ctx.candidateId}_PAPER_ROLLBACK_${marketTs}_${seq}`,
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
