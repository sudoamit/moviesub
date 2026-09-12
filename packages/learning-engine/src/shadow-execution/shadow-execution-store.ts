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

export type ExecutionReservationStatus =
  | 'RESERVED'
  | 'EXECUTING'
  | 'LIVE_SUBMITTED'
  | 'COMMITTED'
  | 'FAILED_RETRYABLE'
  | 'EXECUTION_UNKNOWN'
  | 'FAILED_FINAL';

export interface ExecutionReservation {
  readonly snapshotId: string;
  readonly modelId: string;
  readonly status: ExecutionReservationStatus;
  readonly reservationToken: string;
  readonly epoch: number;
  readonly reservedAt: number;
  readonly lastUpdatedAt: number;
}

export interface ReservationAcquireResult {
  readonly acquired: boolean;
  readonly reservationToken?: string;
  readonly epoch?: number;
  readonly currentStatus?: ExecutionReservationStatus;
}

export interface ReconcileOptions {
  readonly liveOrder?: any;
  readonly championDecision?: TradingDecision;
  readonly challengerDecision?: TradingDecision;
  readonly pair?: ChampionChallengerDecisionPair;
}

/**
 * Authoritative state transition matrix enforcing strict lifecycle invariant sequencing.
 */
const VALID_TRANSITIONS: Record<ExecutionReservationStatus, ReadonlySet<ExecutionReservationStatus>> = {
  RESERVED: new Set(['EXECUTING', 'FAILED_RETRYABLE', 'EXECUTION_UNKNOWN', 'FAILED_FINAL']),
  EXECUTING: new Set(['LIVE_SUBMITTED', 'FAILED_RETRYABLE', 'EXECUTION_UNKNOWN', 'FAILED_FINAL']),
  LIVE_SUBMITTED: new Set(['COMMITTED', 'EXECUTION_UNKNOWN']),
  EXECUTION_UNKNOWN: new Set(['COMMITTED', 'FAILED_RETRYABLE', 'EXECUTION_UNKNOWN', 'FAILED_FINAL']),
  FAILED_RETRYABLE: new Set(['RESERVED']),
  COMMITTED: new Set([]),
  FAILED_FINAL: new Set([]),
};

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
  reserveExecution(snapshotId: string, modelId: string): ReservationAcquireResult;
  updateReservationStatus(
    snapshotId: string,
    modelId: string,
    status: ExecutionReservationStatus,
    reservationToken: string
  ): boolean;
  getReservation(snapshotId: string, modelId: string): ExecutionReservation | undefined;
  commitExecution(snapshotId: string, modelId: string, reservationToken: string): boolean;
  releaseExecution(
    snapshotId: string,
    modelId: string,
    status: ExecutionReservationStatus,
    reservationToken: string
  ): boolean;
  reconcileExecution(
    snapshotId: string,
    modelId: string,
    reservationToken: string,
    brokerQueryStatus: 'FOUND' | 'NOT_FOUND' | 'BROKER_STILL_UNKNOWN',
    options?: ReconcileOptions
  ): { reconciled: boolean; newStatus: ExecutionReservationStatus };
  reconcileUnknownExecution(
    snapshotId: string,
    modelId: string,
    reservationToken: string,
    brokerStatus: 'FOUND' | 'NOT_FOUND' | 'BROKER_STILL_UNKNOWN',
    liveOrder?: any
  ): { reconciled: boolean; newStatus: ExecutionReservationStatus };
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
  private readonly reservations = new Map<string, ExecutionReservation>();
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

  public reserveExecution(snapshotId: string, modelId: string): ReservationAcquireResult {
    if (!snapshotId || !modelId) return { acquired: false };
    const compositeKey = `${snapshotId}:${modelId}`;
    const existing = this.reservations.get(compositeKey);

    if (existing && existing.status !== 'FAILED_RETRYABLE') {
      return { acquired: false, currentStatus: existing.status };
    }
    if (this.snapshotModelToPairId.has(compositeKey) || this.snapshotToPairId.has(snapshotId)) {
      return { acquired: false, currentStatus: 'COMMITTED' };
    }

    const newEpoch = existing ? existing.epoch + 1 : 1;
    const token = randomUUID();
    const res: ExecutionReservation = {
      snapshotId,
      modelId,
      status: 'RESERVED',
      reservationToken: token,
      epoch: newEpoch,
      reservedAt: Date.now(),
      lastUpdatedAt: Date.now(),
    };
    this.reservations.set(compositeKey, res);
    return { acquired: true, reservationToken: token, epoch: newEpoch };
  }

  public saveReservation(reservation: ExecutionReservation): void {
    const compositeKey = `${reservation.snapshotId}:${reservation.modelId}`;
    this.reservations.set(compositeKey, reservation);
  }

  public updateReservationStatus(
    snapshotId: string,
    modelId: string,
    status: ExecutionReservationStatus,
    reservationToken: string
  ): boolean {
    if (!reservationToken) return false;
    const compositeKey = `${snapshotId}:${modelId}`;
    const existing = this.reservations.get(compositeKey);
    if (!existing) return false;

    // Fencing token validation
    if (existing.reservationToken !== reservationToken) {
      return false;
    }

    // State transition matrix validation
    const allowed = VALID_TRANSITIONS[existing.status];
    if (!allowed || !allowed.has(status)) {
      return false;
    }

    this.reservations.set(compositeKey, {
      ...existing,
      status,
      lastUpdatedAt: Date.now(),
    });
    return true;
  }

  public getReservation(snapshotId: string, modelId: string): ExecutionReservation | undefined {
    return this.reservations.get(`${snapshotId}:${modelId}`);
  }

  public commitExecution(snapshotId: string, modelId: string, reservationToken: string): boolean {
    if (!reservationToken) return false;
    const compositeKey = `${snapshotId}:${modelId}`;
    const existing = this.reservations.get(compositeKey);
    if (!existing) return false;

    if (existing.reservationToken !== reservationToken) {
      return false;
    }

    const allowed = VALID_TRANSITIONS[existing.status];
    if (!allowed || !allowed.has('COMMITTED')) {
      return false;
    }

    this.reservations.set(compositeKey, {
      ...existing,
      status: 'COMMITTED',
      lastUpdatedAt: Date.now(),
    });
    return true;
  }

  public releaseExecution(
    snapshotId: string,
    modelId: string,
    status: ExecutionReservationStatus,
    reservationToken: string
  ): boolean {
    if (!reservationToken) return false;
    const compositeKey = `${snapshotId}:${modelId}`;
    const existing = this.reservations.get(compositeKey);
    if (!existing) return false;

    if (existing.reservationToken !== reservationToken) {
      return false;
    }

    const allowed = VALID_TRANSITIONS[existing.status];
    if (!allowed || !allowed.has(status)) {
      return false;
    }

    this.reservations.set(compositeKey, {
      ...existing,
      status,
      lastUpdatedAt: Date.now(),
    });
    return true;
  }

  public reconcileExecution(
    snapshotId: string,
    modelId: string,
    reservationToken: string,
    brokerQueryStatus: 'FOUND' | 'NOT_FOUND' | 'BROKER_STILL_UNKNOWN',
    options?: ReconcileOptions
  ): { reconciled: boolean; newStatus: ExecutionReservationStatus } {
    const compositeKey = `${snapshotId}:${modelId}`;
    const res = this.reservations.get(compositeKey);

    if (!res || !reservationToken || res.reservationToken !== reservationToken) {
      return { reconciled: false, newStatus: res?.status || 'FAILED_FINAL' };
    }

    if (res.status !== 'EXECUTION_UNKNOWN' && res.status !== 'LIVE_SUBMITTED') {
      return { reconciled: false, newStatus: res.status };
    }

    if (brokerQueryStatus === 'BROKER_STILL_UNKNOWN') {
      // Fail closed: broker query is ambiguous. Keep lock strictly in place.
      return { reconciled: false, newStatus: res.status };
    }

    if (brokerQueryStatus === 'NOT_FOUND') {
      // Order definitively does not exist on broker -> transition to FAILED_RETRYABLE
      const allowed = VALID_TRANSITIONS[res.status];
      if (!allowed || !allowed.has('FAILED_RETRYABLE')) {
        return { reconciled: false, newStatus: res.status };
      }
      this.reservations.set(compositeKey, {
        ...res,
        status: 'FAILED_RETRYABLE',
        lastUpdatedAt: Date.now(),
      });
      return { reconciled: true, newStatus: 'FAILED_RETRYABLE' };
    }

    // brokerQueryStatus === 'FOUND'
    // Order exists on broker -> Reconstruct/persist durable decisions & DecisionPair before committing
    if (options?.championDecision) {
      this.saveDecision(options.championDecision);
    }
    if (options?.challengerDecision) {
      this.saveDecision(options.challengerDecision);
    }
    if (options?.pair) {
      this.putIfAbsentDecisionPair(options.pair);
    }

    this.reservations.set(compositeKey, {
      ...res,
      status: 'COMMITTED',
      lastUpdatedAt: Date.now(),
    });
    return { reconciled: true, newStatus: 'COMMITTED' };
  }

  public reconcileUnknownExecution(
    snapshotId: string,
    modelId: string,
    reservationToken: string,
    brokerStatus: 'FOUND' | 'NOT_FOUND' | 'BROKER_STILL_UNKNOWN',
    liveOrder?: any
  ): { reconciled: boolean; newStatus: ExecutionReservationStatus } {
    return this.reconcileExecution(snapshotId, modelId, reservationToken, brokerStatus, { liveOrder });
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
    this.reservations.clear();
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
    const snapReservations = new Map(this.reservations);

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
      this.reservations.clear();
      for (const [k, v] of snapReservations) this.reservations.set(k, v);
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
 * Provides durable cross-process file-level locking with monotonic epoch, ownership fencing,
 * state transition validation, and crash-safe interrupted retry claim recovery.
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

  private getLockFilePath(snapshotId: string, modelId: string): string {
    const dir = path.dirname(this.filePath);
    return path.join(dir, `.lock.${snapshotId}.${modelId}`);
  }

  /**
   * Deterministic recovery for interrupted retry claims or crashed workers with generation/epoch validation.
   */
  private recoverInterruptedClaim(snapshotId: string, modelId: string): void {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) return;

    const lockFile = this.getLockFilePath(snapshotId, modelId);
    const prefix = `.claim.${snapshotId}.${modelId}.`;

    // 1. If DecisionPair already exists in persistent store, any lock or claim is obsolete post-commit residue
    if (this.getDecisionPairBySnapshotAndModel(snapshotId, modelId) || this.getDecisionPairBySnapshot(snapshotId)) {
      if (fs.existsSync(lockFile)) {
        try { fs.unlinkSync(lockFile); } catch {}
      }
      try {
        const files = fs.readdirSync(dir);
        for (const file of files) {
          if (file.startsWith(prefix)) {
            try { fs.unlinkSync(path.join(dir, file)); } catch {}
          }
        }
      } catch {}
      return;
    }

    // 2. Scan claim files and validate generation/epoch against current state
    try {
      const files = fs.readdirSync(dir);
      const claimCandidates: Array<{ path: string; reservation: ExecutionReservation }> = [];

      for (const file of files) {
        if (file.startsWith(prefix)) {
          const claimPath = path.join(dir, file);
          try {
            const content = fs.readFileSync(claimPath, 'utf-8');
            const claimReservation = JSON.parse(content) as ExecutionReservation;
            if (claimReservation && (claimReservation.status === 'RESERVED' || claimReservation.status === 'FAILED_RETRYABLE')) {
              claimCandidates.push({ path: claimPath, reservation: claimReservation });
            } else {
              try { fs.unlinkSync(claimPath); } catch {}
            }
          } catch {
            try { fs.unlinkSync(claimPath); } catch {}
          }
        }
      }

      if (fs.existsSync(lockFile)) {
        try {
          const lockContent = fs.readFileSync(lockFile, 'utf-8');
          const lockReservation = JSON.parse(lockContent) as ExecutionReservation;
          // Unlink all claims with epoch <= lockReservation.epoch (they are obsolete prior generations)
          for (const claim of claimCandidates) {
            if (claim.reservation.epoch <= lockReservation.epoch) {
              try { fs.unlinkSync(claim.path); } catch {}
            }
          }
        } catch {}
      } else if (claimCandidates.length > 0) {
        // Lock file is missing -> find authoritative claim with highest monotonic epoch
        claimCandidates.sort((a, b) => b.reservation.epoch - a.reservation.epoch);
        const best = claimCandidates[0];
        try {
          fs.renameSync(best.path, lockFile);
          this.memoryStore.saveReservation(best.reservation);
        } catch {}
        // Clean up any remaining older claims
        for (let i = 1; i < claimCandidates.length; i++) {
          try { fs.unlinkSync(claimCandidates[i].path); } catch {}
        }
      }
    } catch {}
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
    const pair = this.memoryStore.getDecisionPair(pairId);
    if (pair) {
      this.cleanupStaleLocksForPair(pair);
    }
    return pair;
  }

  public getDecisionPairBySnapshot(snapshotId: string): ChampionChallengerDecisionPair | undefined {
    const pair = this.memoryStore.getDecisionPairBySnapshot(snapshotId);
    if (pair) {
      this.cleanupStaleLocksForPair(pair);
    }
    return pair;
  }

  public getDecisionPairBySnapshotAndModel(snapshotId: string, challengerModelId: string): ChampionChallengerDecisionPair | undefined {
    const pair = this.memoryStore.getDecisionPairBySnapshotAndModel(snapshotId, challengerModelId);
    if (pair) {
      this.cleanupStaleLocksForPair(pair);
    }
    return pair;
  }

  private cleanupStaleLocksForPair(pair: ChampionChallengerDecisionPair): void {
    const challengerModelId = pair.challengerDecision?.context?.modelIdentity?.modelId || 'default';
    const champModelId = pair.championDecision?.context?.modelIdentity?.modelId || 'default';
    const lock1 = this.getLockFilePath(pair.snapshotId, challengerModelId);
    const lock2 = this.getLockFilePath(pair.snapshotId, champModelId);
    if (fs.existsSync(lock1)) { try { fs.unlinkSync(lock1); } catch {} }
    if (fs.existsSync(lock2)) { try { fs.unlinkSync(lock2); } catch {} }
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

  public reserveExecution(snapshotId: string, modelId: string): ReservationAcquireResult {
    if (!snapshotId || !modelId) return { acquired: false };
    const lockFile = this.getLockFilePath(snapshotId, modelId);

    // If pair already exists in persistent store, clean up any post-commit crash lock residue and reject
    if (this.getDecisionPairBySnapshotAndModel(snapshotId, modelId) || this.getDecisionPairBySnapshot(snapshotId)) {
      if (fs.existsSync(lockFile)) {
        try { fs.unlinkSync(lockFile); } catch {}
      }
      return { acquired: false, currentStatus: 'COMMITTED' };
    }

    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Check and recover any interrupted retry claim first with epoch validation
    this.recoverInterruptedClaim(snapshotId, modelId);

    const reservationToken = randomUUID();
    const reservationData: ExecutionReservation = {
      snapshotId,
      modelId,
      status: 'RESERVED',
      reservationToken,
      epoch: 1,
      reservedAt: Date.now(),
      lastUpdatedAt: Date.now(),
    };

    try {
      fs.writeFileSync(lockFile, JSON.stringify(reservationData), { flag: 'wx' });
      this.memoryStore.saveReservation(reservationData);
      return { acquired: true, reservationToken, epoch: 1 };
    } catch (err: any) {
      if (err.code === 'EEXIST') {
        try {
          const content = fs.readFileSync(lockFile, 'utf-8');
          const existing = JSON.parse(content) as ExecutionReservation;

          // If previous execution was explicitly marked FAILED_RETRYABLE, claim retry atomically via POSIX rename CAS
          if (existing && existing.status === 'FAILED_RETRYABLE') {
            const claimToken = randomUUID();
            const tempClaimFile = path.join(dir, `.claim.${snapshotId}.${modelId}.${claimToken}`);
            try {
              // POSIX atomic rename of lockFile -> tempClaimFile. Exactly one worker wins this race!
              fs.renameSync(lockFile, tempClaimFile);

              const newEpoch = (existing.epoch || 1) + 1;
              const newReservationData: ExecutionReservation = {
                snapshotId,
                modelId,
                status: 'RESERVED',
                reservationToken: claimToken,
                epoch: newEpoch,
                reservedAt: Date.now(),
                lastUpdatedAt: Date.now(),
              };

              fs.writeFileSync(tempClaimFile, JSON.stringify(newReservationData), 'utf-8');
              fs.renameSync(tempClaimFile, lockFile);

              this.memoryStore.saveReservation(newReservationData);
              return { acquired: true, reservationToken: claimToken, epoch: newEpoch };
            } catch (claimErr: any) {
              // Lost atomic rename race or ENOENT -> fail closed
              return { acquired: false };
            }
          }
          return { acquired: false, currentStatus: existing?.status };
        } catch {
          return { acquired: false };
        }
      }
      throw err;
    }
  }

  public updateReservationStatus(
    snapshotId: string,
    modelId: string,
    status: ExecutionReservationStatus,
    reservationToken: string
  ): boolean {
    if (!reservationToken) return false;
    const lockFile = this.getLockFilePath(snapshotId, modelId);
    this.recoverInterruptedClaim(snapshotId, modelId);
    const currentRes = this.getReservation(snapshotId, modelId);

    if (!currentRes || currentRes.reservationToken !== reservationToken) {
      return false;
    }

    const allowed = VALID_TRANSITIONS[currentRes.status];
    if (!allowed || !allowed.has(status)) {
      return false;
    }

    // 1. File-first durable persistence
    if (fs.existsSync(lockFile)) {
      try {
        const data: ExecutionReservation = {
          snapshotId,
          modelId,
          status,
          reservationToken: currentRes.reservationToken,
          epoch: currentRes.epoch,
          reservedAt: currentRes.reservedAt,
          lastUpdatedAt: Date.now(),
        };
        fs.writeFileSync(lockFile, JSON.stringify(data), 'utf-8');
      } catch {
        return false;
      }
    }

    // 2. Memory store synchronization
    return this.memoryStore.updateReservationStatus(snapshotId, modelId, status, reservationToken);
  }

  public getReservation(snapshotId: string, modelId: string): ExecutionReservation | undefined {
    // If DecisionPair is already persisted, any lock residue is obsolete
    if (this.getDecisionPairBySnapshotAndModel(snapshotId, modelId) || this.getDecisionPairBySnapshot(snapshotId)) {
      const lockFile = this.getLockFilePath(snapshotId, modelId);
      if (fs.existsSync(lockFile)) {
        try { fs.unlinkSync(lockFile); } catch {}
      }
      return undefined;
    }

    this.recoverInterruptedClaim(snapshotId, modelId);
    const lockFile = this.getLockFilePath(snapshotId, modelId);
    if (fs.existsSync(lockFile)) {
      try {
        const content = fs.readFileSync(lockFile, 'utf-8');
        return JSON.parse(content) as ExecutionReservation;
      } catch {}
    }
    return this.memoryStore.getReservation(snapshotId, modelId);
  }

  public commitExecution(snapshotId: string, modelId: string, reservationToken: string): boolean {
    if (!reservationToken) return false;
    const lockFile = this.getLockFilePath(snapshotId, modelId);
    this.recoverInterruptedClaim(snapshotId, modelId);
    const existing = this.getReservation(snapshotId, modelId);

    if (!existing || existing.reservationToken !== reservationToken) {
      return false;
    }

    const allowed = VALID_TRANSITIONS[existing.status];
    if (!allowed || !allowed.has('COMMITTED')) {
      return false;
    }

    // 1. Durable file state: delete lockfile from disk FIRST
    if (fs.existsSync(lockFile)) {
      try {
        fs.unlinkSync(lockFile);
      } catch {
        return false;
      }
    }

    // 2. Memory store synchronization
    return this.memoryStore.commitExecution(snapshotId, modelId, reservationToken);
  }

  public releaseExecution(
    snapshotId: string,
    modelId: string,
    status: ExecutionReservationStatus,
    reservationToken: string
  ): boolean {
    if (!reservationToken) return false;
    const lockFile = this.getLockFilePath(snapshotId, modelId);
    this.recoverInterruptedClaim(snapshotId, modelId);
    const existing = this.getReservation(snapshotId, modelId);

    if (!existing || existing.reservationToken !== reservationToken) {
      return false;
    }

    const allowed = VALID_TRANSITIONS[existing.status];
    if (!allowed || !allowed.has(status)) {
      return false;
    }

    // 1. Durable file state: write lock file on disk FIRST
    if (fs.existsSync(lockFile)) {
      try {
        const data: ExecutionReservation = {
          snapshotId,
          modelId,
          status,
          reservationToken: existing.reservationToken,
          epoch: existing.epoch,
          reservedAt: existing.reservedAt,
          lastUpdatedAt: Date.now(),
        };
        fs.writeFileSync(lockFile, JSON.stringify(data), 'utf-8');
      } catch {
        return false;
      }
    }

    // 2. Memory store synchronization
    return this.memoryStore.releaseExecution(snapshotId, modelId, status, reservationToken);
  }

  public reconcileExecution(
    snapshotId: string,
    modelId: string,
    reservationToken: string,
    brokerQueryStatus: 'FOUND' | 'NOT_FOUND' | 'BROKER_STILL_UNKNOWN',
    options?: ReconcileOptions
  ): { reconciled: boolean; newStatus: ExecutionReservationStatus } {
    this.recoverInterruptedClaim(snapshotId, modelId);
    const lockFile = this.getLockFilePath(snapshotId, modelId);
    if (!this.memoryStore.getReservation(snapshotId, modelId) && fs.existsSync(lockFile)) {
      try {
        const content = fs.readFileSync(lockFile, 'utf-8');
        const existing = JSON.parse(content) as ExecutionReservation;
        this.memoryStore.saveReservation(existing);
      } catch {}
    }

    const result = this.memoryStore.reconcileExecution(snapshotId, modelId, reservationToken, brokerQueryStatus, options);

    if (result.reconciled) {
      if (result.newStatus === 'COMMITTED') {
        if (!this.inTransaction) this.saveToFile();
        if (fs.existsSync(lockFile)) {
          try { fs.unlinkSync(lockFile); } catch {}
        }
      } else {
        // FAILED_RETRYABLE -> write updated status to lock file
        const diskRes = this.getReservation(snapshotId, modelId);
        if (diskRes) {
          const data: ExecutionReservation = {
            snapshotId,
            modelId,
            status: result.newStatus,
            reservationToken: diskRes.reservationToken,
            epoch: diskRes.epoch,
            reservedAt: diskRes.reservedAt,
            lastUpdatedAt: Date.now(),
          };
          try {
            fs.writeFileSync(lockFile, JSON.stringify(data), 'utf-8');
          } catch {}
        }
      }
    }
    return result;
  }

  public reconcileUnknownExecution(
    snapshotId: string,
    modelId: string,
    reservationToken: string,
    brokerStatus: 'FOUND' | 'NOT_FOUND' | 'BROKER_STILL_UNKNOWN',
    liveOrder?: any
  ): { reconciled: boolean; newStatus: ExecutionReservationStatus } {
    return this.reconcileExecution(snapshotId, modelId, reservationToken, brokerStatus, { liveOrder });
  }

  public getAllSnapshots(): MarketSnapshot[] {
    return this.memoryStore.getAllSnapshots();
  }

  public getAllDecisions(): TradingDecision[] {
    return this.memoryStore.getAllDecisions();
  }

  public getAllPairs(): ChampionChallengerDecisionPair[] {
    return this.memoryStore.getAllPairs();
  }

  public getAllOrders(): ShadowOrder[] {
    return this.memoryStore.getAllOrders();
  }

  public getAllPositions(): ShadowPosition[] {
    return this.memoryStore.getAllPositions();
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
