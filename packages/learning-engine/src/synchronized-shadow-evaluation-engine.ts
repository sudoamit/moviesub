import { randomUUID, createHash } from 'crypto';
import { ICandle } from '@quant/shared';
import { CandidateArtifact, ShadowEvaluationMetrics } from './types';
import { canonicalJsonStringify } from './canonical-serializer';
import { ChallengerEvaluation, ChampionChallengerCoordinator, ChampionSnapshot, ShadowEvidence } from './champion-challenger';

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
  readonly featureVersion: string;
  readonly featureHash: string;
  readonly generatedAt: number;
  readonly sourceSnapshotHash: string;
  readonly cutoffTimestamp: number;
  readonly features: Readonly<Record<string, number>>;
}

export interface ShadowDecision {
  readonly decisionId: string;
  readonly timestamp: number;
  readonly action: ShadowDecisionAction;
  readonly symbol: string;
  readonly timeframe: string;
  readonly confidence?: number;
  readonly positionTarget: 'LONG' | 'SHORT' | 'FLAT';
  readonly quantity: number;
  readonly riskState: Readonly<Record<string, number>>;
  readonly featureSnapshotHash: string;
  readonly snapshotId: string;
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
  readonly realizedPnL: number;
  readonly unrealizedPnL: number;
  readonly rMultiple: number;
  readonly executionTimestamp: number;
  readonly executionContextHash: string;
}

export interface ShadowBranchState {
  readonly capital: number;
  readonly position: 'LONG' | 'SHORT' | 'FLAT';
  readonly quantity: number;
  readonly openOrders: readonly string[];
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
  readonly evaluationId: string;
  readonly lastProcessedTimestamp: number;
  readonly lastSnapshotId: string;
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
  readonly feePerTrade: number;
  readonly slippagePerTrade: number;
  readonly riskPerTrade: number;
  readonly quantity: number;
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
  readonly executionConfig: ShadowExecutionConfig;
  readonly maxEvents?: number;
  readonly checkpoint?: ShadowEvaluationCheckpoint;
  readonly decisionProvider?: (input: {
    readonly artifact: CandidateArtifact;
    readonly snapshot: EvaluationMarketSnapshot;
    readonly features: FeatureSnapshot;
    readonly state: ShadowBranchState;
    readonly mode: ShadowMode;
  }) => Omit<ShadowDecision, 'decisionId' | 'timestamp' | 'symbol' | 'timeframe' | 'featureSnapshotHash' | 'snapshotId' | 'marketDataCutoffTimestamp' | 'executionContextHash'>;
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

class DeterministicShadowExecutionSimulator {
  public readonly simulatorId = 'phase10b-shared-execution-simulator-v1';
  public readonly feeModelHash: string;
  public readonly slippageModelHash: string;

  public constructor(private readonly config: ShadowExecutionConfig) {
    this.feeModelHash = hash({ feePerTrade: config.feePerTrade });
    this.slippageModelHash = hash({ slippagePerTrade: config.slippagePerTrade });
  }

  public execute(
    decision: ShadowDecision,
    snapshot: EvaluationMarketSnapshot,
    previousClose: number,
  ): ShadowExecutionResult | undefined {
    if (decision.action === 'HOLD') return undefined;
    const direction = decision.action === 'ENTER_SHORT' ? -1 : 1;
    const quantity = decision.quantity;
    const entryPrice = snapshot.candle.open + (direction * this.config.slippagePerTrade);
    const exitPrice = snapshot.candle.close - (direction * this.config.slippagePerTrade);
    const realizedPnL = decision.action === 'EXIT'
      ? 0
      : ((exitPrice - entryPrice) * direction * quantity) - this.config.feePerTrade - this.config.slippagePerTrade;
    const risk = Math.max(Math.abs(previousClose) * this.config.riskPerTrade * quantity, 1);
    return freeze({
      orderId: `${decision.decisionId}-order`,
      decisionId: decision.decisionId,
      entryPrice: Number(entryPrice.toFixed(8)),
      exitPrice: Number(exitPrice.toFixed(8)),
      quantity,
      fees: this.config.feePerTrade,
      slippage: this.config.slippagePerTrade,
      realizedPnL: Number(realizedPnL.toFixed(8)),
      unrealizedPnL: 0,
      rMultiple: Number((realizedPnL / risk).toFixed(8)),
      executionTimestamp: timestampOf(snapshot.candle),
      executionContextHash: snapshot.executionContextHash,
    });
  }
}

export class SynchronizedShadowEvaluationEngine {
  public static readonly SHADOW_EVALUATION_VERSION = 'phase10b-synchronized-shadow-v1';

