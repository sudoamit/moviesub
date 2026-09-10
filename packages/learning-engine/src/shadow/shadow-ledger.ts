import * as fs from 'fs';
import * as path from 'path';
import { createHash, randomUUID } from 'crypto';
import { IBacktestTrade, ICandle, ISignalSetup } from '@quant/shared';
import { IFill, IOrder } from '@quant/backtesting';
import { PositionLot } from '@quant/risk-engine';
import {
  CandidateProductionComparison,
  DEFAULT_SHADOW_WINDOW_CONFIG,
  DriftEvent,
  SHADOW_SCHEMA_VERSION,
  ShadowAuditRecord,
  ShadowHealthState,
  ShadowLedgerData,
  ShadowObservation,
  ShadowStateSnapshot,
  ShadowWindowConfig,
  ShadowWindowMetrics,
} from './shadow-types';
import { ShadowHealthMachine } from './shadow-health-machine';
import { RegimeObservation } from './regime-drift-detector';
import { FeatureDriftBaseline } from './feature-drift-detector';
import { canonicalJsonStringify } from '../canonical-serializer';

function deepFreeze<T extends object>(obj: T): Readonly<T> {
  Object.freeze(obj);
  for (const key of Object.getOwnPropertyNames(obj)) {
    const val = (obj as Record<string, unknown>)[key];
    if (val !== null && (typeof val === 'object' || typeof val === 'function') && !Object.isFrozen(val)) {
      deepFreeze(val as object);
    }
  }
  return obj;
}

export class ShadowLedger {
  private readonly candidateId: string;
  private readonly candidateVersion: string;
  private readonly strategyVersion: string;
  private readonly featureSchemaHash: string;
  private readonly artifactHash: string;
  private persistencePath: string | null = null;

  private observations: ShadowObservation[] = [];
  private orders: IOrder[] = [];
  private fills: IFill[] = [];
  private trades: IBacktestTrade[] = [];
  private windows: ShadowWindowMetrics[] = [];
  private drifts: DriftEvent[] = [];
  private comparisons: CandidateProductionComparison[] = [];
  private events: ShadowAuditRecord[] = [];
  private health: ShadowHealthState;
  private lastMarketTimestamp = 0;

  private symbol: string;
  private activeLot: PositionLot | null = null;
  private recentCandles: ICandle[] = [];
  private pendingOrders: IOrder[] = [];
  private pendingEntrySignals: Map<string, ISignalSetup> = new Map();
  private baselineMetrics?: {
    expectancyR: number;
    winRate: number;
    profitFactor: number;
    maxDrawdownR?: number;
  };
  private featureBaseline?: FeatureDriftBaseline;
  private referenceRegime?: {
    volatilityRegime: 'LOW_VOLATILITY' | 'NORMAL_VOLATILITY' | 'HIGH_VOLATILITY';
    trendRegime?: 'TRENDING_BULLISH' | 'TRENDING_BEARISH' | 'RANGING';
  };
  private windowConfig?: ShadowWindowConfig;
  private regimeHistory: RegimeObservation[] = [];
  private featureVectors: (readonly number[])[] = [];
  private executionSequences: {
    readonly nextOrderSequence: number;
    readonly nextFillSequence: number;
    readonly nextEventSequence: number;
  } | null = null;
  private cumulativeMarketHash: string = '';

  constructor(params: {
    candidateId: string;
    candidateVersion: string;
    strategyVersion: string;
    featureSchemaHash: string;
    artifactHash: string;
    symbol: string;
    persistencePath?: string;
  }) {
    if (!params.symbol || typeof params.symbol !== 'string' || params.symbol.trim() === '') {
      throw new Error(`MISSING_SYMBOL: ShadowLedger requires a valid authoritative symbol`);
    }
    this.candidateId = params.candidateId;
    this.candidateVersion = params.candidateVersion;
    this.strategyVersion = params.strategyVersion;
    this.featureSchemaHash = params.featureSchemaHash;
    this.artifactHash = params.artifactHash;
    this.symbol = params.symbol.trim().toUpperCase();
    this.persistencePath = params.persistencePath || null;
    this.health = ShadowHealthMachine.createInitialState(params.candidateId);
    if (this.persistencePath && fs.existsSync(this.persistencePath)) {
      this.loadFromFile(this.persistencePath);
    }
  }

