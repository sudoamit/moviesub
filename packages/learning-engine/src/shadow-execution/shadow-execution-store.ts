import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import {
  MarketSnapshot,
  TradingDecision,
  ChampionChallengerDecisionPair,
  ShadowOrder,
  ShadowPosition,
  ShadowOutcome
} from './types';
import { deepFreeze } from '../champion-challenger/evaluation-identity';

export interface IShadowExecutionStore {
  saveSnapshot(snapshot: MarketSnapshot): void;
  getSnapshot(snapshotId: string): MarketSnapshot | undefined;
  saveDecision(decision: TradingDecision): void;
  getDecision(decisionId: string): TradingDecision | undefined;
  saveDecisionPair(pair: ChampionChallengerDecisionPair): void;
  putIfAbsentDecisionPair(pair: ChampionChallengerDecisionPair): { inserted: boolean; pair: ChampionChallengerDecisionPair };
  getDecisionPair(pairId: string): ChampionChallengerDecisionPair | undefined;
  getDecisionPairBySnapshot(snapshotId: string): ChampionChallengerDecisionPair | undefined;
  getDecisionPairBySnapshotAndModel(snapshotId: string, challengerModelId: string): ChampionChallengerDecisionPair | undefined;
  saveShadowOrder(order: ShadowOrder): void;
  getShadowOrder(orderId: string): ShadowOrder | undefined;
  saveShadowPosition(position: ShadowPosition): void;
  getShadowPosition(positionId: string): ShadowPosition | undefined;
  getOpenShadowPositions(): ShadowPosition[];
  saveShadowOutcome(outcome: ShadowOutcome): void;
  getShadowOutcome(outcomeId: string): ShadowOutcome | undefined;
  getAllOutcomes(): ShadowOutcome[];
  reserveExecution(snapshotId: string, modelId: string): boolean;
  releaseExecution(snapshotId: string, modelId: string): void;
  clear(): void;
  executeTransaction<T>(operation: () => T): T;
}

/**
 * In-Memory Shadow Execution Store
 */
export class InMemoryShadowExecutionStore implements IShadowExecutionStore {
  private readonly snapshots = new Map<string, MarketSnapshot>();
  private readonly decisions = new Map<string, TradingDecision>();
  private readonly pairs = new Map<string, ChampionChallengerDecisionPair>();
  private readonly snapshotToPairId = new Map<string, string>();
  private readonly snapshotModelToPairId = new Map<string, string>();
  private readonly orders = new Map<string, ShadowOrder>();
  private readonly positions = new Map<string, ShadowPosition>();
  private readonly outcomes = new Map<string, ShadowOutcome>();
  private readonly activeReservations = new Set<string>();
  private inTransaction = false;

  public saveSnapshot(snapshot: MarketSnapshot): void {
    if (!snapshot || !snapshot.snapshotId) {
      throw new Error('INVALID_STORE_OPERATION: snapshot is required');
    }
    this.snapshots.set(snapshot.snapshotId, deepFreeze<MarketSnapshot>(JSON.parse(JSON.stringify(snapshot))));
  }

  public getSnapshot(snapshotId: string): MarketSnapshot | undefined {
    return this.snapshots.get(snapshotId);
  }

  public saveDecision(decision: TradingDecision): void {
    if (!decision || !decision.decisionId) {
      throw new Error('INVALID_STORE_OPERATION: decision is required');
    }
    this.decisions.set(decision.decisionId, deepFreeze<TradingDecision>(JSON.parse(JSON.stringify(decision))));
  }

  public getDecision(decisionId: string): TradingDecision | undefined {
    return this.decisions.get(decisionId);
  }

  public saveDecisionPair(pair: ChampionChallengerDecisionPair): void {
    if (!pair || !pair.pairId || !pair.snapshotId) {
      throw new Error('INVALID_STORE_OPERATION: pair is required');
    }
    const challengerModelId = pair.challengerDecision?.context?.modelIdentity?.modelId || 'default';
    const compositeKey = `${pair.snapshotId}:${challengerModelId}`;
    this.pairs.set(pair.pairId, deepFreeze<ChampionChallengerDecisionPair>(JSON.parse(JSON.stringify(pair))));
    this.snapshotToPairId.set(pair.snapshotId, pair.pairId);
    this.snapshotModelToPairId.set(compositeKey, pair.pairId);
  }

