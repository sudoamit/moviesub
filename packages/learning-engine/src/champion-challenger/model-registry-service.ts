import { createHash } from 'crypto';
import { canonicalJsonStringify } from '../canonical-serializer';
import { deepFreeze } from './evaluation-identity';
import {
  ModelRecord,
  ModelStatus,
  ChampionRecord,
  ChallengerRecord,
  ChallengerStatus,
} from './types';

const VALID_MODEL_STATUS_TRANSITIONS: Record<ModelStatus, readonly ModelStatus[]> = {
  CANDIDATE: ['CHALLENGER', 'CHAMPION', 'RETIRED', 'INVALID'],
  CHALLENGER: ['CHAMPION', 'RETIRED', 'INVALID'],
  CHAMPION: ['RETIRED', 'INVALID'],
  RETIRED: [],
  INVALID: [],
};

export class ModelRegistryService {
  private readonly models = new Map<string, ModelRecord>();
  private readonly champions = new Map<string, ChampionRecord>(); // slotId -> ChampionRecord
  private readonly challengers = new Map<string, Map<string, ChallengerRecord>>(); // slotId -> modelId -> ChallengerRecord
  private registryVersion = 1;

  /**
   * Computes a cryptographic SHA-256 hash of any model artifact using canonical serialization.
   */
  public static computeArtifactHash(artifact: unknown): string {
    if (artifact === null || artifact === undefined) {
      throw new Error('INVALID_MODEL_ARTIFACT: Artifact cannot be null or undefined');
    }
    const canonicalString = canonicalJsonStringify(artifact);
    return createHash('sha256').update(canonicalString).digest('hex');
  }

  /**
   * Registers a new model record with cryptographic artifact validation.
   */
  public registerModel(params: {
    modelId: string;
    modelVersion: string;
    modelType: string;
    artifactLocation: string;
    artifactHash?: string;
    artifactData?: unknown;
    trainingRunId: string;
    datasetVersion: string;
    featureVersion: string;
    labelVersion: string;
    status?: ModelStatus;
    metadata?: Record<string, unknown>;
    createdAt?: number;
  }): ModelRecord {
    if (!params.modelId || typeof params.modelId !== 'string' || params.modelId.trim() === '') {
      throw new Error('INVALID_MODEL_RECORD: modelId is required');
    }
    if (!params.modelVersion || typeof params.modelVersion !== 'string' || params.modelVersion.trim() === '') {
      throw new Error('INVALID_MODEL_RECORD: modelVersion is required');
    }

    let finalArtifactHash = params.artifactHash;
    if (!finalArtifactHash && params.artifactData !== undefined) {
      finalArtifactHash = ModelRegistryService.computeArtifactHash(params.artifactData);
    }

    if (!finalArtifactHash || typeof finalArtifactHash !== 'string' || finalArtifactHash.trim() === '') {
      throw new Error('INVALID_MODEL_RECORD: artifactHash or artifactData is required');
    }

    if (this.models.has(params.modelId)) {
      throw new Error(`DUPLICATE_MODEL_ID: Model with ID "${params.modelId}" is already registered`);
    }

    // Ensure no collision for the exact same artifactHash across different modelIds unless explicit
    for (const existing of this.models.values()) {
      if (existing.modelVersion === params.modelVersion && existing.artifactHash !== finalArtifactHash) {
        // Same version string but different artifact hash -> requires distinct modelId
        if (existing.modelId === params.modelId) {
          throw new Error(
            `MODEL_VERSION_COLLISION: Model version "${params.modelVersion}" has conflicting artifact hashes`,
          );
        }
      }
    }

    const record: ModelRecord = {
      modelId: params.modelId,
      modelVersion: params.modelVersion,
      modelType: params.modelType || 'CANONICAL_ML',
      artifactLocation: params.artifactLocation || `artifacts/models/${params.modelId}.json`,
      artifactHash: finalArtifactHash,
      trainingRunId: params.trainingRunId || `run_${params.modelId}`,
      datasetVersion: params.datasetVersion || '1.0',
      featureVersion: params.featureVersion || '2.0',
      labelVersion: params.labelVersion || '1.0',
      createdAt: params.createdAt ?? Date.now(),
      status: params.status || 'CANDIDATE',
      metadata: params.metadata ? { ...params.metadata } : {},
    };

    const frozenRecord = deepFreeze(record);
    this.models.set(record.modelId, frozenRecord);
    return frozenRecord;
  }