  public setPersistencePath(filePath: string | null): void {
    this.persistencePath = filePath;
    if (filePath && fs.existsSync(filePath)) {
      this.loadFromFile(filePath);
    }
  }

  public getCandidateId(): string {
    return this.candidateId;
  }

  public getArtifactHash(): string {
    return this.artifactHash;
  }

  public getHealthState(): Readonly<ShadowHealthState> {
    return deepFreeze({ ...this.health });
  }

  public setHealthState(state: ShadowHealthState): void {
    this.health = deepFreeze({ ...state });
  }

  public getObservations(): readonly ShadowObservation[] {
    return deepFreeze([...this.observations]);
  }

  public getTrades(): readonly IBacktestTrade[] {
    return deepFreeze([...this.trades]);
  }

  public getOrders(): readonly IOrder[] {
    return deepFreeze([...this.orders]);
  }

  public getFills(): readonly IFill[] {
    return deepFreeze([...this.fills]);
  }

  public getDrifts(): readonly DriftEvent[] {
    return deepFreeze([...this.drifts]);
  }

  public getComparisons(): readonly CandidateProductionComparison[] {
    return deepFreeze([...this.comparisons]);
  }

  public getAuditEvents(): readonly ShadowAuditRecord[] {
    return deepFreeze([...this.events]);
  }

  public getLastMarketTimestamp(): number {
    return this.lastMarketTimestamp;
  }

  /**
   * Appends a new market observation and updates the market timestamp.
   */
  public recordObservation(observation: ShadowObservation): void {
    if (observation.candidateId !== this.candidateId) {
      throw new Error(
        `CANDIDATE_ID_MISMATCH: Observation candidateId ${observation.candidateId} does not match ledger ${this.candidateId}`,
      );
    }
    if (observation.marketTimestamp <= this.lastMarketTimestamp && this.observations.length > 0) {
      throw new Error(
        `TIMESTAMP_REGRESSION: Market timestamp ${observation.marketTimestamp} <= last timestamp ${this.lastMarketTimestamp}`,
      );
    }

    this.observations.push(deepFreeze({ ...observation }));
    this.lastMarketTimestamp = observation.marketTimestamp;
  }

  /**
   * Records execution orders.
   */
  public recordOrders(newOrders: readonly IOrder[]): void {
    for (const ord of newOrders) {
      this.orders.push(deepFreeze({ ...ord }));
    }
  }

  /**
   * Records execution fills.
   */
  public recordFills(newFills: readonly IFill[]): void {
    for (const f of newFills) {
      this.fills.push(deepFreeze({ ...f }));
    }
  }

  /**
   * Records completed trade lifecycles.
   */
  public recordClosedTrades(closedTrades: readonly IBacktestTrade[]): void {
    for (const t of closedTrades) {
      this.trades.push(deepFreeze({ ...t }));
    }
  }

  /**
   * Records detected drift events.
   */
  public recordDrifts(newDrifts: readonly DriftEvent[]): void {
    for (const d of newDrifts) {
      this.drifts.push(deepFreeze({ ...d }));
    }
  }

  /**
   * Records candidate vs production comparison.
   */
  public recordComparison(comp: CandidateProductionComparison): void {
    this.comparisons.push(deepFreeze({ ...comp }));
  }

  /**
   * Emits an authoritative audit record. Rejects duplicate event IDs.
   */
  public recordAuditEvent(record: ShadowAuditRecord): void {
    if (record.candidateId !== this.candidateId) {
      throw new Error(`Audit event candidateId mismatch: ${record.candidateId} vs ${this.candidateId}`);
    }
    if (this.events.some((e) => e.eventId === record.eventId)) {
      throw new Error(`DUPLICATE_EVENT_ID: Audit event with ID '${record.eventId}' already exists`);
    }
    this.events.push(deepFreeze({ ...record }));
  }