  public putIfAbsentDecisionPair(pair: ChampionChallengerDecisionPair): { inserted: boolean; pair: ChampionChallengerDecisionPair } {
    if (!pair || !pair.pairId || !pair.snapshotId) {
      throw new Error('INVALID_STORE_OPERATION: pair is required');
    }
    const challengerModelId = pair.challengerDecision?.context?.modelIdentity?.modelId || 'default';
    const compositeKey = `${pair.snapshotId}:${challengerModelId}`;
    const existingPairId = this.snapshotModelToPairId.get(compositeKey) || this.snapshotToPairId.get(pair.snapshotId);
    if (existingPairId) {
      const existing = this.pairs.get(existingPairId);
      if (existing) {
        return { inserted: false, pair: existing };
      }
    }
    this.saveDecisionPair(pair);
    return { inserted: true, pair: this.pairs.get(pair.pairId)! };
  }

  public getDecisionPair(pairId: string): ChampionChallengerDecisionPair | undefined {
    return this.pairs.get(pairId);
  }

  public getDecisionPairBySnapshot(snapshotId: string): ChampionChallengerDecisionPair | undefined {
    const pairId = this.snapshotToPairId.get(snapshotId);
    return pairId ? this.pairs.get(pairId) : undefined;
  }

  public getDecisionPairBySnapshotAndModel(snapshotId: string, challengerModelId: string): ChampionChallengerDecisionPair | undefined {
    const compositeKey = `${snapshotId}:${challengerModelId}`;
    const pairId = this.snapshotModelToPairId.get(compositeKey) || this.snapshotToPairId.get(snapshotId);
    return pairId ? this.pairs.get(pairId) : undefined;
  }

  public saveShadowOrder(order: ShadowOrder): void {
    if (!order || !order.shadowOrderId) {
      throw new Error('INVALID_STORE_OPERATION: order is required');
    }
    this.orders.set(order.shadowOrderId, deepFreeze<ShadowOrder>(JSON.parse(JSON.stringify(order))));
  }

  public getShadowOrder(orderId: string): ShadowOrder | undefined {
    return this.orders.get(orderId);
  }

  public saveShadowPosition(position: ShadowPosition): void {
    if (!position || !position.positionId) {
      throw new Error('INVALID_STORE_OPERATION: position is required');
    }
    this.positions.set(position.positionId, deepFreeze<ShadowPosition>(JSON.parse(JSON.stringify(position))));
  }

  public getShadowPosition(positionId: string): ShadowPosition | undefined {
    return this.positions.get(positionId);
  }

  public getOpenShadowPositions(): ShadowPosition[] {
    return Array.from(this.positions.values()).filter((p) => p.status === 'OPEN');
  }

  public saveShadowOutcome(outcome: ShadowOutcome): void {
    if (!outcome || !outcome.outcomeId) {
      throw new Error('INVALID_STORE_OPERATION: outcome is required');
    }
    this.outcomes.set(outcome.outcomeId, deepFreeze<ShadowOutcome>(JSON.parse(JSON.stringify(outcome))));
  }

  public getShadowOutcome(outcomeId: string): ShadowOutcome | undefined {
    return this.outcomes.get(outcomeId);
  }

  public getAllOutcomes(): ShadowOutcome[] {
    return Array.from(this.outcomes.values());
  }

  public reserveExecution(snapshotId: string, modelId: string): boolean {
    if (!snapshotId || !modelId) return false;
    const compositeKey = `${snapshotId}:${modelId}`;
    if (this.activeReservations.has(compositeKey)) {
      return false;
    }
    if (this.snapshotModelToPairId.has(compositeKey) || this.snapshotToPairId.has(snapshotId)) {
      return false;
    }
    this.activeReservations.add(compositeKey);
    return true;
  }

  public releaseExecution(snapshotId: string, modelId: string): void {
    const compositeKey = `${snapshotId}:${modelId}`;
    this.activeReservations.delete(compositeKey);
  }

  public clear(): void {
    this.snapshots.clear();
    this.decisions.clear();
    this.pairs.clear();
    this.snapshotToPairId.clear();
    this.snapshotModelToPairId.clear();
    this.orders.clear();
    this.positions.clear();
    this.outcomes.clear();
    this.activeReservations.clear();
  }