  public static evaluate(options: SynchronizedShadowEvaluationOptions): SynchronizedShadowEvaluationResult {
    this.validateInputs(options);
    if (options.checkpoint) this.validateCheckpoint(options.checkpoint, options);

    const marketSnapshots = this.createMarketSnapshots(options);
    const featureSnapshots = marketSnapshots.map((snapshot) => this.createFeatureSnapshot(snapshot, options));
    const snapshots = marketSnapshots.map((snapshot, index) => freeze({ ...snapshot, featureSnapshotHash: featureSnapshots[index].featureHash }));
    const startIndex = options.checkpoint?.processedEventCount ?? 0;
    const maxEvents = options.maxEvents ?? snapshots.length;
    const endIndex = Math.min(snapshots.length, startIndex + maxEvents);
    const clock = new SynchronizedEvaluationClock(snapshots.slice(startIndex, endIndex));

    let champion = options.checkpoint?.state.champion ?? this.createBranch('PAPER', options.executionConfig);
    let challenger = options.checkpoint?.state.challenger ?? this.createBranch('SHADOW', options.executionConfig);
    const featureBySnapshot = new Map(featureSnapshots.map((feature) => [feature.sourceSnapshotHash, feature]));

    let snapshot: EvaluationMarketSnapshot | undefined;
    while ((snapshot = clock.next())) {
      const feature = featureBySnapshot.get(snapshot.snapshotHash);
      if (!feature || feature.featureHash !== snapshot.featureSnapshotHash) throw new Error('SHADOW_FEATURE_HASH_MISMATCH');
      const previousClose = snapshots[Math.max(0, startIndex + champion.decisions.length - (options.checkpoint?.state.champion.decisions.length ?? 0) - 1)]?.candle.close ?? snapshot.candle.open;
      champion = this.processBranch(options.champion, champion, snapshot, feature, previousClose, options);
      challenger = this.processBranch(options.challenger, challenger, snapshot, feature, previousClose, options);
    }

    const processedEventCount = endIndex;
    if (processedEventCount < snapshots.length) {
      return this.buildResult(options, champion, challenger, snapshots, featureSnapshots, processedEventCount);
    }
    return this.buildResult(options, champion, challenger, snapshots, featureSnapshots);
  }

  public static completeCoordinatorShadowEvaluation(
    coordinatorEvaluationId: string,
    result: SynchronizedShadowEvaluationResult,
  ): ChallengerEvaluation {
    return ChampionChallengerCoordinator.completeShadow(
      coordinatorEvaluationId,
      result.shadowEvidence,
      result.shadowEvidence.marketDataCutoffTimestamp,
    );
  }

  private static validateInputs(options: SynchronizedShadowEvaluationOptions): void {
    if (options.marketDataCutoffTimestamp !== options.coordinatorEvaluation.marketDataCutoffTimestamp) throw new Error('SHADOW_MARKET_DATA_CUTOFF_MISMATCH');
    if (options.datasetHash !== options.coordinatorEvaluation.datasetHash) throw new Error('SHADOW_DATASET_MISMATCH');
    if (options.champion.artifactHash !== options.championSnapshot.artifactHash) throw new Error('SHADOW_STRATEGY_ARTIFACT_MISMATCH');
    if (options.challenger.artifactHash !== options.coordinatorEvaluation.challengerArtifactHash) throw new Error('SHADOW_STRATEGY_ARTIFACT_MISMATCH');
    if (options.champion.executionContextHash !== options.challenger.executionContextHash) throw new Error('SHADOW_EXECUTION_CONTEXT_MISMATCH');
    if (options.champion.executionContextVersion !== options.challenger.executionContextVersion) throw new Error('SHADOW_EXECUTION_CONTEXT_MISMATCH');
    if (options.champion.executionContextHash !== options.coordinatorEvaluation.executionContextHash) throw new Error('SHADOW_EXECUTION_CONTEXT_MISMATCH');
    if (options.champion.executionContextVersion !== options.coordinatorEvaluation.executionContextVersion) throw new Error('SHADOW_EXECUTION_CONTEXT_MISMATCH');
    if (options.champion.datasetHash !== options.datasetHash || options.challenger.datasetHash !== options.datasetHash) throw new Error('SHADOW_DATASET_MISMATCH');
    if (!options.candles.length) throw new Error('SHADOW_MARKET_DATA_GAP');
  }