  /**
   * Computes rolling window metrics over the recent trade / observation ledger.
   */
  public computeRollingMetrics(
    windowType: 'SHORT' | 'MEDIUM' | 'LONG',
    windowSize: number,
    baselineExpectancyR = 0.25,
    baselineWinRate = 50.0,
  ): ShadowWindowMetrics | null {
    if (this.trades.length === 0) {
      return null;
    }

    const recentTrades = this.trades.slice(-windowSize);
    if (recentTrades.length === 0) return null;

    const tradeCount = recentTrades.length;
    const rMultiples = recentTrades.map((t) => t.pnlRMultiple || 0);
    const winningTrades = recentTrades.filter((t) => t.pnl > 0);
    const losingTrades = recentTrades.filter((t) => t.pnl < 0);

    const grossProfit = winningTrades.reduce((sum, t) => sum + t.pnl, 0);
    const grossLoss = losingTrades.reduce((sum, t) => sum + Math.abs(t.pnl), 0);
    const netPnl = Number(recentTrades.reduce((sum, t) => sum + t.pnl, 0).toFixed(2));
    const totalR = Number(rMultiples.reduce((sum, r) => sum + r, 0).toFixed(2));
    const averageR = tradeCount > 0 ? Number((totalR / tradeCount).toFixed(3)) : 0;
    const winRate = tradeCount > 0 ? Number(((winningTrades.length / tradeCount) * 100).toFixed(1)) : 0;

    const profitFactor =
      grossLoss === 0
        ? grossProfit > 0
          ? Infinity
          : 0
        : Number((grossProfit / grossLoss).toFixed(2));

    // Calculate window drawdown strictly from the window trades
    let peakR = 0;
    let currentR = 0;
    let maxDrawdownR = 0;
    for (const r of rMultiples) {
      currentR += r;
      if (currentR > peakR) peakR = currentR;
      const dd = peakR - currentR;
      if (dd > maxDrawdownR) maxDrawdownR = dd;
    }

    const firstTrade = recentTrades[0];
    const lastTrade = recentTrades[recentTrades.length - 1];
    const windowStart =
      firstTrade.entryTime instanceof Date
        ? firstTrade.entryTime.getTime()
        : new Date(firstTrade.entryTime).getTime();
    const windowEnd =
      lastTrade.exitTime instanceof Date
        ? lastTrade.exitTime.getTime()
        : new Date(lastTrade.exitTime).getTime();

    // Average holding time
    const totalHoldingMs = recentTrades.reduce((sum, t) => {
      const entry = t.entryTime instanceof Date ? t.entryTime.getTime() : new Date(t.entryTime).getTime();
      const exit = t.exitTime instanceof Date ? t.exitTime.getTime() : new Date(t.exitTime).getTime();
      return sum + (exit - entry);
    }, 0);
    const averageHoldingTimeMs = Math.round(totalHoldingMs / tradeCount);

    const longTrades = recentTrades.filter((t) => t.direction === 'BULLISH' || (t as any).side === 'LONG').length;
    const longRatio = Number((longTrades / tradeCount).toFixed(2));
    const shortRatio = Number((1 - longRatio).toFixed(2));

    const totalFeesInWindow = this.fills.reduce((sum, f) => sum + (f.fee || 0), 0);
    const totalSlippageInWindow = this.fills.reduce((sum, f) => sum + (f.slippage || 0), 0);
    const averageFees = tradeCount > 0 ? Number((totalFeesInWindow / tradeCount).toFixed(4)) : 0;
    const averageSlippage = tradeCount > 0 ? Number((totalSlippageInWindow / tradeCount).toFixed(4)) : 0;

    const metrics: ShadowWindowMetrics = {
      candidateId: this.candidateId,
      windowType,
      windowStart,
      windowEnd,
      observationCount: this.observations.length,
      tradeCount,
      pnl: netPnl,
      pnlR: totalR,
      winRate,
      profitFactor,
      maxDrawdown: Number(maxDrawdownR.toFixed(2)),
      averageSlippage,
      averageFees,
      averageR,
      averageHoldingTimeMs,
      signalFrequency: Number((tradeCount / Math.max(1, this.observations.length)).toFixed(3)),
      longRatio,
      shortRatio,
      baselineComparison: {
        pnlDelta: netPnl,
        pnlRDelta: totalR,
        winRateDelta: Number((winRate - baselineWinRate).toFixed(1)),
        drawdownDelta: Number(maxDrawdownR.toFixed(2)),
        expectancyRDelta: Number((averageR - baselineExpectancyR).toFixed(3)),
      },
    };

    return deepFreeze(metrics);
  }

