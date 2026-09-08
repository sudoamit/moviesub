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
  }

  /**
   * Registers a new model version.
   */
  public static registerModel(entry: IModelRegistryEntry): void {
    this.models.set(entry.modelVersion, Object.freeze({ ...entry }));
  }

  /**
   * Promotes a model version to ACTIVE and retires previous active model.
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
   * Reverts to a previous model version.
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
   * Returns current active model version.
   */
  public static getActiveModel(): IModelRegistryEntry | undefined {
    return this.models.get(this.activeModelVersion);
  }

  /**
   * Returns all registered models.
   */
  public static getAllModels(): IModelRegistryEntry[] {
    return Array.from(this.models.values());
  }
}