  private static createMarketSnapshots(options: SynchronizedShadowEvaluationOptions): readonly EvaluationMarketSnapshot[] {
    const seen = new Set<string>();
    let previous = 0;
    return freeze(options.candles.map((candle, index) => {
      const timestamp = timestampOf(candle);
      if (!Number.isFinite(timestamp) || timestamp <= 0) throw new Error('SHADOW_MARKET_DATA_GAP');
      if (timestamp > options.marketDataCutoffTimestamp) throw new Error('SHADOW_LOOKAHEAD_DETECTED');
      if (timestamp < previous) throw new Error('SHADOW_OUT_OF_ORDER_TIMESTAMP');
      if (timestamp === previous || seen.has(String(timestamp))) throw new Error('SHADOW_DUPLICATE_SNAPSHOT');
      if (index > 0 && timestamp - previous > this.expectedIntervalMs(options.timeframe) * 1.5) throw new Error('SHADOW_MARKET_DATA_GAP');
      previous = timestamp;
      seen.add(String(timestamp));
      const candleIds = [`${options.symbol}:${options.timeframe}:${timestamp}`];
      const payload = {
        symbol: options.symbol,
        timeframe: options.timeframe,
        marketDataCutoffTimestamp: options.marketDataCutoffTimestamp,
        source: options.source,
        datasetHash: options.datasetHash,
        dataVersion: options.dataVersion,
        candleIds,
        executionContextHash: options.coordinatorEvaluation.executionContextHash,
        executionContextVersion: options.coordinatorEvaluation.executionContextVersion,
        candle,
      };
      const featureSeedHash = hash({ featureVersion: options.featureVersion, candle });
      const snapshotHash = hash(payload);
      return {
        snapshotId: `shadow-snapshot-${index}-${timestamp}`,
        snapshotHash,
        ...payload,
        featureSnapshotHash: featureSeedHash,
      };
    }));
  }

  private static createFeatureSnapshot(snapshot: EvaluationMarketSnapshot, options: SynchronizedShadowEvaluationOptions): FeatureSnapshot {
    if (snapshot.marketDataCutoffTimestamp !== options.marketDataCutoffTimestamp) throw new Error('SHADOW_MARKET_DATA_CUTOFF_MISMATCH');
    const features = freeze({
      open: snapshot.candle.open,
      high: snapshot.candle.high,
      low: snapshot.candle.low,
      close: snapshot.candle.close,
      volume: snapshot.candle.volume,
      range: Number((snapshot.candle.high - snapshot.candle.low).toFixed(8)),
      body: Number((snapshot.candle.close - snapshot.candle.open).toFixed(8)),
    });
    const payload = {
      featureVersion: options.featureVersion,
      generatedAt: options.generatedAt ?? 0,
      sourceSnapshotHash: snapshot.snapshotHash,
      cutoffTimestamp: snapshot.marketDataCutoffTimestamp,
      features,
    };
    return freeze({ ...payload, featureHash: hash(payload) });
  }

