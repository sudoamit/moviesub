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
export declare class ModelRegistry {
    private static models;
    private static activeModelVersion;
    /**
     * Registers a new model version.
     */
    static registerModel(entry: IModelRegistryEntry): void;
    /**
     * Promotes a model version to ACTIVE and retires previous active model.
     */
    static promoteModel(modelVersion: string): void;
    /**
     * Reverts to a previous model version.
     */
    static rollbackModel(targetModelVersion: string): void;
    /**
     * Returns current active model version.
     */
    static getActiveModel(): IModelRegistryEntry | undefined;
    /**
     * Returns all registered models.
     */
    static getAllModels(): IModelRegistryEntry[];
}
