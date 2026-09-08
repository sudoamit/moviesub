"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.ExperimentRegistry = void 0;
const crypto = __importStar(require("crypto"));
class ExperimentRegistry {
    static experiments = new Map();
    /**
     * Generates a deterministic SHA-256 hash identifying the exact experiment configuration.
     * Ensures identical parameters, datasets, and period windows produce the exact same hash.
     */
    static computeExperimentHash(config) {
        const payload = JSON.stringify({
            datasetVersion: config.datasetVersion,
            strategyVersion: config.strategyVersion,
            featureSchemaVersion: config.featureSchemaVersion,
            instrument: config.instrument.toUpperCase(),
            timeframe: config.timeframe,
            parameters: config.parameters,
            trainStart: config.trainingPeriod.start.toISOString(),
            trainEnd: config.trainingPeriod.end.toISOString(),
            valStart: config.validationPeriod.start.toISOString(),
            valEnd: config.validationPeriod.end.toISOString(),
            testStart: config.testPeriod.start.toISOString(),
            testEnd: config.testPeriod.end.toISOString(),
            holdoutStart: config.holdoutPeriod?.start.toISOString() || null,
            holdoutEnd: config.holdoutPeriod?.end.toISOString() || null,
        });
        return crypto.createHash('sha256').update(payload).digest('hex').substring(0, 16);
    }
    /**
     * Registers a new research experiment into the immutable registry.
     */
    static registerExperiment(experiment) {
        if (this.experiments.has(experiment.id)) {
            throw new Error(`Experiment with ID '${experiment.id}' already exists in registry.`);
        }
        this.experiments.set(experiment.id, experiment);
        return experiment;
    }
    /**
     * Finds an existing experiment by its deterministic configuration hash.
     */
    static findExperimentByHash(hash) {
        for (const exp of this.experiments.values()) {
            if (exp.experimentHash === hash) {
                return exp;
            }
        }
        return undefined;
    }
    static getExperiment(id) {
        return this.experiments.get(id);
    }
    static listExperiments(limit = 100) {
        return Array.from(this.experiments.values())
            .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
            .slice(0, limit);
    }
    static getExperimentsByStatus(status) {
        return Array.from(this.experiments.values()).filter((e) => e.status === status);
    }
    static updateExperiment(id, updates) {
        const existing = this.experiments.get(id);
        if (!existing) {
            throw new Error(`Experiment with ID '${id}' not found.`);
        }
        const updated = { ...existing, ...updates };
        this.experiments.set(id, updated);
        return updated;
    }
    static clear() {
        this.experiments.clear();
    }
}
exports.ExperimentRegistry = ExperimentRegistry;
//# sourceMappingURL=experiment-registry.js.map