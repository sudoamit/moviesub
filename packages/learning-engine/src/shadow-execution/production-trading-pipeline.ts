import { createHash, randomUUID } from 'crypto';
import {
  ICandle,
  Timeframe,
  Direction,
  SignalGrade,
  IPositionSizing,
  ISignalSetup
} from '@quant/shared';
import {
  SignalGenerator,
  FeatureVectorExtractor,
  TradeFeatureVector,
  CanonicalMLEngineV2,
  FEATURE_SCHEMA_VERSION
} from '@quant/trading-engine';
import { PositionSizer, ICalculatePositionOptions } from '@quant/risk-engine';
import {
  MarketSnapshot,
  PortfolioSnapshot,
  DecisionContext,
  TradingDecision,
  TradingAction,
  ChampionChallengerDecisionPair,
  ModelIdentity,
  MarketSnapshotInstrument,
  MarketSnapshotOHLCV
} from './types';
import { ILiveExecutionPort, IShadowExecutionPort, assertLiveExecution, assertShadowExecution } from './safety-guard';
import {
  createMarketSnapshot,
  createPortfolioSnapshot,
  computeDecisionFingerprint,
  validatePointInTimeSimultaneity,
  createDecisionPair
} from './shadow-decision-orchestrator';
import { IShadowExecutionStore } from './shadow-execution-store';
import { deepFreeze } from '../champion-challenger/evaluation-identity';
import { canonicalJsonStringify } from '../canonical-serializer';

export type ModelPredictionResult = {
  readonly action?: TradingAction;
  readonly confidence?: number;
  readonly probabilityWin?: number;
  readonly expectedR?: number;
  readonly filterPassed?: boolean;
};

export interface ProductionPipelineConfig {
  readonly store: IShadowExecutionStore;
  readonly liveExecutionPort?: ILiveExecutionPort;
  readonly shadowExecutionPort: IShadowExecutionPort;
  readonly championModel: ModelIdentity;
  readonly challengerModel: ModelIdentity;
  readonly championModelEvaluator?: (features: TradeFeatureVector, signal: ISignalSetup) => ModelPredictionResult | Promise<ModelPredictionResult>;
  readonly challengerModelEvaluator?: (features: TradeFeatureVector, signal: ISignalSetup) => ModelPredictionResult | Promise<ModelPredictionResult>;
  readonly strategyConfig?: Record<string, any>;
  readonly challengerStrategyConfig?: Record<string, any>;
  readonly riskConfig?: {
    readonly riskPercentage?: number;
    readonly maxRiskPercentage?: number;
    readonly maxLeverage?: number;
    readonly lotSize?: number;
  };
  readonly executionConfigVersion?: string;
  readonly executionConfigHash?: string;
  readonly riskConfigVersion?: string;
  readonly riskConfigHash?: string;
  readonly costConfigVersion?: string;
  readonly costConfigHash?: string;
  readonly strategyVersion?: string;
  readonly strategyConfigHash?: string;
  readonly challengerStrategyConfigHash?: string;
  readonly featureVersion?: string;
  readonly featureSchemaHash?: string;
  readonly maxAllowedSkewMs?: number;
}

export interface LiveMarketEvent {
  readonly symbol: string;
  readonly market?: string;
  readonly candles: ICandle[];
  readonly executionTimeframe?: Timeframe | string;
  readonly timestamp: number;
  readonly bid: number;
  readonly ask: number;
  readonly volume: number;
  readonly dataSource?: string;
  readonly dataVersion?: string;
  readonly snapshotId?: string;
  readonly tickSize?: number;
  readonly lotSize?: number;
}

export interface LivePortfolioAccountState {
  readonly portfolioId: string;
  readonly cash: number;
  readonly equity: number;
  readonly openPositions: Array<{ symbol: string; size: number; entryPrice: number }>;
  readonly timestamp: number;
}

/**
 * ProductionTradingPipeline
 * The authoritative point-in-time production entrypoint connecting Market Events
 * through existing Feature/Signal Pipeline, Model Evaluation, Phase 7 RiskEngine,
 * and Live vs Shadow Execution Boundaries.
 */