  /**
   * Updates model status enforcing state transition validity.
   */
  public updateModelStatus(modelId: string, newStatus: ModelStatus): ModelRecord {
    const existing = this.models.get(modelId);
    if (!existing) {
      throw new Error(`MODEL_NOT_FOUND: Model with ID "${modelId}" does not exist in registry`);
    }

    if (existing.status === newStatus) {
      return existing;
    }

    const allowed = VALID_MODEL_STATUS_TRANSITIONS[existing.status];
    if (!allowed.includes(newStatus)) {
      throw new Error(
        `INVALID_MODEL_STATUS_TRANSITION: Cannot transition model from "${existing.status}" to "${newStatus}"`,
      );
    }

    const updated: ModelRecord = {
      ...existing,
      status: newStatus,
    };

    const frozen = deepFreeze(updated);
    this.models.set(modelId, frozen);
    return frozen;
  }

  /**
   * Explicitly assigns a registered model as the active Champion for a strategy slot.
   * Enforces: ONE active Champion per strategy slot.
   */
  public assignChampion(slotId: string, modelId: string): ChampionRecord {
    if (!slotId || typeof slotId !== 'string' || slotId.trim() === '') {
      throw new Error('INVALID_SLOT_ID: slotId is required');
    }
    const model = this.models.get(modelId);
    if (!model) {
      throw new Error(`MODEL_NOT_FOUND: Cannot assign non-existent model "${modelId}" as Champion`);
    }

    // Update model status if candidate or challenger
    if (model.status !== 'CHAMPION') {
      this.updateModelStatus(modelId, 'CHAMPION');
    }

    // If an existing Champion was assigned to this slot, retire previous champion model
    const previousChampion = this.champions.get(slotId);
    if (previousChampion && previousChampion.modelId !== modelId) {
      const prevModel = this.models.get(previousChampion.modelId);
      if (prevModel && prevModel.status === 'CHAMPION') {
        this.updateModelStatus(prevModel.modelId, 'RETIRED');
      }
    }

    this.registryVersion++;
    const championRecord: ChampionRecord = {
      slotId,
      modelId: model.modelId,
      modelVersion: model.modelVersion,
      artifactHash: model.artifactHash,
      assignedAt: Date.now(),
      registryVersion: this.registryVersion,
    };

    const frozen = deepFreeze(championRecord);
    this.champions.set(slotId, frozen);
    return frozen;
  }

  /**
   * Registers a Challenger model for a strategy slot.
   */
  public registerChallenger(
    slotId: string,
    modelId: string,
    sourceTrainingRunId?: string,
  ): ChallengerRecord {
    if (!slotId || typeof slotId !== 'string' || slotId.trim() === '') {
      throw new Error('INVALID_SLOT_ID: slotId is required');
    }
    const model = this.models.get(modelId);
    if (!model) {
      throw new Error(`MODEL_NOT_FOUND: Cannot register non-existent model "${modelId}" as Challenger`);
    }

    if (model.status !== 'CHALLENGER') {
      this.updateModelStatus(modelId, 'CHALLENGER');
    }

    const challengerRecord: ChallengerRecord = {
      slotId,
      modelId: model.modelId,
      modelVersion: model.modelVersion,
      artifactHash: model.artifactHash,
      registeredAt: Date.now(),
      sourceTrainingRunId: sourceTrainingRunId || model.trainingRunId,
      status: 'ACTIVE_CHALLENGER',
    };

    const frozen = deepFreeze(challengerRecord);
    let slotChallengers = this.challengers.get(slotId);
    if (!slotChallengers) {
      slotChallengers = new Map();
      this.challengers.set(slotId, slotChallengers);
    }
    slotChallengers.set(modelId, frozen);

    return frozen;
  }

  public getModel(modelId: string): ModelRecord | undefined {
    return this.models.get(modelId);
  }

  public getChampion(slotId: string): ChampionRecord | undefined {
    return this.champions.get(slotId);
  }

  public getActiveChampion(slotId: string): ChampionRecord | undefined {
    return this.getChampion(slotId);
  }

  public getChallengers(slotId: string): ChallengerRecord[] {
    const slotMap = this.challengers.get(slotId);
    return slotMap ? Array.from(slotMap.values()) : [];
  }

  public getChallengersForSlot(slotId: string): ChallengerRecord[] {
    return this.getChallengers(slotId);
  }

  public getAllModels(): ModelRecord[] {
    return Array.from(this.models.values());
  }

  public listModels(): ModelRecord[] {
    return this.getAllModels();
  }

  public getAllChampions(): ChampionRecord[] {
    return Array.from(this.champions.values());
  }

  public listActiveChampions(): ChampionRecord[] {
    return this.getAllChampions();
  }
}