  private static processBranch(
    artifact: CandidateArtifact,
    branch: ShadowBranchResult,
    snapshot: EvaluationMarketSnapshot,
    feature: FeatureSnapshot,
    previousClose: number,
    options: SynchronizedShadowEvaluationOptions,
  ): ShadowBranchResult {
    if (branch.mode === 'SHADOW' && branch.hasProductionOrderRouter) throw new Error('SHADOW_PRODUCTION_ROUTER_FORBIDDEN');
    const provided = options.decisionProvider?.({ artifact, snapshot, features: feature, state: branch.state, mode: branch.mode })
      ?? this.defaultDecision(artifact, branch.state);
    if (provided.featureSnapshotHash && provided.featureSnapshotHash !== feature.featureHash) throw new Error('SHADOW_FEATURE_HASH_MISMATCH');
    const decision: ShadowDecision = freeze({
      ...provided,
      decisionId: `${branch.mode.toLowerCase()}-${artifact.artifactHash.slice(0, 12)}-${snapshot.snapshotId}`,
      timestamp: timestampOf(snapshot.candle),
      symbol: snapshot.symbol,
      timeframe: snapshot.timeframe,
      featureSnapshotHash: feature.featureHash,
      snapshotId: snapshot.snapshotId,
      marketDataCutoffTimestamp: snapshot.marketDataCutoffTimestamp,
      executionContextHash: snapshot.executionContextHash,
    });
    const simulator = new DeterministicShadowExecutionSimulator(options.executionConfig);
    const execution = simulator.execute(decision, snapshot, previousClose);
    const executions = execution ? [...branch.executions, execution] : [...branch.executions];
    const state = this.updateState(branch.state, decision, execution, options.executionConfig);
    return freeze({
      mode: branch.mode,
      state,
      decisions: [...branch.decisions, decision],
      executions,
      metrics: this.calculateMetrics(executions, options.executionConfig.initialCapital, snapshot.marketDataCutoffTimestamp),
      simulatorId: simulator.simulatorId,
      feeModelHash: simulator.feeModelHash,
      slippageModelHash: simulator.slippageModelHash,
      hasProductionOrderRouter: branch.mode !== 'SHADOW' && branch.hasProductionOrderRouter,
    });
  }

  private static createBranch(mode: ShadowMode, config: ShadowExecutionConfig): ShadowBranchResult {
    const simulator = new DeterministicShadowExecutionSimulator(config);
    const state = freeze({
      capital: config.initialCapital,
      position: 'FLAT' as const,
      quantity: 0,
      openOrders: [],
      riskState: { riskPerTrade: config.riskPerTrade },
      portfolioState: { equity: config.initialCapital },
    });
    return freeze({
      mode,
      state: cloneState(state),
      decisions: [],
      executions: [],
      metrics: this.calculateMetrics([], config.initialCapital, 0),
      simulatorId: simulator.simulatorId,
      feeModelHash: simulator.feeModelHash,
      slippageModelHash: simulator.slippageModelHash,
      hasProductionOrderRouter: mode !== 'SHADOW',
    });
  }

  private static defaultDecision(artifact: CandidateArtifact, state: ShadowBranchState): Omit<ShadowDecision, 'decisionId' | 'timestamp' | 'symbol' | 'timeframe' | 'featureSnapshotHash' | 'snapshotId' | 'marketDataCutoffTimestamp' | 'executionContextHash'> {
    const selector = parseInt(artifact.artifactHash.slice(0, 2), 16) % 3;
    const action: ShadowDecisionAction = selector === 0 ? 'ENTER_LONG' : selector === 1 ? 'ENTER_SHORT' : 'HOLD';
    return {
      action,
      confidence: selector / 2,
      positionTarget: action === 'ENTER_LONG' ? 'LONG' : action === 'ENTER_SHORT' ? 'SHORT' : state.position,
      quantity: action === 'HOLD' ? 0 : 1,
      riskState: state.riskState,
    };
  }

  private static updateState(
    state: ShadowBranchState,
    decision: ShadowDecision,
    execution: ShadowExecutionResult | undefined,
    config: ShadowExecutionConfig,
  ): ShadowBranchState {
    const capital = Number((state.capital + (execution?.realizedPnL ?? 0)).toFixed(8));
    return freeze({
      capital,
      position: decision.positionTarget,
      quantity: decision.quantity,
      openOrders: execution ? [] : state.openOrders,
      riskState: { ...decision.riskState },
      portfolioState: { equity: capital, initialCapital: config.initialCapital },
    });
  }