  /**
   * Incrementally updates the cumulative rolling market dataset hash chain on every processed candle.
   * Ensures complete evaluation window provenance across any number of candles without keeping all candles in memory.
   * Uses canonical JSON serialization for byte-level deterministic hashing.
   */
  public recordCandle(candle: ICandle): void {
    const ts = candle.timestamp instanceof Date ? candle.timestamp.getTime() : new Date(candle.timestamp).getTime();
    const prev = this.cumulativeMarketHash || `genesis_${this.symbol}_${this.candidateId}`;
    const payload = {
      previousHash: prev,
      timestamp: ts,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      volume: candle.volume,
    };
    this.cumulativeMarketHash = createHash('sha256')
      .update(canonicalJsonStringify(payload))
      .digest('hex');
  }

  public getShadowMarketDatasetHash(): string {
    return (
      this.cumulativeMarketHash ||
      createHash('sha256').update(`empty_market_${this.symbol}_${this.candidateId}`).digest('hex')
    );
  }

  public getShadowFeatureObservationHash(): string {
    const payload = {
      symbol: this.symbol,
      candidateId: this.candidateId,
      observations: this.observations.map((o) => ({
        marketTimestamp: o.marketTimestamp,
        featureVectorHash: o.featureVectorHash,
      })),
    };
    return createHash('sha256').update(canonicalJsonStringify(payload)).digest('hex');
  }

  public getShadowExecutionEvidenceHash(): string {
    const payload = {
      symbol: this.symbol,
      candidateId: this.candidateId,
      fills: this.fills.map((f) => ({
        fillId: f.fillId,
        price: f.price,
        quantity: f.quantity,
        timestamp: f.timestamp,
        fee: f.fee,
        slippage: f.slippage,
      })),
    };
    return createHash('sha256').update(canonicalJsonStringify(payload)).digest('hex');
  }

  public getShadowDatasetHash(): string {
    const mktHash = this.getShadowMarketDatasetHash();
    const featHash = this.getShadowFeatureObservationHash();
    const execHash = this.getShadowExecutionEvidenceHash();
    return createHash('sha256')
      .update(`${this.candidateId}|${this.symbol}|${mktHash}|${featHash}|${execHash}`)
      .digest('hex');
  }

  public getStateHash(): string {
    const payload = {
      candidateId: this.candidateId,
      artifactHash: this.artifactHash,
      symbol: this.symbol,
      lastMarketTimestamp: this.lastMarketTimestamp,
      observationCount: this.observations.length,
      orderCount: this.orders.length,
      fillCount: this.fills.length,
      tradeCount: this.trades.length,
      health: this.health,
      activeLot: this.activeLot,
      pendingOrdersCount: this.pendingOrders.length,
      pendingSignalsCount: this.pendingEntrySignals.size,
      windowConfig: this.windowConfig,
      executionSequences: this.executionSequences,
      cumulativeMarketHash: this.cumulativeMarketHash,
    };
    return createHash('sha256').update(canonicalJsonStringify(payload)).digest('hex');
  }

  public getCanonicalStateSnapshot(): ShadowStateSnapshot {
    return deepFreeze({
      schemaVersion: SHADOW_SCHEMA_VERSION,
      candidateId: this.candidateId,
      candidateVersion: this.candidateVersion,
      strategyVersion: this.strategyVersion,
      symbol: this.symbol,
      lastMarketTimestamp: this.lastMarketTimestamp,
      observations: this.observations.map((o) => ({ ...o })),
      orders: this.orders.map((o) => ({ ...o })),
      fills: this.fills.map((f) => ({ ...f })),
      trades: this.trades.map((t) => ({ ...t })),
      events: this.events.map((e) => ({ ...e })),
      pendingEntrySignals: Array.from(this.pendingEntrySignals.entries()).map(([k, v]) => [k, JSON.parse(JSON.stringify(v))]),
      pendingOrders: this.pendingOrders.map((o) => ({ ...o })),
      activeLot: this.activeLot ? { ...this.activeLot } : null,
      executionSequences: this.executionSequences ? { ...this.executionSequences } : null,
      baselineMetrics: this.baselineMetrics ? { ...this.baselineMetrics } : undefined,
      featureBaseline: this.featureBaseline ? JSON.parse(JSON.stringify(this.featureBaseline)) : undefined,
      referenceRegime: this.referenceRegime ? { ...this.referenceRegime } : undefined,
      windowConfig: this.windowConfig ? { ...this.windowConfig } : undefined,
      health: { ...this.health },
      cumulativeMarketHash: this.cumulativeMarketHash,
      stateHash: this.getStateHash(),
    }) as ShadowStateSnapshot;
  }