  public executeTransaction<T>(operation: () => T): T {
    if (this.inTransaction) {
      return operation();
    }
    this.inTransaction = true;
    const snapSnapshots = new Map(this.snapshots);
    const snapDecisions = new Map(this.decisions);
    const snapPairs = new Map(this.pairs);
    const snapSnapPair = new Map(this.snapshotToPairId);
    const snapOrders = new Map(this.orders);
    const snapPositions = new Map(this.positions);
    const snapOutcomes = new Map(this.outcomes);

    try {
      return operation();
    } catch (err) {
      this.snapshots.clear();
      for (const [k, v] of snapSnapshots) this.snapshots.set(k, v);
      this.decisions.clear();
      for (const [k, v] of snapDecisions) this.decisions.set(k, v);
      this.pairs.clear();
      for (const [k, v] of snapPairs) this.pairs.set(k, v);
      this.snapshotToPairId.clear();
      for (const [k, v] of snapSnapPair) this.snapshotToPairId.set(k, v);
      this.orders.clear();
      for (const [k, v] of snapOrders) this.orders.set(k, v);
      this.positions.clear();
      for (const [k, v] of snapPositions) this.positions.set(k, v);
      this.outcomes.clear();
      for (const [k, v] of snapOutcomes) this.outcomes.set(k, v);
      throw err;
    } finally {
      this.inTransaction = false;
    }
  }

  public getAllSnapshots(): MarketSnapshot[] {
    return Array.from(this.snapshots.values());
  }

  public getAllDecisions(): TradingDecision[] {
    return Array.from(this.decisions.values());
  }

  public getAllPairs(): ChampionChallengerDecisionPair[] {
    return Array.from(this.pairs.values());
  }

  public getAllOrders(): ShadowOrder[] {
    return Array.from(this.orders.values());
  }

  public getAllPositions(): ShadowPosition[] {
    return Array.from(this.positions.values());
  }
}

interface PersistedShadowData {
  readonly version: string;
  readonly snapshots: Array<[string, MarketSnapshot]>;
  readonly decisions: Array<[string, TradingDecision]>;
  readonly pairs: Array<[string, ChampionChallengerDecisionPair]>;
  readonly orders: Array<[string, ShadowOrder]>;
  readonly positions: Array<[string, ShadowPosition]>;
  readonly outcomes: Array<[string, ShadowOutcome]>;
  readonly savedAt: number;
}

/**
 * File-based Shadow Execution Store
 * Atomically persists shadow decisions, pairs, orders, and outcomes.
 */
export class FileShadowExecutionStore implements IShadowExecutionStore {
  private readonly memoryStore = new InMemoryShadowExecutionStore();
  private readonly filePath: string;
  private inTransaction = false;
  public static readonly SCHEMA_VERSION = '1.0';

  constructor(filePath: string) {
    if (!filePath || typeof filePath !== 'string' || filePath.trim() === '') {
      throw new Error('INVALID_PERSISTENCE_PATH: filePath is required');
    }
    this.filePath = filePath;
    if (fs.existsSync(filePath)) {
      this.loadFromFile();
    }
  }

  public getPersistencePath(): string {
    return this.filePath;
  }