  private static calculateMetrics(
    executions: readonly ShadowExecutionResult[],
    initialCapital: number,
    observationsCount: number,
  ): Phase10BShadowMetrics {
    const wins = executions.filter((execution) => execution.realizedPnL > 0);
    const losses = executions.filter((execution) => execution.realizedPnL < 0);
    const totalPnL = executions.reduce((sum, execution) => sum + execution.realizedPnL, 0);
    const grossProfit = wins.reduce((sum, execution) => sum + execution.realizedPnL, 0);
    const grossLoss = Math.abs(losses.reduce((sum, execution) => sum + execution.realizedPnL, 0));
    const fees = executions.reduce((sum, execution) => sum + execution.fees, 0);
    const slippage = executions.reduce((sum, execution) => sum + execution.slippage, 0);
    const rValues = executions.map((execution) => execution.rMultiple);
    const pnlR = rValues.reduce((sum, value) => sum + value, 0);
    let peak = 0;
    let curve = 0;
    let maxDrawdown = 0;
    for (const execution of executions) {
      curve += execution.realizedPnL;
      peak = Math.max(peak, curve);
      maxDrawdown = Math.max(maxDrawdown, peak - curve);
    }
    const sortedR = [...rValues].sort((a, b) => a - b);
    const medianR = sortedR.length === 0 ? 0 : sortedR.length % 2 === 1
      ? sortedR[Math.floor(sortedR.length / 2)]
      : (sortedR[sortedR.length / 2 - 1] + sortedR[sortedR.length / 2]) / 2;
    const totalTrades = executions.length;
    const averageTrade = totalTrades ? totalPnL / totalTrades : 0;
    const costAdjustedPnL = totalPnL - fees - slippage;
    return freeze({
      totalTrades,
      wins: wins.length,
      losses: losses.length,
      winRate: totalTrades ? Number(((wins.length / totalTrades) * 100).toFixed(8)) : 0,
      grossPnL: Number(grossProfit.toFixed(8)),
      netPnL: Number(totalPnL.toFixed(8)),
      pnlR: Number(pnlR.toFixed(8)),
      profitFactor: grossLoss > 0 ? Number((grossProfit / grossLoss).toFixed(8)) : grossProfit > 0 ? Number.POSITIVE_INFINITY : 0,
      maxDrawdown: Number(maxDrawdown.toFixed(8)),
      maxDrawdownR: Number(maxDrawdown.toFixed(8)),
      expectancy: totalTrades ? Number((pnlR / totalTrades).toFixed(8)) : 0,
      averageR: totalTrades ? Number((pnlR / totalTrades).toFixed(8)) : 0,
      medianR: Number(medianR.toFixed(8)),
      largestLoss: losses.length ? Number(Math.min(...losses.map((execution) => execution.realizedPnL)).toFixed(8)) : 0,
      largestWin: wins.length ? Number(Math.max(...wins.map((execution) => execution.realizedPnL)).toFixed(8)) : 0,
      fees: Number(fees.toFixed(8)),
      slippage: Number(slippage.toFixed(8)),
      observationsCount,
      totalPnL: Number(totalPnL.toFixed(8)),
      returnPct: Number(((totalPnL / initialCapital) * 100).toFixed(8)),
      tradeCount: totalTrades,
      averageTrade: Number(averageTrade.toFixed(8)),
      turnover: Number(executions.reduce((sum, execution) => sum + Math.abs(execution.quantity * execution.entryPrice), 0).toFixed(8)),
      costAdjustedPnL: Number(costAdjustedPnL.toFixed(8)),
      riskAdjustedReturn: maxDrawdown > 0 ? Number((totalPnL / maxDrawdown).toFixed(8)) : totalPnL,
    });
  }