  public calculateMedianR(): number {
    const rVals = this.trades
      .map((t) => t.pnlRMultiple ?? (t as any).realizedR)
      .filter((r) => typeof r === 'number' && !isNaN(r));
    if (rVals.length === 0) return 0;
    const sorted = [...rVals].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    if (sorted.length % 2 === 1) {
      return sorted[mid];
    }
    return Number(((sorted[mid - 1] + sorted[mid]) / 2).toFixed(4));
  }

  public getSymbol(): string {
    return this.symbol;
  }

  public setSymbol(symbol: string): void {
    if (!symbol || typeof symbol !== 'string' || symbol.trim() === '') {
      throw new Error(`MISSING_SYMBOL: Symbol cannot be empty`);
    }
    this.symbol = symbol.trim().toUpperCase();
  }

  public getActiveLot(): PositionLot | null {
    return this.activeLot ? (deepFreeze({ ...this.activeLot }) as PositionLot) : null;
  }

  public setActiveLot(lot: PositionLot | null): void {
    this.activeLot = lot ? (deepFreeze({ ...lot }) as PositionLot) : null;
  }

  public getRecentCandles(): readonly ICandle[] {
    return deepFreeze([...this.recentCandles]);
  }

  public setRecentCandles(candles: readonly ICandle[]): void {
    this.recentCandles = candles.map((c) => deepFreeze({ ...c }));
  }

  public getPendingOrders(): readonly IOrder[] {
    return deepFreeze([...this.pendingOrders]);
  }

  public setPendingOrders(orders: readonly IOrder[]): void {
    this.pendingOrders = orders.map((o) => deepFreeze({ ...o }));
  }

  public getPendingEntrySignals(): Map<string, ISignalSetup> {
    const copy = new Map<string, ISignalSetup>();
    for (const [k, v] of this.pendingEntrySignals.entries()) {
      copy.set(k, deepFreeze(JSON.parse(JSON.stringify(v))) as ISignalSetup);
    }
    return copy;
  }

  public setPendingEntrySignals(signals: Map<string, ISignalSetup> | readonly (readonly [string, ISignalSetup])[]): void {
    this.pendingEntrySignals = new Map();
    const entries = signals instanceof Map ? signals.entries() : signals;
    for (const [k, v] of entries) {
      this.pendingEntrySignals.set(k, deepFreeze(JSON.parse(JSON.stringify(v))) as ISignalSetup);
    }
  }

  public getBaselineMetrics(): { expectancyR: number; winRate: number; profitFactor: number; maxDrawdownR?: number } | undefined {
    return this.baselineMetrics ? { ...this.baselineMetrics } : undefined;
  }

  public setBaselineMetrics(metrics: { expectancyR: number; winRate: number; profitFactor: number; maxDrawdownR?: number } | undefined): void {
    this.baselineMetrics = metrics ? deepFreeze({ ...metrics }) : undefined;
  }

  public getFeatureBaseline(): FeatureDriftBaseline | undefined {
    return this.featureBaseline ? deepFreeze({ ...this.featureBaseline }) : undefined;
  }

  public setFeatureBaseline(baseline: FeatureDriftBaseline | undefined): void {
    this.featureBaseline = baseline ? deepFreeze({ ...baseline }) : undefined;
  }