  private saveToFile(): void {
    const data: PersistedShadowData = {
      version: FileShadowExecutionStore.SCHEMA_VERSION,
      snapshots: this.memoryStore.getAllSnapshots().map((s) => [s.snapshotId, s]),
      decisions: this.memoryStore.getAllDecisions().map((d) => [d.decisionId, d]),
      pairs: this.memoryStore.getAllPairs().map((p) => [p.pairId, p]),
      orders: this.memoryStore.getAllOrders().map((o) => [o.shadowOrderId, o]),
      positions: this.memoryStore.getAllPositions().map((p) => [p.positionId, p]),
      outcomes: this.memoryStore.getAllOutcomes().map((out) => [out.outcomeId, out]),
      savedAt: Date.now(),
    };

    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const tempPath = `${this.filePath}.tmp.${Date.now()}.${randomUUID()}`;
    fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), 'utf-8');
    fs.renameSync(tempPath, this.filePath);
  }

  public loadFromFile(): void {
    if (!fs.existsSync(this.filePath)) {
      throw new Error(`SHADOW_STORE_FILE_NOT_FOUND: Store file not found at ${this.filePath}`);
    }

    try {
      const content = fs.readFileSync(this.filePath, 'utf-8');
      const data = JSON.parse(content) as PersistedShadowData;

      if (!data || typeof data !== 'object') {
        throw new Error('Store file does not contain a valid JSON object');
      }

      if (data.version !== FileShadowExecutionStore.SCHEMA_VERSION) {
        throw new Error(`UNSUPPORTED_SHADOW_STORE_VERSION: Expected version ${FileShadowExecutionStore.SCHEMA_VERSION}`);
      }

      this.memoryStore.clear();

      if (Array.isArray(data.snapshots)) {
        for (const [_, s] of data.snapshots) this.memoryStore.saveSnapshot(s);
      }
      if (Array.isArray(data.decisions)) {
        for (const [_, d] of data.decisions) this.memoryStore.saveDecision(d);
      }
      if (Array.isArray(data.pairs)) {
        for (const [_, p] of data.pairs) this.memoryStore.saveDecisionPair(p);
      }
      if (Array.isArray(data.orders)) {
        for (const [_, o] of data.orders) this.memoryStore.saveShadowOrder(o);
      }
      if (Array.isArray(data.positions)) {
        for (const [_, p] of data.positions) this.memoryStore.saveShadowPosition(p);
      }
      if (Array.isArray(data.outcomes)) {
        for (const [_, out] of data.outcomes) this.memoryStore.saveShadowOutcome(out);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`SHADOW_STORE_CORRUPT: Failed to load from ${this.filePath}: ${message}`);
    }
  }

  public saveSnapshot(snapshot: MarketSnapshot): void {
    this.memoryStore.saveSnapshot(snapshot);
    if (!this.inTransaction) this.saveToFile();
  }

  public getSnapshot(snapshotId: string): MarketSnapshot | undefined {
    return this.memoryStore.getSnapshot(snapshotId);
  }

  public saveDecision(decision: TradingDecision): void {
    this.memoryStore.saveDecision(decision);
    if (!this.inTransaction) this.saveToFile();
  }

  public getDecision(decisionId: string): TradingDecision | undefined {
    return this.memoryStore.getDecision(decisionId);
  }

  public saveDecisionPair(pair: ChampionChallengerDecisionPair): void {
    this.memoryStore.saveDecisionPair(pair);
    if (!this.inTransaction) this.saveToFile();
  }

  public putIfAbsentDecisionPair(pair: ChampionChallengerDecisionPair): { inserted: boolean; pair: ChampionChallengerDecisionPair } {
    const result = this.memoryStore.putIfAbsentDecisionPair(pair);
    if (result.inserted && !this.inTransaction) {
      this.saveToFile();
    }
    return result;
  }

  public getDecisionPair(pairId: string): ChampionChallengerDecisionPair | undefined {
    return this.memoryStore.getDecisionPair(pairId);
  }

  public getDecisionPairBySnapshot(snapshotId: string): ChampionChallengerDecisionPair | undefined {
    return this.memoryStore.getDecisionPairBySnapshot(snapshotId);
  }

  public getDecisionPairBySnapshotAndModel(snapshotId: string, challengerModelId: string): ChampionChallengerDecisionPair | undefined {
    return this.memoryStore.getDecisionPairBySnapshotAndModel(snapshotId, challengerModelId);
  }

  public saveShadowOrder(order: ShadowOrder): void {
    this.memoryStore.saveShadowOrder(order);
    if (!this.inTransaction) this.saveToFile();
  }

  public getShadowOrder(orderId: string): ShadowOrder | undefined {
    return this.memoryStore.getShadowOrder(orderId);
  }

  public saveShadowPosition(position: ShadowPosition): void {
    this.memoryStore.saveShadowPosition(position);
    if (!this.inTransaction) this.saveToFile();
  }

  public getShadowPosition(positionId: string): ShadowPosition | undefined {
    return this.memoryStore.getShadowPosition(positionId);
  }

  public getOpenShadowPositions(): ShadowPosition[] {
    return this.memoryStore.getOpenShadowPositions();
  }

  public saveShadowOutcome(outcome: ShadowOutcome): void {
    this.memoryStore.saveShadowOutcome(outcome);
    if (!this.inTransaction) this.saveToFile();
  }

  public getShadowOutcome(outcomeId: string): ShadowOutcome | undefined {
    return this.memoryStore.getShadowOutcome(outcomeId);
  }

  public getAllOutcomes(): ShadowOutcome[] {
    return this.memoryStore.getAllOutcomes();
  }

  public reserveExecution(snapshotId: string, modelId: string): boolean {
    return this.memoryStore.reserveExecution(snapshotId, modelId);
  }

  public releaseExecution(snapshotId: string, modelId: string): void {
    this.memoryStore.releaseExecution(snapshotId, modelId);
  }

  public clear(): void {
    this.memoryStore.clear();
    if (!this.inTransaction) this.saveToFile();
  }

  public executeTransaction<T>(operation: () => T): T {
    if (this.inTransaction) {
      return operation();
    }
    this.inTransaction = true;
    try {
      const result = this.memoryStore.executeTransaction(operation);
      this.saveToFile();
      return result;
    } catch (err) {
      throw err;
    } finally {
      this.inTransaction = false;
    }
  }
}
