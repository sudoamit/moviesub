import * as fs from 'fs';
import * as path from 'path';
import { createHash, randomUUID } from 'crypto';
import { IBacktestTrade, ICandle } from '@quant/shared';
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
  ShadowWindowConfig,
  ShadowWindowMetrics,
} from './shadow-types';
import { ShadowHealthMachine } from './shadow-health-machine';
import { RegimeObservation } from './regime-drift-detector';

function deepFreeze<T extends object>(obj: T): Readonly<T> {
  Object.freeze(obj);
  for (const key of Object.getOwnPropertyNames(obj)) {
    const val = (obj as any)[key];
    if (val !== null && (typeof val === 'object' || typeof val === 'function') && !Object.isFrozen(val)) {
      deepFreeze(val);
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
  private regimeHistory: RegimeObservation[] = [];
  private featureVectors: (readonly number[])[] = [];

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
   * Emits an authoritative audit record.
   */
  public recordAuditEvent(record: ShadowAuditRecord): void {
    if (record.candidateId !== this.candidateId) {
      throw new Error(`Audit event candidateId mismatch: ${record.candidateId} vs ${this.candidateId}`);
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

  public getShadowDatasetHash(): string {
    const hash = createHash('sha256');
    hash.update(`shadow_stream_${this.symbol}_${this.candidateId}`);
    for (const c of this.recentCandles) {
      const ts = c.timestamp instanceof Date ? c.timestamp.getTime() : new Date(c.timestamp).getTime();
      hash.update(`${ts}|${c.open}|${c.high}|${c.low}|${c.close}|${c.volume}`);
    }
    for (const o of this.observations) {
      hash.update(`${o.marketTimestamp}|${o.featureVectorHash}`);
    }
    return hash.digest('hex');
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

  public getActiveLot(): Readonly<PositionLot> | null {
    return this.activeLot ? deepFreeze({ ...this.activeLot }) : null;
  }

  public setActiveLot(lot: PositionLot | null): void {
    this.activeLot = lot ? deepFreeze({ ...lot }) : null;
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
      regimeHistory: this.regimeHistory,
      featureVectors: this.featureVectors,
      savedAt: Date.now(),
    };

    const dir = path.dirname(targetPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const tempPath = `${targetPath}.tmp.${Date.now()}.${randomUUID()}`;
    fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), 'utf-8');
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

      // Version check
      if (data.version !== SHADOW_SCHEMA_VERSION) {
        throw new Error(
          `UNSUPPORTED_SHADOW_SCHEMA_VERSION: Schema version '${data.version}' is not supported (expected '${SHADOW_SCHEMA_VERSION}')`,
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
      this.regimeHistory = (data.regimeHistory || []).map((h) => deepFreeze({ ...h }));
      this.featureVectors = (data.featureVectors || []).map((v) => deepFreeze([...v]) as number[]);
    } catch (err: any) {
      throw new Error(`SHADOW_LEDGER_CORRUPT: Failed to hydrate shadow ledger: ${err.message}`);
    }
  }
}