  public getReferenceRegime(): { volatilityRegime: 'LOW_VOLATILITY' | 'NORMAL_VOLATILITY' | 'HIGH_VOLATILITY'; trendRegime?: 'TRENDING_BULLISH' | 'TRENDING_BEARISH' | 'RANGING' } | undefined {
    return this.referenceRegime ? { ...this.referenceRegime } : undefined;
  }

  public setReferenceRegime(regime: { volatilityRegime: 'LOW_VOLATILITY' | 'NORMAL_VOLATILITY' | 'HIGH_VOLATILITY'; trendRegime?: 'TRENDING_BULLISH' | 'TRENDING_BEARISH' | 'RANGING' } | undefined): void {
    this.referenceRegime = regime ? deepFreeze({ ...regime }) : undefined;
  }

  public getWindowConfig(): ShadowWindowConfig | undefined {
    return this.windowConfig ? { ...this.windowConfig } : undefined;
  }

  public setWindowConfig(config: ShadowWindowConfig | undefined): void {
    this.windowConfig = config ? deepFreeze({ ...config }) : undefined;
  }

  public getRegimeHistory(): readonly RegimeObservation[] {
    return deepFreeze([...this.regimeHistory]);
  }

  public setRegimeHistory(history: readonly RegimeObservation[]): void {
    this.regimeHistory = history.map((h) => deepFreeze({ ...h }));
  }

  public getFeatureVectors(): readonly (readonly number[])[] {
    return deepFreeze([...this.featureVectors]);
  }

  public setFeatureVectors(vectors: readonly (readonly number[])[]): void {
    this.featureVectors = vectors.map((v) => deepFreeze([...v]));
  }

  public getExecutionSequences(): { nextOrderSequence: number; nextFillSequence: number; nextEventSequence: number } | null {
    return this.executionSequences ? { ...this.executionSequences } : null;
  }

  public setExecutionSequences(sequences: { nextOrderSequence: number; nextFillSequence: number; nextEventSequence: number } | null): void {
    this.executionSequences = sequences ? { ...sequences } : null;
  }

