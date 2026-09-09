import * as fs from 'fs';
import {
  CandidateArtifact,
  CandidateStatus,
  ModelRegistryEvent,
  ModelRegistryEventType,
  ProductionModelState,
  PromotionEvidence,
} from './types';
import { CandidateBacktestRunner } from './candidate-backtest-runner';

export interface IModelRegistryEntry {
  modelId: string;
  modelVersion: string;
  strategyVersion: string;
  featureSchemaVersion: string;
  trainingSamples: number;
  validationSamples: number;
  brierScore: number;
  expectedValueR: number;
  status: 'ACTIVE' | 'SHADOW' | 'RETIRED' | 'ROLLED_BACK';
  createdAt: Date;
  promotedAt?: Date;
  retiredAt?: Date;
}

export class ModelRegistry {
  private static artifacts: Map<string, CandidateArtifact> = new Map();
  private static events: ModelRegistryEvent[] = [];
  private static promotionEvidences: Map<string, PromotionEvidence> = new Map();
  private static productionState: Map<string, ProductionModelState> = new Map();
  private static activationLocks: Set<string> = new Set();

  // Legacy model entries for backward compatibility
  private static models: Map<string, IModelRegistryEntry> = new Map();
  private static activeModelVersion = 'v2.0-ml-canonical';

  static {
    // Register initial canonical active model
    const initial: IModelRegistryEntry = {
      modelId: 'model-canon-2.0',
      modelVersion: 'v2.0-ml-canonical',
      strategyVersion: 'v2.0-smc-quant',
      featureSchemaVersion: '2.0',
      trainingSamples: 250,
      validationSamples: 50,
      brierScore: 0.18,
      expectedValueR: 1.25,
      status: 'ACTIVE',
      createdAt: new Date(),
      promotedAt: new Date(),
    };
    this.models.set(initial.modelVersion, initial);

    // Initial production state for baseline strategy
    const initialProd: ProductionModelState = {
      strategyId: 'smc-quant-baseline',
      environment: 'paper',
      activeCandidateId: 'baseline-candidate',
      activeModelVersion: 'v2.0-ml-canonical',
      activeStrategyVersion: 'v2.0-smc-quant',
      activeArtifactHash: 'initial_canonical_baseline_hash',
      activatedAt: Date.now(),
      activationId: 'activation-init-0',
    };
    this.productionState.set('smc-quant-baseline:paper', initialProd);
  }

