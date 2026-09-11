import { createHash } from 'crypto';
import { canonicalJsonStringify } from '../canonical-serializer';
import { deepFreeze } from './evaluation-identity';
import {
  ModelRecord,
  ModelStatus,
  ChampionRecord,
  ChallengerRecord,
  IModelRegistryStore,
} from './types';
import { InMemoryModelRegistryStore } from './model-registry-store';

const VALID_MODEL_STATUS_TRANSITIONS: Record<ModelStatus, readonly ModelStatus[]> = {
  CANDIDATE: ['CHALLENGER', 'CHAMPION', 'RETIRED', 'INVALID'],
  CHALLENGER: ['CHAMPION', 'RETIRED', 'INVALID'],
  CHAMPION: ['RETIRED', 'INVALID'],
  RETIRED: [],
  INVALID: [],
};

export class ModelRegistryService {
  private readonly store: IModelRegistryStore;
  private registryVersion = 1;

  constructor(store?: IModelRegistryStore) {
    this.store = store || new InMemoryModelRegistryStore();
  }

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
   * Fails closed if any required metadata is missing (no silent defaults).
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
    const requiredStrings: Array<[string, string | undefined]> = [
      ['modelId', params.modelId],
      ['modelVersion', params.modelVersion],
      ['modelType', params.modelType],
      ['artifactLocation', params.artifactLocation],
      ['trainingRunId', params.trainingRunId],
      ['datasetVersion', params.datasetVersion],
      ['featureVersion', params.featureVersion],
      ['labelVersion', params.labelVersion],
    ];

    for (const [key, value] of requiredStrings) {
      if (!value || typeof value !== 'string' || value.trim() === '') {
        throw new Error(`INVALID_MODEL_RECORD: ${key} is required and cannot be empty`);
      }
    }

    let finalArtifactHash = params.artifactHash;
    if (!finalArtifactHash && params.artifactData !== undefined) {
      finalArtifactHash = ModelRegistryService.computeArtifactHash(params.artifactData);
    }

    if (!finalArtifactHash || typeof finalArtifactHash !== 'string' || finalArtifactHash.trim() === '') {
      throw new Error('INVALID_MODEL_RECORD: artifactHash or artifactData is required');
    }

    if (this.store.getModel(params.modelId)) {
      throw new Error(`DUPLICATE_MODEL_ID: Model with ID "${params.modelId}" is already registered`);
    }

    // Ensure no collision for the exact same artifactHash across different modelIds unless explicit
    const existingModels = this.store.getAllModels();
    for (const existing of existingModels) {
      if (existing.modelVersion === params.modelVersion && existing.artifactHash !== finalArtifactHash) {
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
      modelType: params.modelType,
      artifactLocation: params.artifactLocation,
      artifactHash: finalArtifactHash,
      trainingRunId: params.trainingRunId,
      datasetVersion: params.datasetVersion,
      featureVersion: params.featureVersion,
      labelVersion: params.labelVersion,
      createdAt: params.createdAt ?? Date.now(),
      status: params.status || 'CANDIDATE',
      metadata: params.metadata ? { ...params.metadata } : {},
    };

    const frozenRecord = deepFreeze(record);
    this.store.saveModel(frozenRecord);
    return frozenRecord;
  }

  /**
   * Updates model status enforcing state transition validity.
   */
  public updateModelStatus(modelId: string, newStatus: ModelStatus): ModelRecord {
    const existing = this.store.getModel(modelId);
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
    this.store.saveModel(frozen);
    return frozen;
  }

  /**
   * Explicitly assigns a registered model as the active Champion for a strategy slot.
   * Enforces: Strictly ONE active Champion per strategy slot.
   * If the model was previously an active Challenger in this slot, retires its ChallengerRecord.
   * If a previous Champion was active in this slot, retires the previous model.
   */
  public assignChampion(
    slotId: string,
    modelId: string,
    options?: {
      reason?: string;
      promotionDecisionId?: string;
      evaluationId?: string;
    }
  ): ChampionRecord {
    if (!slotId || typeof slotId !== 'string' || slotId.trim() === '') {
      throw new Error('INVALID_SLOT_ID: slotId is required');
    }
    const model = this.store.getModel(modelId);
    if (!model) {
      throw new Error(`MODEL_NOT_FOUND: Cannot assign non-existent model "${modelId}" as Champion`);
    }

    // Update model status to CHAMPION if not already
    if (model.status !== 'CHAMPION') {
      this.updateModelStatus(modelId, 'CHAMPION');
    }

    // 1. If previous Champion was assigned to this slot, retire previous champion model
    const previousChampion = this.store.getChampion(slotId);
    if (previousChampion && previousChampion.modelId !== modelId) {
      const prevModel = this.store.getModel(previousChampion.modelId);
      if (prevModel && prevModel.status === 'CHAMPION') {
        this.updateModelStatus(prevModel.modelId, 'RETIRED');
      }
    }

    // 2. If this model had an active Challenger record in this slot, retire it
    const existingChallengers = this.store.getChallengers(slotId);
    const existingChallenger = existingChallengers.find((c) => c.modelId === modelId);
    if (existingChallenger && existingChallenger.status === 'ACTIVE_CHALLENGER') {
      const retiredChallenger: ChallengerRecord = {
        ...existingChallenger,
        status: 'RETIRED',
        statusReason: options?.reason || 'PROMOTED_TO_CHAMPION',
      };
      this.store.saveChallenger(deepFreeze(retiredChallenger));
    }

    this.registryVersion++;
    const championRecord: ChampionRecord = {
      slotId,
      modelId: model.modelId,
      modelVersion: model.modelVersion,
      artifactHash: model.artifactHash,
      assignedAt: Date.now(),
      registryVersion: this.registryVersion,
      assignmentReason: options?.reason,
      promotionDecisionId: options?.promotionDecisionId,
      evaluationId: options?.evaluationId,
    };

    const frozen = deepFreeze(championRecord);
    this.store.saveChampion(frozen);
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
    const model = this.store.getModel(modelId);
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
    this.store.saveChallenger(frozen);
    return frozen;
  }

  public getModel(modelId: string): ModelRecord | undefined {
    return this.store.getModel(modelId);
  }

  public getChampion(slotId: string): ChampionRecord | undefined {
    return this.store.getChampion(slotId);
  }

  public getActiveChampion(slotId: string): ChampionRecord | undefined {
    return this.getChampion(slotId);
  }

  public getChallengers(slotId: string): ChallengerRecord[] {
    return this.store.getChallengers(slotId);
  }

  public getChallengersForSlot(slotId: string): ChallengerRecord[] {
    return this.getChallengers(slotId);
  }

  public getAllModels(): ModelRecord[] {
    return this.store.getAllModels();
  }

  public listModels(): ModelRecord[] {
    return this.getAllModels();
  }

  public getAllChampions(): ChampionRecord[] {
    return this.store.getAllChampions();
  }

  public listActiveChampions(): ChampionRecord[] {
    return this.getAllChampions();
  }

  public getStore(): IModelRegistryStore {
    return this.store;
  }
}
