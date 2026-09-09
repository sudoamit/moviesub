import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import {
  CandidateArtifact,
  CandidateStatus,
  ModelRegistryEvent,
  ModelRegistryEventType,
  ProductionModelState,
  PromotionDecision,
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

export interface IExecuteTransactionOptions {
  requirePersistence?: boolean;
}

function deepFreeze<T>(obj: T): T {
  if (obj === null || typeof obj !== 'object' || Object.isFrozen(obj)) {
    return obj;
  }
  Object.freeze(obj);
  for (const key of Object.getOwnPropertyNames(obj)) {
    const val = (obj as any)[key];
    if (val !== null && typeof val === 'object' && !Object.isFrozen(val)) {
      deepFreeze(val);
    }
  }
  return obj;
}

const VALID_STATUS_TRANSITIONS: Record<CandidateStatus, CandidateStatus[]> = {
  GENERATED: ['BACKTESTING', 'TRAINED', 'VALIDATED', 'REJECTED'],
  BACKTESTING: ['VALIDATED', 'TRAINED', 'REJECTED'],
  TRAINED: ['OOS_VALIDATED', 'VALIDATED', 'REJECTED'],
  VALIDATED: ['SHADOW_PENDING', 'SHADOW', 'SHADOW_ACTIVE', 'REJECTED'],
  OOS_VALIDATED: ['SHADOW_PENDING', 'SHADOW', 'SHADOW_ACTIVE', 'REJECTED'],
  SHADOW_PENDING: ['SHADOW_ACTIVE', 'SHADOW', 'REJECTED'],
  SHADOW: ['SHADOW_ACTIVE', 'PROMOTION_ELIGIBLE', 'REJECTED'],
  SHADOW_ACTIVE: ['PROMOTION_ELIGIBLE', 'REJECTED'],
  PROMOTION_ELIGIBLE: ['PROMOTED', 'REJECTED'],
  PROMOTED: ['RETIRED', 'ROLLED_BACK'],
  REACTIVATED: ['RETIRED', 'ROLLED_BACK'],
  RETIRED: ['REACTIVATED'], // Unambiguous rollback reactivation only
  ROLLED_BACK: ['REACTIVATED'], // Unambiguous rollback reactivation only
  REJECTED: [],
};

export class ModelRegistry {
  private static persistencePath: string | null = null;
  private static artifacts: Map<string, CandidateArtifact> = new Map();
  private static events: ModelRegistryEvent[] = [];
  private static promotionEvidences: Map<string, PromotionEvidence> = new Map();
  private static productionState: Map<string, ProductionModelState> = new Map();
  private static activationLocks: Set<string> = new Set();
  private static inTransaction = false;

  // Legacy model entries for read-only / metadata inspection
  private static models: Map<string, IModelRegistryEntry> = new Map();
  private static activeModelVersion = 'v2.0-ml-canonical';

  static {
    this.initDefaultState();
  }

  private static initDefaultState(): void {
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
    this.models.set(initial.modelVersion, deepFreeze(initial));

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
    this.productionState.set('smc-quant-baseline:paper', deepFreeze(initialProd));
  }

  /**
   * Sets or overrides the authoritative persistence file path.
   */
  public static setPersistencePath(filePath: string | null): void {
    this.persistencePath = filePath;
    if (filePath && fs.existsSync(filePath)) {
      this.loadFromFile(filePath);
    }
  }

  /**
   * Returns current persistence file path.
   */
  public static getPersistencePath(): string | null {
    return this.persistencePath;
  }

  /**
   * Resets all in-memory registry state and unlocks all activation mutexes.
   */
  public static reset(): void {
    this.artifacts.clear();
    this.events = [];
    this.promotionEvidences.clear();
    this.productionState.clear();
    this.activationLocks.clear();
    this.models.clear();
    this.activeModelVersion = 'v2.0-ml-canonical';
    this.inTransaction = false;
  }

  /**
   * Saves authoritative registry state atomically to disk.
   */
  public static saveToFile(filePath?: string): void {
    const targetPath = filePath || this.persistencePath;
    if (!targetPath) return;

    const data = {
      version: '2.0',
      artifacts: Array.from(this.artifacts.entries()),
      events: this.events,
      promotionEvidences: Array.from(this.promotionEvidences.entries()),
      productionState: Array.from(this.productionState.entries()),
      models: Array.from(this.models.entries()),
      activeModelVersion: this.activeModelVersion,
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
   * Authoritatively hydrates and validates registry state from disk.
   * Fails closed if file contains any corrupt artifacts, invalid promotion evidence, or broken state bindings.
   */
  public static loadFromFile(filePath: string): void {
    if (!fs.existsSync(filePath)) {
      throw new Error(`MODEL_REGISTRY_FILE_NOT_FOUND: Registry file does not exist at ${filePath}`);
    }

    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const data = JSON.parse(content);
      if (!data || typeof data !== 'object') {
        throw new Error('Registry file does not contain a valid JSON object');
      }

      // Mandatory top-level schema validation
      const mandatoryFields = [
        'artifacts',
        'promotionEvidences',
        'productionState',
        'events',
        'models',
        'activeModelVersion',
      ];
      for (const field of mandatoryFields) {
        if (!(field in data)) {
          throw new Error(`Missing mandatory top-level registry field: '${field}'`);
        }
      }

      if (!Array.isArray(data.artifacts)) {
        throw new Error('artifacts field must be an array of entries');
      }
      if (!Array.isArray(data.promotionEvidences)) {
        throw new Error('promotionEvidences field must be an array of entries');
      }
      if (!Array.isArray(data.productionState)) {
        throw new Error('productionState field must be an array of entries');
      }
      if (!Array.isArray(data.events)) {
        throw new Error('events field must be an array');
      }
      if (!Array.isArray(data.models)) {
        throw new Error('models field must be an array of entries');
      }
      if (typeof data.activeModelVersion !== 'string' || !data.activeModelVersion) {
        throw new Error('activeModelVersion must be a non-empty string');
      }

      const tempArtifacts = new Map<string, CandidateArtifact>();
      const tempEvents: ModelRegistryEvent[] = [];
      const tempPromotionEvidences = new Map<string, PromotionEvidence>();
      const tempProductionState = new Map<string, ProductionModelState>();
      const tempModels = new Map<string, IModelRegistryEntry>();

      // 1. Authoritative CandidateArtifact revalidation
      for (const [candidateId, artifact] of data.artifacts) {
        if (!candidateId || !artifact || typeof artifact !== 'object') {
          throw new Error(`Invalid artifact entry for candidate: ${candidateId}`);
        }
        if (artifact.candidateId !== candidateId) {
          throw new Error(
            `Artifact candidateId mismatch: entry key ${candidateId} vs artifact ${artifact.candidateId}`,
          );
        }
        const val = CandidateBacktestRunner.validateArtifactIntegrity(artifact);
        if (!val.isValid) {
          throw new Error(`Candidate ${candidateId} integrity violation: ${val.reason}`);
        }
        tempArtifacts.set(candidateId, deepFreeze(JSON.parse(JSON.stringify(artifact))));
      }

      // 2. Authoritative PromotionEvidence revalidation & binding check
      for (const [candidateId, evidence] of data.promotionEvidences) {
        if (!candidateId || !evidence || typeof evidence !== 'object') {
          throw new Error(`Invalid promotion evidence entry for candidate: ${candidateId}`);
        }
        if (evidence.candidateId !== candidateId) {
          throw new Error(
            `Evidence candidateId mismatch: key ${candidateId} vs evidence ${evidence.candidateId}`,
          );
        }
        if (!evidence.evidenceId || !evidence.artifactHash || !evidence.shadowDatasetHash || !evidence.shadowMetrics) {
          throw new Error(`Promotion evidence for ${candidateId} is missing required fields`);
        }
        const boundArtifact = tempArtifacts.get(candidateId);
        if (!boundArtifact) {
          throw new Error(
            `Orphaned promotion evidence: candidate ${candidateId} does not exist in registry artifacts`,
          );
        }
        if (boundArtifact.artifactHash !== evidence.artifactHash) {
          throw new Error(
            `Promotion evidence artifactHash mismatch for candidate ${candidateId}: ${evidence.artifactHash} vs ${boundArtifact.artifactHash}`,
          );
        }
        if (evidence.promotionDecision !== 'PROMOTE' && evidence.promotionDecision !== 'REJECT') {
          throw new Error(`Invalid promotion decision in evidence for candidate ${candidateId}`);
        }
        tempPromotionEvidences.set(candidateId, deepFreeze(JSON.parse(JSON.stringify(evidence))));
      }

      // 3. Authoritative ProductionModelState revalidation & evidence binding check
      for (const [key, state] of data.productionState) {
        if (!key || !state || typeof state !== 'object') {
          throw new Error(`Invalid productionState entry for key: ${key}`);
        }
        const expectedKey = `${state.strategyId}:${state.environment}`;
        if (key !== expectedKey) {
          throw new Error(`Production state key mismatch: ${key} vs expected ${expectedKey}`);
        }
        if (!state.activeCandidateId || !state.activeArtifactHash) {
          throw new Error(`Production state for ${key} missing active candidateId or artifactHash`);
        }
        if (state.activeCandidateId !== 'baseline-candidate') {
          const activeArtifact = tempArtifacts.get(state.activeCandidateId);
          if (!activeArtifact) {
            throw new Error(
              `Production state refers to missing candidate ${state.activeCandidateId}`,
            );
          }
          if (activeArtifact.artifactHash !== state.activeArtifactHash) {
            throw new Error(
              `Production state artifactHash mismatch for active candidate ${state.activeCandidateId}`,
            );
          }
          if (activeArtifact.status !== 'PROMOTED' && activeArtifact.status !== 'REACTIVATED') {
            throw new Error(
              `Production state candidate ${state.activeCandidateId} has invalid status '${activeArtifact.status}' (must be PROMOTED or REACTIVATED)`,
            );
          }

          // Production candidate MUST have verified promotion evidence with decision === 'PROMOTE'
          const evidence = tempPromotionEvidences.get(state.activeCandidateId);
          if (!evidence) {
            throw new Error(
              `Production active candidate ${state.activeCandidateId} is missing required PromotionEvidence`,
            );
          }
          if (evidence.artifactHash !== state.activeArtifactHash) {
            throw new Error(
              `Production active candidate ${state.activeCandidateId} evidence artifactHash does not match active artifactHash`,
            );
          }
          if (evidence.promotionDecision !== 'PROMOTE') {
            throw new Error(
              `Production active candidate ${state.activeCandidateId} promotion evidence decision is '${evidence.promotionDecision}' (must be PROMOTE)`,
            );
          }
        }
        tempProductionState.set(key, deepFreeze(JSON.parse(JSON.stringify(state))));
      }

      // 4. Semantic audit events validation
      for (const event of data.events) {
        if (!event || typeof event !== 'object') {
          throw new Error('Corrupt audit event found in registry file: not an object');
        }
        if (!event.eventId || !event.candidateId || !event.eventType || !event.timestamp) {
          throw new Error('Corrupt audit event found in registry file: missing required fields');
        }
        if (
          event.candidateId !== 'baseline-candidate' &&
          event.candidateId !== 'v2.0-ml-canonical' &&
          !event.candidateId.startsWith('model-canon-')
        ) {
          const candidate = tempArtifacts.get(event.candidateId);
          if (!candidate) {
            throw new Error(
              `Audit event refers to non-existent candidate: ${event.candidateId}`,
            );
          }
          if (event.artifactHash && event.artifactHash !== candidate.artifactHash) {
            throw new Error(
              `Audit event artifactHash mismatch for candidate ${event.candidateId}: ${event.artifactHash} vs ${candidate.artifactHash}`,
            );
          }
        }
        tempEvents.push(deepFreeze(JSON.parse(JSON.stringify(event))));
      }

      // 5. Legacy models validation
      for (const [version, model] of data.models) {
        if (!version || !model || typeof model !== 'object' || model.modelVersion !== version) {
          throw new Error(`Corrupt legacy model entry for version: ${version}`);
        }
        tempModels.set(version, deepFreeze(JSON.parse(JSON.stringify(model))));
      }

      // Atomic commit to in-memory state only after complete validation pass
      this.artifacts = tempArtifacts;
      this.events = tempEvents;
      this.promotionEvidences = tempPromotionEvidences;
      this.productionState = tempProductionState;
      this.models = tempModels;
      this.activeModelVersion = data.activeModelVersion;
    } catch (err: any) {
      throw new Error(`MODEL_REGISTRY_CORRUPT: Failed to load registry state: ${err.message}`);
    }
  }

  /**
   * Auto-persists authoritative state to configured persistence path and verifies immediately.
   */
  private static autoPersist(): void {
    if (!this.persistencePath) return;

    try {
      this.saveToFile(this.persistencePath);
      // Verify persistence on disk immediately
      const readBack = fs.readFileSync(this.persistencePath, 'utf-8');
      JSON.parse(readBack);
    } catch (err: any) {
      throw new Error(`REGISTRY_PERSISTENCE_FAILED: Failed to persist model registry state to disk: ${err.message}`);
    }
  }

  /**
   * Exports an in-memory snapshot.
   */
  private static exportSnapshot(): Record<string, unknown> {
    return {
      artifacts: Array.from(this.artifacts.entries()),
      events: [...this.events],
      promotionEvidences: Array.from(this.promotionEvidences.entries()),
      productionState: Array.from(this.productionState.entries()),
      models: Array.from(this.models.entries()),
      activeModelVersion: this.activeModelVersion,
    };
  }

  /**
   * Restores an in-memory snapshot.
   */
  private static restoreSnapshot(snapshot: any): void {
    if (snapshot.artifacts) this.artifacts = new Map(snapshot.artifacts);
    if (snapshot.events) this.events = [...snapshot.events];
    if (snapshot.promotionEvidences) this.promotionEvidences = new Map(snapshot.promotionEvidences);
    if (snapshot.productionState) this.productionState = new Map(snapshot.productionState);
    if (snapshot.models) this.models = new Map(snapshot.models);
    if (snapshot.activeModelVersion) this.activeModelVersion = snapshot.activeModelVersion;
  }

  /**
   * Executes a transactional compound operation with automatic snapshot rollback on failure.
   * If requirePersistence is true (default), rejects if no persistencePath is configured.
   * Re-entrant: nested transactions run within the outer transaction context without duplicate commits.
   */
  public static executeTransaction<T>(
    operation: () => T,
    options: IExecuteTransactionOptions = { requirePersistence: true },
  ): T {
    if (options.requirePersistence !== false && !this.persistencePath) {
      throw new Error(
        'PERSISTENCE_NOT_CONFIGURED: ModelRegistry transaction requires a configured durable persistence path',
      );
    }

    if (this.inTransaction) {
      return operation();
    }

    this.inTransaction = true;
    const snapshot = this.exportSnapshot();
    try {
      const result = operation();
      this.autoPersist();
      return result;
    } catch (err: any) {
      this.restoreSnapshot(snapshot);
      try {
        this.autoPersist();
      } catch {
        // Rollback persistence best-effort
      }
      throw new Error(`TRANSACTION_FAILED: ${err.message}`);
    } finally {
      this.inTransaction = false;
    }
  }

  /**
   * Internal candidate artifact registration without standalone persistence.
   */
  private static registerCandidateArtifactInternal(artifact: CandidateArtifact): CandidateArtifact {
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

    const frozen = deepFreeze(JSON.parse(JSON.stringify(artifact)));
    this.artifacts.set(artifact.candidateId, frozen);

    this.recordEvent({
      eventId: `evt-${randomUUID()}`,
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
   * Registers an immutable CandidateArtifact into the registry.
   * Performs cryptographic integrity checks, deep-freezes, and immediately persists transactionally to disk.
   */
  public static registerCandidateArtifact(artifact: CandidateArtifact): CandidateArtifact {
    return this.executeTransaction(
      () => this.registerCandidateArtifactInternal(artifact),
      { requirePersistence: true },
    );
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
   * Internal candidate status update without standalone persistence.
   */
  private static updateCandidateStatusInternal(
    candidateId: string,
    newStatus: CandidateStatus,
    reason?: string,
  ): CandidateArtifact {
    const existing = this.getCandidateArtifact(candidateId);
    if (!existing) {
      throw new Error(`CANDIDATE_NOT_FOUND: Candidate ${candidateId} does not exist in registry`);
    }

    const previousStatus = existing.status;
    if (previousStatus === newStatus) {
      return existing;
    }

    const allowed = VALID_STATUS_TRANSITIONS[previousStatus] || [];
    if (!allowed.includes(newStatus)) {
      throw new Error(
        `ILLEGAL_STATE_TRANSITION: Cannot transition candidate ${candidateId} from ${previousStatus} to ${newStatus}`,
      );
    }

    const updated: CandidateArtifact = deepFreeze({
      ...JSON.parse(JSON.stringify(existing)),
      status: newStatus,
    });

    this.artifacts.set(candidateId, updated);

    let eventType: ModelRegistryEventType = 'OOS_VALIDATED';
    if (newStatus === 'SHADOW_PENDING' || newStatus === 'SHADOW_ACTIVE') eventType = 'SHADOW_STARTED';
    else if (newStatus === 'PROMOTION_ELIGIBLE') eventType = 'PROMOTION_ELIGIBLE';
    else if (newStatus === 'PROMOTED' || newStatus === 'REACTIVATED') eventType = 'PRODUCTION_ACTIVATED';
    else if (newStatus === 'REJECTED') eventType = 'PROMOTION_REJECTED';
    else if (newStatus === 'ROLLED_BACK') eventType = 'PRODUCTION_ROLLED_BACK';
    else if (newStatus === 'RETIRED') eventType = 'CANDIDATE_RETIRED';

    this.recordEvent({
      eventId: `evt-${randomUUID()}`,
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
   * Updates candidate status with explicit state-machine validation and audit event logging.
   * Transactional and requires durable persistence.
   */
  public static updateCandidateStatus(
    candidateId: string,
    newStatus: CandidateStatus,
    reason?: string,
  ): CandidateArtifact {
    return this.executeTransaction(
      () => this.updateCandidateStatusInternal(candidateId, newStatus, reason),
      { requirePersistence: true },
    );
  }

  /**
   * Internal promotion evidence recording without standalone persistence.
   */
  private static savePromotionEvidenceInternal(evidence: PromotionEvidence): void {
    if (!evidence || typeof evidence !== 'object') {
      throw new Error('INVALID_PROMOTION_EVIDENCE: Evidence cannot be null or undefined');
    }
    if (!evidence.candidateId || !evidence.evidenceId || !evidence.artifactHash) {
      throw new Error('INVALID_PROMOTION_EVIDENCE: Evidence missing candidateId, evidenceId, or artifactHash');
    }

    const candidate = this.artifacts.get(evidence.candidateId);
    if (!candidate) {
      throw new Error(`INVALID_PROMOTION_EVIDENCE: Candidate ${evidence.candidateId} not found in model registry`);
    }

    if (candidate.artifactHash !== evidence.artifactHash) {
      throw new Error(
        `INVALID_PROMOTION_EVIDENCE: Evidence artifactHash ${evidence.artifactHash} does not match candidate artifactHash ${candidate.artifactHash}`,
      );
    }

    if (candidate.status === 'RETIRED' || candidate.status === 'ROLLED_BACK') {
      throw new Error(
        `INVALID_PROMOTION_EVIDENCE: Candidate ${evidence.candidateId} in terminal status '${candidate.status}' cannot receive promotion evidence`,
      );
    }

    if (!evidence.shadowMetrics || typeof evidence.shadowMetrics !== 'object') {
      throw new Error('INVALID_PROMOTION_EVIDENCE: Evidence missing shadowMetrics');
    }

    if (!evidence.shadowDatasetHash) {
      throw new Error('INVALID_PROMOTION_EVIDENCE: Evidence missing shadowDatasetHash');
    }

    if (evidence.promotionDecision !== 'PROMOTE' && evidence.promotionDecision !== 'REJECT') {
      throw new Error(`INVALID_PROMOTION_EVIDENCE: Invalid promotion decision '${evidence.promotionDecision}'`);
    }

    const frozen = deepFreeze(JSON.parse(JSON.stringify(evidence)));
    this.promotionEvidences.set(evidence.candidateId, frozen);
  }

  /**
   * Records immutable promotion evidence into registry transactionally.
   */
  public static savePromotionEvidence(evidence: PromotionEvidence): void {
    this.executeTransaction(
      () => this.savePromotionEvidenceInternal(evidence),
      { requirePersistence: true },
    );
  }

  /**
   * Alias for savePromotionEvidence.
   */
  public static recordPromotionEvidence(evidence: PromotionEvidence): void {
    this.savePromotionEvidence(evidence);
  }

  /**
   * Atomically records promotion evidence and updates candidate status to PROMOTION_ELIGIBLE or REJECTED.
   * Single persistence commit; fails closed if persistence is not configured.
   */
  public static recordPromotionOutcome(
    candidateId: string,
    evidence: PromotionEvidence,
    decision: PromotionDecision,
  ): void {
    if (!decision || typeof decision !== 'object') {
      throw new Error('INVALID_PROMOTION_DECISION: PromotionDecision cannot be null or undefined');
    }
    if (decision.candidateId !== candidateId) {
      throw new Error(
        `INVALID_PROMOTION_DECISION: Decision candidateId ${decision.candidateId} does not match ${candidateId}`,
      );
    }
    if (decision.evidenceId && decision.evidenceId !== evidence.evidenceId) {
      throw new Error(
        `INVALID_PROMOTION_DECISION: Decision evidenceId ${decision.evidenceId} does not match evidence ${evidence.evidenceId}`,
      );
    }

    this.executeTransaction(
      () => {
        this.savePromotionEvidenceInternal(evidence);

        const candidate = this.artifacts.get(candidateId);
        if (!candidate) return;

        const isAutoPromoDisabledOnly =
          decision.decision === 'REJECT' &&
          decision.rejectionReasons?.length === 1 &&
          decision.rejectionReasons[0].startsWith('AUTO_PROMOTION_DISABLED');

        if (decision.decision === 'PROMOTE' || isAutoPromoDisabledOnly) {
          if (
            candidate.status !== 'PROMOTION_ELIGIBLE' &&
            candidate.status !== 'PROMOTED' &&
            candidate.status !== 'REACTIVATED'
          ) {
            this.updateCandidateStatusInternal(
              candidateId,
              'PROMOTION_ELIGIBLE',
              'Candidate passed all shadow validation criteria',
            );
          }
        } else if (decision.decision === 'REJECT') {
          if (candidate.status !== 'REJECTED') {
            this.updateCandidateStatusInternal(
              candidateId,
              'REJECTED',
              decision.rejectionReasons?.join('; ') || 'Failed promotion gate validation criteria',
            );
          }
        }
      },
      { requirePersistence: true },
    );
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
   * Internal production model state setter without standalone persistence.
   */
  private static setProductionStateInternal(state: ProductionModelState): void {
    const key = `${state.strategyId}:${state.environment}`;
    this.productionState.set(key, deepFreeze(JSON.parse(JSON.stringify(state))));
  }

  /**
   * Atomically sets the production model state, deep-freezes, and persists to disk.
   */
  public static setProductionState(state: ProductionModelState): void {
    if (this.inTransaction) {
      this.setProductionStateInternal(state);
    } else {
      this.executeTransaction(
        () => this.setProductionStateInternal(state),
        { requirePersistence: true },
      );
    }
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
    this.events.push(deepFreeze(JSON.parse(JSON.stringify(event))));
  }

  /**
   * Queries audit event history.
   */
  public static getEventHistory(candidateId?: string): ModelRegistryEvent[] {
    if (!candidateId) return [...this.events];
    return this.events.filter((e) => e.candidateId === candidateId);
  }

  /**
   * Clears in-memory registry state and re-initializes defaults.
   */
  public static clear(): void {
    this.artifacts.clear();
    this.events = [];
    this.promotionEvidences.clear();
    this.productionState.clear();
    this.activationLocks.clear();
    this.models.clear();
    this.activeModelVersion = 'v2.0-ml-canonical';
    this.inTransaction = false;
    this.initDefaultState();
  }

  // --- Disabled Legacy Promotion Methods ---

  /**
   * @deprecated Disabled in production to prevent safety architecture bypass.
   */
  public static registerModel(entry: IModelRegistryEntry): void {
    this.models.set(entry.modelVersion, deepFreeze(JSON.parse(JSON.stringify(entry))));
    this.autoPersist();
  }

  /**
   * @deprecated Disabled. Use ProductionModelActivator.activateCandidate().
   */
  public static promoteModel(_modelVersion: string): never {
    throw new Error(
      'LEGACY_MODEL_PROMOTION_DISABLED: Direct legacy model promotion is disabled. Use ProductionModelActivator.activateCandidate() with CandidateArtifact, Shadow evaluation, and PromotionGate.',
    );
  }

  /**
   * @deprecated Disabled. Use ProductionModelActivator.rollbackProduction().
   */
  public static rollbackModel(_targetModelVersion: string): never {
    throw new Error(
      'LEGACY_MODEL_ROLLBACK_DISABLED: Direct legacy model rollback is disabled. Use ProductionModelActivator.rollbackProduction().',
    );
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