  /**
   * Saves authoritative shadow state atomically to disk.
   */
  public saveToFile(filePath?: string): void {
    const targetPath = filePath || this.persistencePath;
    if (!targetPath) return;

    const data: ShadowLedgerData = {
      version: SHADOW_SCHEMA_VERSION,
      candidateId: this.candidateId,
      candidateVersion: this.candidateVersion,
      strategyVersion: this.strategyVersion,
      featureSchemaHash: this.featureSchemaHash,
      artifactHash: this.artifactHash,
      symbol: this.symbol,
      lastMarketTimestamp: this.lastMarketTimestamp,
      observations: this.observations,
      orders: this.orders,
      fills: this.fills,
      trades: this.trades,
      windows: this.windows,
      drifts: this.drifts,
      comparisons: this.comparisons,
      health: this.health,
      events: this.events,
      activeLot: this.activeLot,
      recentCandles: this.recentCandles,
      pendingOrders: this.pendingOrders,
      pendingEntrySignals: Array.from(this.pendingEntrySignals.entries()),
      baselineMetrics: this.baselineMetrics,
      featureBaseline: this.featureBaseline,
      referenceRegime: this.referenceRegime,
      windowConfig: this.windowConfig,
      regimeHistory: this.regimeHistory,
      featureVectors: this.featureVectors,
      executionSequences: this.executionSequences ? { ...this.executionSequences } : undefined,
      cumulativeMarketHash: this.cumulativeMarketHash,
      savedAt: Date.now(),
    };

    const dir = path.dirname(targetPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const tempPath = `${targetPath}.tmp.${Date.now()}.${randomUUID()}`;
    fs.writeFileSync(tempPath, canonicalJsonStringify(data), 'utf-8');
    fs.renameSync(tempPath, targetPath);
  }

  /**
   * Authoritatively hydrates shadow ledger state from disk.
   * Fails closed upon corruption, schema mismatch, or broken candidate bindings.
   */
  public loadFromFile(filePath: string): void {
    if (!fs.existsSync(filePath)) {
      throw new Error(`SHADOW_LEDGER_FILE_NOT_FOUND: Ledger file does not exist at ${filePath}`);
    }

    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const data = JSON.parse(content) as ShadowLedgerData;

      if (!data || typeof data !== 'object') {
        throw new Error('Ledger file does not contain a valid JSON object');
      }

      // Mandatory top-level schema validation
      const mandatoryFields = [
        'version',
        'candidateId',
        'candidateVersion',
        'strategyVersion',
        'featureSchemaHash',
        'artifactHash',
        'lastMarketTimestamp',
        'observations',
        'orders',
        'fills',
        'trades',
        'health',
        'events',
      ];
      for (const field of mandatoryFields) {
        if (!(field in data)) {
          throw new Error(`Missing mandatory top-level shadow ledger field: '${field}'`);
        }
      }

      // Version check with migration support for 1.0 -> 1.1
      const supportedVersions = ['1.0', '1.1'];
      if (!supportedVersions.includes(data.version)) {
        throw new Error(
          `UNSUPPORTED_SHADOW_SCHEMA_VERSION: Schema version '${data.version}' is not supported (expected one of [${supportedVersions.join(', ')}])`,
        );
      }

      // Candidate binding check
      if (data.candidateId !== this.candidateId) {
        throw new Error(
          `CANDIDATE_BINDING_MISMATCH: Stored candidateId '${data.candidateId}' does not match expected '${this.candidateId}'`,
        );
      }
      if (data.artifactHash !== this.artifactHash) {
        throw new Error(
          `ARTIFACT_HASH_MISMATCH: Stored artifactHash '${data.artifactHash}' does not match expected '${this.artifactHash}'`,
        );
      }

      if (!Array.isArray(data.observations) || !Array.isArray(data.trades) || !Array.isArray(data.events)) {
        throw new Error('Corrupted array structures in shadow ledger file');
      }

      // Validate chronological ordering of observations
      let prevTs = 0;
      for (const obs of data.observations) {
        if (!obs || typeof obs.marketTimestamp !== 'number' || obs.marketTimestamp < prevTs) {
          throw new Error('Chronological order violation in persisted shadow observations');
        }
        prevTs = obs.marketTimestamp;
      }

      // Semantic validation of pendingEntrySignals if present
      if (data.pendingEntrySignals !== undefined) {
        if (!Array.isArray(data.pendingEntrySignals)) {
          throw new Error('Corrupted pendingEntrySignals in shadow ledger file (expected array of entries)');
        }
        for (const entry of data.pendingEntrySignals) {
          if (!Array.isArray(entry) || entry.length !== 2) {
            throw new Error('Corrupted pendingEntrySignals entry format (expected [key, signal] tuple)');
          }
          const [key, signal] = entry;
          if (typeof key !== 'string' || key.trim() === '') {
            throw new Error('Corrupted pendingEntrySignals key (expected non-empty string)');
          }
          if (!signal || typeof signal !== 'object' || typeof signal.id !== 'string' || typeof signal.symbol !== 'string') {
            throw new Error(`Corrupted pendingEntrySignals value for key '${key}'`);
          }
        }
      }

      // Semantic validation of baselineMetrics if present
      if (data.baselineMetrics !== undefined) {
        if (
          !data.baselineMetrics ||
          typeof data.baselineMetrics !== 'object' ||
          typeof data.baselineMetrics.expectancyR !== 'number' ||
          !Number.isFinite(data.baselineMetrics.expectancyR) ||
          typeof data.baselineMetrics.winRate !== 'number' ||
          !Number.isFinite(data.baselineMetrics.winRate) ||
          typeof data.baselineMetrics.profitFactor !== 'number' ||
          !Number.isFinite(data.baselineMetrics.profitFactor)
        ) {
          throw new Error('Corrupted baselineMetrics in shadow ledger file');
        }
      }

      // Semantic validation of featureBaseline if present
      if (data.featureBaseline !== undefined) {
        if (
          !data.featureBaseline ||
          typeof data.featureBaseline !== 'object' ||
          typeof data.featureBaseline.featureSchemaHash !== 'string' ||
          !Array.isArray(data.featureBaseline.featureNames) ||
          typeof data.featureBaseline.distributions !== 'object' ||
          typeof data.featureBaseline.sampleCount !== 'number' ||
          !Number.isFinite(data.featureBaseline.sampleCount) ||
          data.featureBaseline.sampleCount <= 0
        ) {
          throw new Error('Corrupted featureBaseline in shadow ledger file');
        }
      }

      // Semantic validation of referenceRegime if present
      if (data.referenceRegime !== undefined) {
        if (
          !data.referenceRegime ||
          typeof data.referenceRegime !== 'object' ||
          !['LOW_VOLATILITY', 'NORMAL_VOLATILITY', 'HIGH_VOLATILITY'].includes(data.referenceRegime.volatilityRegime)
        ) {
          throw new Error('Corrupted referenceRegime in shadow ledger file');
        }
      }

      // Semantic validation of windowConfig if present
      if (data.windowConfig !== undefined) {
        if (
          !data.windowConfig ||
          typeof data.windowConfig !== 'object' ||
          typeof data.windowConfig.shortWindowSize !== 'number' ||
          !Number.isFinite(data.windowConfig.shortWindowSize) ||
          data.windowConfig.shortWindowSize <= 0 ||
          typeof data.windowConfig.mediumWindowSize !== 'number' ||
          !Number.isFinite(data.windowConfig.mediumWindowSize) ||
          data.windowConfig.mediumWindowSize <= 0 ||
          typeof data.windowConfig.longWindowSize !== 'number' ||
          !Number.isFinite(data.windowConfig.longWindowSize) ||
          data.windowConfig.longWindowSize <= 0
        ) {
          throw new Error('Corrupted windowConfig in shadow ledger file');
        }
      }

      // Atomic commit to in-memory state
      this.observations = data.observations.map((o) => deepFreeze({ ...o }) as ShadowObservation);
      this.orders = (data.orders || []).map((o) => deepFreeze({ ...o }) as IOrder);
      this.fills = (data.fills || []).map((f) => deepFreeze({ ...f }) as IFill);
      this.trades = (data.trades || []).map((t) => deepFreeze({ ...t }) as IBacktestTrade);
      this.windows = (data.windows || []).map((w) => deepFreeze({ ...w }) as ShadowWindowMetrics);
      this.drifts = (data.drifts || []).map((d) => deepFreeze({ ...d }) as DriftEvent);
      this.comparisons = (data.comparisons || []).map((c) => deepFreeze({ ...c }) as CandidateProductionComparison);
      this.health = deepFreeze({ ...data.health });
      this.events = (data.events || []).map((e) => deepFreeze({ ...e }) as ShadowAuditRecord);
      this.lastMarketTimestamp = data.lastMarketTimestamp;
      if (data.symbol) this.symbol = data.symbol;
      this.activeLot = data.activeLot ? (deepFreeze({ ...data.activeLot }) as PositionLot) : null;
      this.recentCandles = (data.recentCandles || []).map((c) => deepFreeze({ ...c }) as ICandle);
      this.pendingOrders = (data.pendingOrders || []).map((o) => deepFreeze({ ...o }) as IOrder);
      this.pendingEntrySignals = new Map(
        (data.pendingEntrySignals || []).map(([k, v]) => [k, deepFreeze(JSON.parse(JSON.stringify(v))) as ISignalSetup]),
      );
      this.baselineMetrics = data.baselineMetrics ? deepFreeze({ ...data.baselineMetrics }) : undefined;
      this.featureBaseline = data.featureBaseline ? deepFreeze({ ...data.featureBaseline }) : undefined;
      this.referenceRegime = data.referenceRegime ? deepFreeze({ ...data.referenceRegime }) : undefined;
      this.windowConfig = data.windowConfig ? deepFreeze({ ...data.windowConfig }) : undefined;
      this.regimeHistory = (data.regimeHistory || []).map((h) => deepFreeze({ ...h }));
      this.featureVectors = (data.featureVectors || []).map((v) => deepFreeze([...v]) as number[]);
      this.executionSequences = data.executionSequences ? { ...data.executionSequences } : null;
      this.cumulativeMarketHash = data.cumulativeMarketHash || '';
    } catch (err: any) {
      throw new Error(`SHADOW_LEDGER_CORRUPT: Failed to hydrate shadow ledger: ${err.message}`);
    }
  }
}
