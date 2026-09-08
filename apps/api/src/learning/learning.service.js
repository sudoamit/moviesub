"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var LearningService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.LearningService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../common/prisma/prisma.service");
const learning_engine_1 = require("@quant/learning-engine");
let LearningService = LearningService_1 = class LearningService {
    prisma;
    logger = new common_1.Logger(LearningService_1.name);
    constructor(prisma) {
        this.prisma = prisma;
    }
    /**
     * Returns system health, active models, active strategy, drift status, and high-level learning summary.
     */
    async getSystemOverview() {
        const experiences = learning_engine_1.ExperienceStore.query();
        const activeStrat = learning_engine_1.StrategyRegistry.getActiveStrategy();
        const activeModel = learning_engine_1.ModelRegistry.getActiveModel();
        const drift = learning_engine_1.DriftDetector.evaluateDrift(experiences);
        const memories = learning_engine_1.LearningMemory.getMemoriesByType();
        const shadowCandidates = learning_engine_1.ShadowTradingEngine.getActiveCandidates();
        return {
            activeStrategy: activeStrat || {
                strategyVersion: 'v2.0-smc-quant',
                expectancyR: 0.42,
                winRate: 58.5,
            },
            activeModel: activeModel || {
                modelVersion: 'v2.0-ml-canonical',
                brierScore: 0.18,
                expectedValueR: 1.25,
            },
            totalExperiences: experiences.length,
            driftStatus: drift,
            activeShadowCount: shadowCandidates.length,
            provenPatternsCount: memories.filter((m) => m.memoryType === 'PROVEN_PATTERN').length,
            rejectedHypothesesCount: memories.filter((m) => m.memoryType === 'REJECTED_HYPOTHESIS').length,
            lastCycleAt: new Date(),
        };
    }
    /**
     * Retrieves paginated trading experiences.
     */
    async getExperiences(limit = 50, symbol) {
        const exps = learning_engine_1.ExperienceStore.query({ symbol });
        return exps.slice(-limit).reverse();
    }
    /**
     * Generates real-time failure mode analysis and top loss drivers.
     */
    async getErrorReport() {
        const exps = learning_engine_1.ExperienceStore.query();
        return learning_engine_1.ErrorAnalyzer.analyze(exps);
    }
    /**
     * Mines positive and negative confluence patterns from experiences.
     */
    async getPatterns() {
        const exps = learning_engine_1.ExperienceStore.query();
        return learning_engine_1.PatternDiscoveryEngine.discover(exps, { minSampleSize: 10 });
    }
    /**
     * Retrieves active strategy candidates with shadow metrics and validation results.
     */
    async getCandidates() {
        return learning_engine_1.ShadowTradingEngine.getActiveCandidates();
    }
    /**
     * Executes a full self-improvement learning cycle.
     */
    async triggerLearningCycle(autoPromote = false) {
        this.logger.log(`Executing ad-hoc self-improvement learning cycle (autoPromote=${autoPromote})...`);
        return await learning_engine_1.LearningEngine.runLearningCycle({ autoPromote });
    }
    /**
     * Manually promotes a strategy candidate.
     */
    async promoteCandidate(candidateId) {
        const candidates = learning_engine_1.ShadowTradingEngine.getActiveCandidates();
        const cand = candidates.find((c) => c.id === candidateId);
        if (!cand)
            throw new Error(`Candidate with id ${candidateId} not found.`);
        const promoResult = learning_engine_1.PromotionGate.evaluateCandidate(cand, {
            ...learning_engine_1.PromotionGate.DEFAULT_CRITERIA,
            allowAutoPromotion: true,
        });
        if (promoResult.approved) {
            learning_engine_1.StrategyRegistry.promoteStrategy(cand.candidateVersion);
            learning_engine_1.ShadowTradingEngine.deactivateCandidate(cand.id);
        }
        return promoResult;
    }
    /**
     * Executes deterministic rollback to previous stable version.
     */
    async rollback(targetVersion) {
        const active = learning_engine_1.StrategyRegistry.getActiveStrategy();
        const target = targetVersion || 'v2.0-smc-quant';
        this.logger.warn(`Executing strategy rollback from ${active?.strategyVersion} to ${target}`);
        learning_engine_1.StrategyRegistry.rollbackStrategy(target);
        learning_engine_1.ModelRegistry.rollbackModel('v2.0-ml-canonical');
        return {
            rolledBack: true,
            fromVersion: active?.strategyVersion,
            toVersion: target,
            executedAt: new Date(),
        };
    }
};
exports.LearningService = LearningService;
exports.LearningService = LearningService = LearningService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService])
], LearningService);
//# sourceMappingURL=learning.service.js.map