  /**
   * Registers an immutable CandidateArtifact into the registry.
   * Performs cryptographic integrity checks (model, scaler, featureSchema, artifactHash).
   */
  public static registerCandidateArtifact(artifact: CandidateArtifact): CandidateArtifact {
    if (!artifact || typeof artifact !== 'object') {
      throw new Error('INVALID_ARTIFACT: Cannot register null or undefined artifact');
    }

    if (this.artifacts.has(artifact.candidateId)) {
      throw new Error(`DUPLICATE_CANDIDATE_ARTIFACT: Artifact for candidate ${artifact.candidateId} already registered`);
    }

    // Fail-closed verification of artifact integrity
    const valResult = CandidateBacktestRunner.validateArtifactIntegrity(artifact);
    if (!valResult.isValid) {
      throw new Error(`ARTIFACT_INTEGRITY_VIOLATION: ${valResult.reason}`);
    }

    const frozen = Object.freeze({ ...artifact });
    this.artifacts.set(artifact.candidateId, frozen);

    this.recordEvent({
      eventId: `evt-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
      candidateId: artifact.candidateId,
      artifactHash: artifact.artifactHash,
      timestamp: Date.now(),
      eventType: 'CANDIDATE_REGISTERED',
      newStatus: artifact.status,
      reason: 'Candidate artifact registered in model registry',
    });

    return frozen;
  }

  /**
   * Retrieves and verifies an immutable CandidateArtifact by candidateId.
   */
  public static getCandidateArtifact(candidateId: string): CandidateArtifact | undefined {
    const artifact = this.artifacts.get(candidateId);
    if (!artifact) return undefined;

    // Fail-closed verification upon load
    const valResult = CandidateBacktestRunner.validateArtifactIntegrity(artifact);
    if (!valResult.isValid) {
      throw new Error(`ARTIFACT_INTEGRITY_VIOLATION on get: ${valResult.reason}`);
    }

    return artifact;
  }

  /**
   * Retrieves an immutable CandidateArtifact by its canonical artifactHash.
   */
  public static getByArtifactHash(artifactHash: string): CandidateArtifact | undefined {
    for (const artifact of this.artifacts.values()) {
      if (artifact.artifactHash === artifactHash) {
        const valResult = CandidateBacktestRunner.validateArtifactIntegrity(artifact);
        if (!valResult.isValid) {
          throw new Error(`ARTIFACT_INTEGRITY_VIOLATION on getByArtifactHash: ${valResult.reason}`);
        }
        return artifact;
      }
    }
    return undefined;
  }

  /**
   * Updates candidate status with explicit state-machine validation and audit event logging.
   */
  public static updateCandidateStatus(
    candidateId: string,
    newStatus: CandidateStatus,
    reason?: string,
  ): CandidateArtifact {
    const existing = this.getCandidateArtifact(candidateId);
    if (!existing) {
      throw new Error(`CANDIDATE_NOT_FOUND: Candidate ${candidateId} does not exist in registry`);
    }

    const previousStatus = existing.status;
    const updated: CandidateArtifact = Object.freeze({
      ...existing,
      status: newStatus,
    });

    this.artifacts.set(candidateId, updated);

    let eventType: ModelRegistryEventType = 'OOS_VALIDATED';
    if (newStatus === 'SHADOW_PENDING' || newStatus === 'SHADOW_ACTIVE') eventType = 'SHADOW_STARTED';
    else if (newStatus === 'PROMOTION_ELIGIBLE') eventType = 'PROMOTION_ELIGIBLE';
    else if (newStatus === 'PROMOTED') eventType = 'PRODUCTION_ACTIVATED';
    else if (newStatus === 'REJECTED') eventType = 'PROMOTION_REJECTED';
    else if (newStatus === 'ROLLED_BACK') eventType = 'PRODUCTION_ROLLED_BACK';
    else if (newStatus === 'RETIRED') eventType = 'CANDIDATE_RETIRED';

    this.recordEvent({
      eventId: `evt-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
      candidateId,
      artifactHash: existing.artifactHash,
      timestamp: Date.now(),
      eventType,
      previousStatus,
      newStatus,
      reason,
    });

    return updated;
  }

  /**
   * Records immutable promotion evidence.
   */
  public static savePromotionEvidence(evidence: PromotionEvidence): void {
    this.promotionEvidences.set(evidence.candidateId, Object.freeze({ ...evidence }));
  }

  /**
   * Retrieves promotion evidence for a candidate.
   */
  public static getPromotionEvidence(candidateId: string): PromotionEvidence | undefined {
    return this.promotionEvidences.get(candidateId);
  }

  /**
   * Retrieves current authoritative production model state for strategy and environment.
   */
  public static getProductionState(
    strategyId = 'smc-quant-baseline',
    environment: 'paper' | 'live' = 'paper',
  ): ProductionModelState | undefined {
    const key = `${strategyId}:${environment}`;
    return this.productionState.get(key);
  }

  /**
   * Atomically sets the production model state.
   */
  public static setProductionState(state: ProductionModelState): void {
    const key = `${state.strategyId}:${state.environment}`;
    this.productionState.set(key, Object.freeze({ ...state }));
  }

  /**
   * Concurrency lock acquisition for atomic promotion transactions.
   */
  public static acquireActivationLock(strategyId: string, environment: 'paper' | 'live'): boolean {
    const key = `${strategyId}:${environment}`;
    if (this.activationLocks.has(key)) return false;
    this.activationLocks.add(key);
    return true;
  }

  /**
   * Concurrency lock release.
   */
  public static releaseActivationLock(strategyId: string, environment: 'paper' | 'live'): void {
    const key = `${strategyId}:${environment}`;
    this.activationLocks.delete(key);
  }

