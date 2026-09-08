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
exports.ExperienceStore = void 0;
const fs = __importStar(require("fs"));
const point_in_time_validator_1 = require("./point-in-time-validator");
class ExperienceStore {
    static experiences = new Map();
    /**
     * Appends an immutable TradingExperience.
     */
    static saveExperience(exp) {
        if (this.experiences.has(exp.id)) {
            throw new Error(`TradingExperience with id ${exp.id} already exists (Immutability Violation).`);
        }
        const valResult = point_in_time_validator_1.PointInTimeValidator.validatePointInTimeExperience(exp);
        if (!valResult.isValid) {
            throw new Error(`Point-In-Time Experience Invariant Violation: ${valResult.reason}`);
        }
        const prepared = {
            ...exp,
            decisionTimestamp: valResult.decisionTimestamp,
            featureTimestamp: valResult.featureTimestamp,
            labelStartTimestamp: valResult.labelStartTimestamp,
            labelEndTimestamp: valResult.labelEndTimestamp,
        };
        const frozen = Object.freeze(prepared);
        this.experiences.set(exp.id, frozen);
        return frozen;
    }
    /**
     * Bulk loads or seeds experiences into the store.
     */
    static loadExperiences(exps) {
        for (const exp of exps) {
            if (!this.experiences.has(exp.id)) {
                const valResult = point_in_time_validator_1.PointInTimeValidator.validatePointInTimeExperience(exp);
                if (valResult.isValid) {
                    const prepared = {
                        ...exp,
                        decisionTimestamp: valResult.decisionTimestamp,
                        featureTimestamp: valResult.featureTimestamp,
                        labelStartTimestamp: valResult.labelStartTimestamp,
                        labelEndTimestamp: valResult.labelEndTimestamp,
                    };
                    this.experiences.set(exp.id, Object.freeze(prepared));
                }
            }
        }
    }
    /**
     * Persists all experiences in store to a JSON file.
     */
    static saveToFile(filePath) {
        const list = Array.from(this.experiences.values());
        fs.writeFileSync(filePath, JSON.stringify(list, null, 2), 'utf-8');
    }
    /**
     * Loads experiences from a JSON file into the store.
     */
    static loadFromFile(filePath) {
        if (!fs.existsSync(filePath))
            return;
        const content = fs.readFileSync(filePath, 'utf-8');
        const parsed = JSON.parse(content);
        this.loadExperiences(parsed);
    }
    /**
     * Retrieves a single experience by ID.
     */
    static getById(id) {
        return this.experiences.get(id);
    }
    /**
     * Retrieves all completed experiences matching query filters.
     */
    static query(filter = {}) {
        const all = Array.from(this.experiences.values());
        return all
            .filter((exp) => {
            if (filter.symbol && exp.instrument.symbol.toUpperCase() !== filter.symbol.toUpperCase())
                return false;
            if (filter.assetType && exp.instrument.assetType !== filter.assetType)
                return false;
            if (filter.regime && exp.marketContext.regime !== filter.regime)
                return false;
            if (filter.session && exp.marketContext.session !== filter.session)
                return false;
            if (filter.outcomeClassification &&
                exp.outcomeClassification !== filter.outcomeClassification)
                return false;
            if (filter.outcomeStatus && exp.outcome.status !== filter.outcomeStatus)
                return false;
            if (filter.strategyVersion && exp.strategyVersion !== filter.strategyVersion)
                return false;
            if (filter.minScore !== undefined && exp.decision.score < filter.minScore)
                return false;
            if (filter.startDate &&
                new Date(exp.timestamp).getTime() < new Date(filter.startDate).getTime())
                return false;
            if (filter.endDate &&
                new Date(exp.timestamp).getTime() > new Date(filter.endDate).getTime())
                return false;
            return true;
        })
            .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    }
    /**
     * Count total experiences in memory.
     */
    static count() {
        return this.experiences.size;
    }
    /**
     * Clears the in-memory experience cache (useful for isolated tests).
     */
    static clear() {
        this.experiences.clear();
    }
}
exports.ExperienceStore = ExperienceStore;
//# sourceMappingURL=experience-store.js.map