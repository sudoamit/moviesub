"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ModelRegistry = void 0;
class ModelRegistry {
    static models = new Map();
    static activeModelVersion = 'v2.0-ml-canonical';
    static {
        // Register initial canonical active model
        const initial = {
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
    static registerModel(entry) {
        this.models.set(entry.modelVersion, Object.freeze({ ...entry }));
    }
    /**
     * Promotes a model version to ACTIVE and retires previous active model.
     */
    static promoteModel(modelVersion) {
        const current = this.models.get(this.activeModelVersion);
        if (current) {
            this.models.set(this.activeModelVersion, Object.freeze({ ...current, status: 'RETIRED', retiredAt: new Date() }));
        }
        const candidate = this.models.get(modelVersion);
        if (!candidate) {
            throw new Error(`Model version ${modelVersion} not found in registry.`);
        }
        this.models.set(modelVersion, Object.freeze({ ...candidate, status: 'ACTIVE', promotedAt: new Date() }));
        this.activeModelVersion = modelVersion;
    }
    /**
     * Reverts to a previous model version.
     */
    static rollbackModel(targetModelVersion) {
        const current = this.models.get(this.activeModelVersion);
        if (current) {
            this.models.set(this.activeModelVersion, Object.freeze({ ...current, status: 'ROLLED_BACK', retiredAt: new Date() }));
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
    static getActiveModel() {
        return this.models.get(this.activeModelVersion);
    }
    /**
     * Returns all registered models.
     */
    static getAllModels() {
        return Array.from(this.models.values());
    }
}
exports.ModelRegistry = ModelRegistry;
//# sourceMappingURL=model-registry.js.map