  /**
   * Records a registry audit event.
   */
  public static recordEvent(event: ModelRegistryEvent): void {
    this.events.push(Object.freeze({ ...event }));
  }

  /**
   * Queries audit event history.
   */
  public static getEventHistory(candidateId?: string): ModelRegistryEvent[] {
    if (!candidateId) return [...this.events];
    return this.events.filter((e) => e.candidateId === candidateId);
  }

  /**
   * Persists the entire registry to disk for crash-safe state recovery.
   */
  public static saveToFile(filePath: string): void {
    const snapshot = {
      artifacts: Array.from(this.artifacts.entries()),
      events: this.events,
      promotionEvidences: Array.from(this.promotionEvidences.entries()),
      productionState: Array.from(this.productionState.entries()),
      models: Array.from(this.models.entries()),
      activeModelVersion: this.activeModelVersion,
    };
    fs.writeFileSync(filePath, JSON.stringify(snapshot, null, 2), 'utf-8');
  }

  /**
   * Hydrates the registry from disk.
   */
  public static loadFromFile(filePath: string): void {
    if (!fs.existsSync(filePath)) return;
    const content = fs.readFileSync(filePath, 'utf-8');
    const snapshot = JSON.parse(content);
    if (snapshot.artifacts) this.artifacts = new Map(snapshot.artifacts);
    if (snapshot.events) this.events = snapshot.events;
    if (snapshot.promotionEvidences) this.promotionEvidences = new Map(snapshot.promotionEvidences);
    if (snapshot.productionState) this.productionState = new Map(snapshot.productionState);
    if (snapshot.models) this.models = new Map(snapshot.models);
    if (snapshot.activeModelVersion) this.activeModelVersion = snapshot.activeModelVersion;
  }

  /**
   * Clears in-memory registry state (useful for test isolation).
   */
  public static clear(): void {
    this.artifacts.clear();
    this.events = [];
    this.promotionEvidences.clear();
    this.productionState.clear();
    this.activationLocks.clear();
    this.models.clear();
    this.activeModelVersion = 'v2.0-ml-canonical';
  }

  // --- Legacy Methods for Backward Compatibility ---

  /**
   * Registers a new legacy model version.
   */
  public static registerModel(entry: IModelRegistryEntry): void {
    this.models.set(entry.modelVersion, Object.freeze({ ...entry }));
  }

  /**
   * Promotes a legacy model version to ACTIVE and retires previous active model.
   */
  public static promoteModel(modelVersion: string): void {
    const current = this.models.get(this.activeModelVersion);
    if (current) {
      this.models.set(
        this.activeModelVersion,
        Object.freeze({ ...current, status: 'RETIRED', retiredAt: new Date() }),
      );
    }

    const candidate = this.models.get(modelVersion);
    if (!candidate) {
      throw new Error(`Model version ${modelVersion} not found in registry.`);
    }

    this.models.set(
      modelVersion,
      Object.freeze({ ...candidate, status: 'ACTIVE', promotedAt: new Date() }),
    );
    this.activeModelVersion = modelVersion;
  }

  /**
   * Reverts to a previous legacy model version.
   */
  public static rollbackModel(targetModelVersion: string): void {
    const current = this.models.get(this.activeModelVersion);
    if (current) {
      this.models.set(
        this.activeModelVersion,
        Object.freeze({ ...current, status: 'ROLLED_BACK', retiredAt: new Date() }),
      );
    }

    const target = this.models.get(targetModelVersion);
    if (!target) {
      throw new Error(`Target model version ${targetModelVersion} not found in registry.`);
    }

    this.models.set(targetModelVersion, Object.freeze({ ...target, status: 'ACTIVE' }));
    this.activeModelVersion = targetModelVersion;
  }

  /**
   * Returns current active legacy model version.
   */
  public static getActiveModel(): IModelRegistryEntry | undefined {
    return this.models.get(this.activeModelVersion);
  }

  /**
   * Returns all registered legacy models.
   */
  public static getAllModels(): IModelRegistryEntry[] {
    return Array.from(this.models.values());
  }
}