  private static buildResult(
    options: SynchronizedShadowEvaluationOptions,
    champion: ShadowBranchResult,
    challenger: ShadowBranchResult,
    snapshots: readonly EvaluationMarketSnapshot[],
    featureSnapshots: readonly FeatureSnapshot[],
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
      checkpoint: partial ? this.createCheckpoint(evaluation.evaluationId, champion, challenger, snapshots, featureSnapshots, observationCount) : undefined,
    };
    if (!partial && hash(replayPayload) !== evidenceHash) throw new Error('SHADOW_NONDETERMINISTIC_REPLAY');
    return freeze(result);
  }

  private static createCheckpoint(
    evaluationId: string,
    champion: ShadowBranchResult,
    challenger: ShadowBranchResult,
    snapshots: readonly EvaluationMarketSnapshot[],
    featureSnapshots: readonly FeatureSnapshot[],
    processedEventCount: number,
  ): ShadowEvaluationCheckpoint {
    const last = snapshots[processedEventCount - 1];
    return freeze({
      evaluationId,
      lastProcessedTimestamp: timestampOf(last.candle),
      lastSnapshotId: last.snapshotId,
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

  private static validateCheckpoint(checkpoint: ShadowEvaluationCheckpoint, options: SynchronizedShadowEvaluationOptions): void {
    if (checkpoint.evaluationId !== options.coordinatorEvaluation.evaluationId) throw new Error('SHADOW_CORRUPTED_CHECKPOINT');
    if (checkpoint.championStateHash !== hash(checkpoint.state.champion.state)) throw new Error('SHADOW_CORRUPTED_CHECKPOINT');
    if (checkpoint.challengerStateHash !== hash(checkpoint.state.challenger.state)) throw new Error('SHADOW_CORRUPTED_CHECKPOINT');
    if (checkpoint.metricsStateHash !== hash({ champion: checkpoint.state.champion.metrics, challenger: checkpoint.state.challenger.metrics })) throw new Error('SHADOW_CORRUPTED_CHECKPOINT');
    if (checkpoint.processedEventCount !== checkpoint.state.marketSnapshots.length) throw new Error('SHADOW_CORRUPTED_CHECKPOINT');
  }

  private static relativeMetrics(champion: Phase10BShadowMetrics, challenger: Phase10BShadowMetrics): Readonly<Record<string, number>> {
    const keys: (keyof Phase10BShadowMetrics)[] = ['totalPnL', 'returnPct', 'expectancy', 'profitFactor', 'winRate', 'tradeCount', 'averageTrade', 'averageR', 'maxDrawdown', 'turnover', 'fees', 'slippage', 'costAdjustedPnL', 'riskAdjustedReturn'];
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
    const matches = champion.filter((decision, index) => decision.action === challenger[index]?.action && decision.quantity === challenger[index]?.quantity).length;
    return Number((matches / champion.length).toFixed(8));
  }

  private static classifyDivergence(champion: readonly ShadowDecision[], challenger: readonly ShadowDecision[]): Readonly<Record<DivergenceType, number>> {
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
      if (this.isEnter(left.action) && right.action === 'HOLD' || this.isEnter(right.action) && left.action === 'HOLD') result.ENTER_vs_HOLD += 1;
      if (left.action === 'EXIT' && right.action === 'HOLD' || right.action === 'EXIT' && left.action === 'HOLD') result.EXIT_vs_HOLD += 1;
      if (left.positionTarget === 'LONG' && right.positionTarget === 'SHORT' || left.positionTarget === 'SHORT' && right.positionTarget === 'LONG') result.LONG_vs_SHORT += 1;
      if (left.positionTarget === 'LONG' && right.positionTarget === 'FLAT' || right.positionTarget === 'LONG' && left.positionTarget === 'FLAT') result.LONG_vs_FLAT += 1;
      if (left.positionTarget === 'SHORT' && right.positionTarget === 'FLAT' || right.positionTarget === 'SHORT' && left.positionTarget === 'FLAT') result.SHORT_vs_FLAT += 1;
      if (left.quantity !== right.quantity) result.SIZING_DIFFERENCE += 1;
      if (hash(left.riskState) !== hash(right.riskState)) result.RISK_DIFFERENCE += 1;
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