export class ProductionTradingPipeline {
  private readonly config: ProductionPipelineConfig;

  constructor(config: ProductionPipelineConfig) {
    if (!config.store) {
      throw new Error('INVALID_PIPELINE_CONFIG: store is required');
    }
    if (!config.shadowExecutionPort) {
      throw new Error('INVALID_PIPELINE_CONFIG: shadowExecutionPort is required');
    }
    if (!config.championModel) {
      throw new Error('INVALID_PIPELINE_CONFIG: championModel identity is required');
    }
    if (!config.challengerModel) {
      throw new Error('INVALID_PIPELINE_CONFIG: challengerModel identity is required');
    }
    this.config = config;
  }

  /**
   * Authoritative entrypoint called by the production system upon receipt of market event / candles.
   */
  public async processMarketEvent(
    event: LiveMarketEvent,
    portfolioState: LivePortfolioAccountState
  ): Promise<{ championDecision: TradingDecision; pairPromise: Promise<ChampionChallengerDecisionPair> }> {
    if (!event || !event.candles || event.candles.length === 0) {
      throw new Error('INVALID_MARKET_EVENT: candles are required');
    }
    if (!portfolioState) {
      throw new Error('INVALID_PORTFOLIO_STATE: portfolio state is required');
    }

    const tStart = performance.now();
    const lastCandle = event.candles[event.candles.length - 1];
    const eventTime = event.timestamp || (lastCandle.timestamp instanceof Date ? lastCandle.timestamp.getTime() : new Date(lastCandle.timestamp).getTime());

    // 1. Create Point-In-Time MarketSnapshot
    const instrument: MarketSnapshotInstrument = {
      symbol: event.symbol.toUpperCase(),
      market: event.market || 'BINANCE_SPOT',
      tickSize: event.tickSize || 0.1,
      lotSize: event.lotSize || 0.001,
    };

    const ohlcv: MarketSnapshotOHLCV = {
      open: lastCandle.open,
      high: lastCandle.high,
      low: lastCandle.low,
      close: lastCandle.close,
      volume: lastCandle.volume,
    };

    const marketSnapshot = createMarketSnapshot({
      snapshotId: event.snapshotId,
      instrument,
      timestamp: eventTime,
      ohlcv,
      bid: event.bid,
      ask: event.ask,
      volume: event.volume,
      dataSource: event.dataSource || 'production-feed',
      dataVersion: event.dataVersion || '1.0',
    });

    // 2. Check Idempotency at persistent boundary
    const existingPair = this.config.store.getDecisionPairBySnapshotAndModel(
      marketSnapshot.snapshotId,
      this.config.challengerModel.modelId
    ) || this.config.store.getDecisionPairBySnapshot(marketSnapshot.snapshotId);

    if (existingPair) {
      return {
        championDecision: existingPair.championDecision,
        pairPromise: Promise.resolve(existingPair),
      };
    }

    // 3. Create Point-In-Time PortfolioSnapshot
    const portfolioSnapshot = createPortfolioSnapshot({
      portfolioId: portfolioState.portfolioId,
      timestamp: portfolioState.timestamp,
      cash: portfolioState.cash,
      equity: portfolioState.equity,
      openPositionsCount: portfolioState.openPositions.length,
    });

    // 4. Enforce Point-In-Time Simultaneity & Validate Temporal Boundaries
    const decisionTimestamp = Date.now();
    validatePointInTimeSimultaneity({
      marketSnapshot,
      portfolioSnapshot,
      featureDataCutoff: marketSnapshot.timestamp,
      decisionTimestamp,
      maxAllowedSkewMs: this.config.maxAllowedSkewMs,
    });

    // 5. Audit Persistence upfront before live execution
    this.config.store.saveSnapshot(marketSnapshot);

    // 6. Pre-Execution Reservation / Concurrency Lock (prevents parallel duplicate live orders)
    const acquired = this.config.store.reserveExecution(
      marketSnapshot.snapshotId,
      this.config.championModel.modelId
    );

    if (!acquired) {
      const existing = this.config.store.getDecisionPairBySnapshotAndModel(
        marketSnapshot.snapshotId,
        this.config.challengerModel.modelId
      ) || this.config.store.getDecisionPairBySnapshot(marketSnapshot.snapshotId);

      if (existing) {
        return {
          championDecision: existing.championDecision,
          pairPromise: Promise.resolve(existing),
        };
      }
      throw new Error(`CONCURRENT_EXECUTION_LOCK_ACQUIRED: Snapshot ${marketSnapshot.snapshotId} is already executing in another worker`);
    }

    this.config.store.updateReservationStatus(
      marketSnapshot.snapshotId,
      this.config.championModel.modelId,
      'EXECUTING'
    );

    // 7. Base strategy & feature signal generation
    const champSignal = SignalGenerator.generateSignal({
      symbol: event.symbol,
      executionCandles: event.candles,
      executionTimeframe: event.executionTimeframe || Timeframe.M15,
      asOfTimestamp: new Date(marketSnapshot.timestamp),
      strategyConfig: this.config.strategyConfig,
    });

    // 8. Real Point-in-Time Feature Extraction & Cryptographic Feature-Input Hashing
    const fStart = performance.now();
    const tradeFeatures = FeatureVectorExtractor.extract({
      signal: champSignal,
      candles: event.candles,
      asOfTimestamp: new Date(marketSnapshot.timestamp),
    });
    const fEnd = performance.now();
    const featureLatencyMs = Math.max(0.01, Number((fEnd - fStart).toFixed(3)));

    const featureInputHash = createHash('sha256')
      .update(canonicalJsonStringify(tradeFeatures))
      .digest('hex');

    const featureVersion = this.config.featureVersion || FEATURE_SCHEMA_VERSION;
    const featureSchemaHash = this.config.featureSchemaHash || 'fhash_schema_default';
    const strategyVersion = this.config.strategyVersion || 'v1.0';
    const strategyConfigHash = this.config.strategyConfigHash || 'shash_strat_default';
    const challengerStrategyConfigHash = this.config.challengerStrategyConfigHash || (
      this.config.challengerStrategyConfig
        ? createHash('sha256').update(canonicalJsonStringify(this.config.challengerStrategyConfig)).digest('hex')
        : strategyConfigHash
    );
    const executionConfigVersion = this.config.executionConfigVersion || 'e1.0';
    const executionConfigHash = this.config.executionConfigHash || 'ehash_exec_default';
    const riskConfigVersion = this.config.riskConfigVersion || 'r1.0';
    const riskConfigHash = this.config.riskConfigHash || 'rhash_risk_default';
    const costConfigVersion = this.config.costConfigVersion || 'c1.0';
    const costConfigHash = this.config.costConfigHash || 'chash_cost_default';
    const portfolioStateVersion = 'port_v1.0';

    // 9. Deterministic Replay Decision IDs
    const champDecisionId = `dec_champ_${createHash('sha256').update(`${marketSnapshot.snapshotHash}:${this.config.championModel.modelId}:${this.config.championModel.modelVersion}`).digest('hex').slice(0, 16)}`;
    const challDecisionId = `dec_chall_${createHash('sha256').update(`${marketSnapshot.snapshotHash}:${this.config.challengerModel.modelId}:${this.config.challengerModel.modelVersion}`).digest('hex').slice(0, 16)}`;

    // 10. Champion Decision Context (with capability to LiveExecutionPort)
    const champContext: DecisionContext = deepFreeze({
      decisionId: champDecisionId,
      snapshotId: marketSnapshot.snapshotId,
      snapshotHash: marketSnapshot.snapshotHash,
      portfolioSnapshot,
      decisionTimestamp,
      instrument,
      marketSnapshot,
      featureVersion,
      featureSchemaHash,
      featureInputHash,
      featureDataCutoff: marketSnapshot.timestamp,
      strategyVersion,
      strategyConfigHash,
      executionConfigVersion,
      executionConfigHash,
      riskConfigVersion,
      riskConfigHash,
      costConfigVersion,
      costConfigHash,
      portfolioStateVersion,
      portfolioStateHash: portfolioSnapshot.portfolioStateHash,
      modelIdentity: this.config.championModel,
      evaluationFingerprint: `efp_champ_${this.config.championModel.modelId}`,
      mode: 'LIVE',
      modelRole: 'CHAMPION',
    });

    // 11. Challenger Decision Context (Shadow Mode Only with distinct config hashes)
    const challContext: DecisionContext = deepFreeze({
      decisionId: challDecisionId,
      snapshotId: marketSnapshot.snapshotId,
      snapshotHash: marketSnapshot.snapshotHash,
      portfolioSnapshot,
      decisionTimestamp,
      instrument,
      marketSnapshot,
      featureVersion,
      featureSchemaHash,
      featureInputHash,
      featureDataCutoff: marketSnapshot.timestamp,
      strategyVersion,
      strategyConfigHash: challengerStrategyConfigHash,
      executionConfigVersion,
      executionConfigHash,
      riskConfigVersion,
      riskConfigHash,
      costConfigVersion,
      costConfigHash,
      portfolioStateVersion,
      portfolioStateHash: portfolioSnapshot.portfolioStateHash,
      modelIdentity: this.config.challengerModel,
      evaluationFingerprint: `efp_chall_${this.config.challengerModel.modelId}`,
      mode: 'SHADOW',
      modelRole: 'CHALLENGER',
    });

    // 12. CRITICAL PATH: Real Champion Model Inference & Risk Engine Integration
    const mChampStart = performance.now();
    let champAction: TradingAction = champSignal.direction === Direction.BULLISH
      ? 'BUY'
      : champSignal.direction === Direction.BEARISH
        ? 'SELL'
        : 'HOLD';

    let champConfidence = champSignal.score / 100;

    let championDecision: TradingDecision;

    try {
      if (this.config.championModelEvaluator) {
        const pred = await Promise.resolve(this.config.championModelEvaluator(tradeFeatures, champSignal));
        if (pred) {
          if (pred.action) champAction = pred.action;
          if (typeof pred.confidence === 'number') champConfidence = pred.confidence;
        }
      }
      const mChampEnd = performance.now();
      const champModelLatencyMs = Math.max(0.01, Number((mChampEnd - mChampStart).toFixed(3)));

      let champPositionSize = 0;
      let champRiskAmount = 0;

      if (champAction === 'BUY' || champAction === 'SELL') {
        const sizing = PositionSizer.calculatePosition({
          accountBalance: portfolioSnapshot.equity,
          riskPercentage: this.config.riskConfig?.riskPercentage ?? 1.0,
          entryPrice: champSignal.entryZone?.optimal ?? lastCandle.close,
          stopLoss: champSignal.stopLoss,
          lotSize: this.config.riskConfig?.lotSize ?? 1,
          maxRiskPercentage: this.config.riskConfig?.maxRiskPercentage ?? 2.5,
          maxLeverage: this.config.riskConfig?.maxLeverage ?? 10,
        });

        if (sizing.isValid) {
          champPositionSize = sizing.roundedUnits;
          champRiskAmount = sizing.riskAmount;
        }
      }

      const champReason = (champSignal.reasons || [champSignal.reasoning?.summary || 'SMC signal']).join('; ');
      const champEntry = champSignal.entryZone?.optimal ?? lastCandle.close;
      const champStop = champSignal.stopLoss;
      const champTP = champSignal.takeProfits?.tp1 ?? 0;

      const champFingerprint = computeDecisionFingerprint({
        modelIdentity: this.config.championModel,
        snapshotId: marketSnapshot.snapshotId,
        snapshotHash: marketSnapshot.snapshotHash,
        portfolioStateHash: portfolioSnapshot.portfolioStateHash,
        featureVersion,
        featureSchemaHash,
        featureInputHash,
        featureDataCutoff: marketSnapshot.timestamp,
        strategyConfigHash,
        executionConfigHash,
        riskConfigHash,
        costConfigHash,
        action: champAction,
        signal: champSignal.state,
        entryPrice: champEntry,
        stopLoss: champStop,
        takeProfit: champTP,
        positionSize: champPositionSize,
        riskAmount: champRiskAmount,
      });

      championDecision = deepFreeze({
        decisionId: champContext.decisionId,
        action: champAction,
        confidence: champConfidence,
        signal: champSignal.state,
        entryPrice: champEntry,
        stopLoss: champStop,
        takeProfit: champTP,
        positionSize: champPositionSize,
        riskAmount: champRiskAmount,
        reason: champReason,
        decisionFingerprint: champFingerprint,
        latencies: {
          marketTimestamp: marketSnapshot.timestamp,
          featureStartTimestamp: decisionTimestamp,
          featureEndTimestamp: decisionTimestamp + Math.round(featureLatencyMs),
          modelStartTimestamp: decisionTimestamp + Math.round(featureLatencyMs),
          modelEndTimestamp: decisionTimestamp + Math.round(featureLatencyMs + champModelLatencyMs),
          decisionTimestamp,
          dataToDecisionLatencyMs: Math.max(1, Math.round(performance.now() - tStart)),
          featureLatencyMs,
          modelLatencyMs: champModelLatencyMs,
          totalDecisionLatencyMs: Math.max(1, Math.round(featureLatencyMs + champModelLatencyMs)),
        },
        context: champContext,
      });

      // 13. Champion Live Execution (if action is BUY/SELL and live port configured)
      if (this.config.liveExecutionPort && (champAction === 'BUY' || champAction === 'SELL')) {
        assertLiveExecution(champContext, this.config.liveExecutionPort);
        this.config.store.updateReservationStatus(
          marketSnapshot.snapshotId,
          this.config.championModel.modelId,
          'LIVE_SUBMITTED'
        );
        await Promise.resolve(this.config.liveExecutionPort.submitLiveOrder(championDecision));
        this.config.store.commitExecution(
          marketSnapshot.snapshotId,
          this.config.championModel.modelId
        );
      } else {
        this.config.store.commitExecution(
          marketSnapshot.snapshotId,
          this.config.championModel.modelId
        );
      }
    } catch (err) {
      this.config.store.releaseExecution(
        marketSnapshot.snapshotId,
        this.config.championModel.modelId,
        'FAILED_RETRYABLE'
      );
      throw err;
    }

    // 14. ASYNC ISOLATED PATH: Challenger Evaluation (runs in background with Shadow port only)
    const shadowPort = this.config.shadowExecutionPort;
    const pairPromise = (async () => {
      try {
        const challSignal = SignalGenerator.generateSignal({
          symbol: event.symbol,
          executionCandles: event.candles,
          executionTimeframe: event.executionTimeframe || Timeframe.M15,
          asOfTimestamp: new Date(marketSnapshot.timestamp),
          strategyConfig: this.config.challengerStrategyConfig || this.config.strategyConfig,
        });

        const mChallStart = performance.now();
        let challAction: TradingAction = challSignal.direction === Direction.BULLISH
          ? 'BUY'
          : challSignal.direction === Direction.BEARISH
            ? 'SELL'
            : 'HOLD';

        let challConfidence = challSignal.score / 100;

        if (this.config.challengerModelEvaluator) {
          const pred = await Promise.resolve(this.config.challengerModelEvaluator(tradeFeatures, challSignal));
          if (pred) {
            if (pred.action) challAction = pred.action;
            if (typeof pred.confidence === 'number') challConfidence = pred.confidence;
          }
        }
        const mChallEnd = performance.now();
        const challModelLatencyMs = Math.max(0.01, Number((mChallEnd - mChallStart).toFixed(3)));

        let challPositionSize = 0;
        let challRiskAmount = 0;

        if (challAction === 'BUY' || challAction === 'SELL') {
          const sizing = PositionSizer.calculatePosition({
            accountBalance: portfolioSnapshot.equity,
            riskPercentage: this.config.riskConfig?.riskPercentage ?? 1.0,
            entryPrice: challSignal.entryZone?.optimal ?? lastCandle.close,
            stopLoss: challSignal.stopLoss,
            lotSize: this.config.riskConfig?.lotSize ?? 1,
            maxRiskPercentage: this.config.riskConfig?.maxRiskPercentage ?? 2.5,
            maxLeverage: this.config.riskConfig?.maxLeverage ?? 10,
          });

          if (sizing.isValid) {
            challPositionSize = sizing.roundedUnits;
            challRiskAmount = sizing.riskAmount;
          }
        }

        const challReason = (challSignal.reasons || [challSignal.reasoning?.summary || 'Challenger signal']).join('; ');
        const challEntry = challSignal.entryZone?.optimal ?? lastCandle.close;
        const challStop = challSignal.stopLoss;
        const challTP = challSignal.takeProfits?.tp1 ?? 0;

        const challFingerprint = computeDecisionFingerprint({
          modelIdentity: this.config.challengerModel,
          snapshotId: marketSnapshot.snapshotId,
          snapshotHash: marketSnapshot.snapshotHash,
          portfolioStateHash: portfolioSnapshot.portfolioStateHash,
          featureVersion,
          featureSchemaHash,
          featureInputHash,
          featureDataCutoff: marketSnapshot.timestamp,
          strategyConfigHash: challengerStrategyConfigHash,
          executionConfigHash,
          riskConfigHash,
          costConfigHash,
          action: challAction,
          signal: challSignal.state,
          entryPrice: challEntry,
          stopLoss: challStop,
          takeProfit: challTP,
          positionSize: challPositionSize,
          riskAmount: challRiskAmount,
        });

        const challengerDecision: TradingDecision = deepFreeze({
          decisionId: challContext.decisionId,
          action: challAction,
          confidence: challConfidence,
          signal: challSignal.state,
          entryPrice: challEntry,
          stopLoss: challStop,
          takeProfit: challTP,
          positionSize: challPositionSize,
          riskAmount: challRiskAmount,
          reason: challReason,
          decisionFingerprint: challFingerprint,
          latencies: {
            marketTimestamp: marketSnapshot.timestamp,
            featureStartTimestamp: decisionTimestamp,
            featureEndTimestamp: decisionTimestamp + Math.round(featureLatencyMs),
            modelStartTimestamp: decisionTimestamp + Math.round(featureLatencyMs),
            modelEndTimestamp: decisionTimestamp + Math.round(featureLatencyMs + challModelLatencyMs),
            decisionTimestamp,
            dataToDecisionLatencyMs: Math.max(1, Math.round(performance.now() - tStart)),
            featureLatencyMs,
            modelLatencyMs: challModelLatencyMs,
            totalDecisionLatencyMs: Math.max(1, Math.round(featureLatencyMs + challModelLatencyMs)),
          },
          context: challContext,
        });

        // Submit shadow order strictly via IShadowExecutionPort (NO live port access)
        if (challAction === 'BUY' || challAction === 'SELL') {
          assertShadowExecution(challContext, shadowPort);
          shadowPort.submitShadowOrder({
            shadowOrderId: `so_${randomUUID()}`,
            decisionId: challengerDecision.decisionId,
            instrument,
            side: challAction,
            quantity: challPositionSize || 1,
            requestedPrice: challEntry,
            stopLoss: challStop,
            takeProfit: challTP,
            orderType: 'MARKET',
            createdAt: decisionTimestamp,
            executionConfigVersion,
            costConfigVersion,
            status: 'PENDING',
          });
        }

        const pair = createDecisionPair({
          championDecision,
          challengerDecision,
        });

        // Persist atomically at storage boundary
        this.config.store.saveDecision(championDecision);
        this.config.store.saveDecision(challengerDecision);
        this.config.store.putIfAbsentDecisionPair(pair);

        return pair;
      } catch (err) {
        throw err;
      }
    })();

    return {
      championDecision,
      pairPromise,
    };
  }
}
