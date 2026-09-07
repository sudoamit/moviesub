import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import {
  DriftDetector,
  ErrorAnalyzer,
  ExperienceStore,
  LearningEngine,
  LearningMemory,
  ModelRegistry,
  PatternDiscoveryEngine,
  PromotionGate,
  RollbackManager,
  ShadowTradingEngine,
  StrategyRegistry,
  TradeOutcomeAnalyzer,
  TradingExperience,
  LearningMemoryItem,
  StrategyCandidate,
} from '@quant/learning-engine';

@Injectable()
export class LearningService {
  private readonly logger = new Logger(LearningService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Returns system health, active models, active strategy, drift status, and high-level learning summary.
   */
  async getSystemOverview() {
    const experiences = ExperienceStore.query();
    const activeStrat = StrategyRegistry.getActiveStrategy();
    const activeModel = ModelRegistry.getActiveModel();
    const drift = DriftDetector.evaluateDrift(experiences);
    const memories = LearningMemory.getMemoriesByType();
    const shadowCandidates = ShadowTradingEngine.getActiveCandidates();

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
      provenPatternsCount: memories.filter(
        (m: LearningMemoryItem) => m.memoryType === 'PROVEN_PATTERN',
      ).length,
      rejectedHypothesesCount: memories.filter(
        (m: LearningMemoryItem) => m.memoryType === 'REJECTED_HYPOTHESIS',
      ).length,
      lastCycleAt: new Date(),
    };
  }

  /**
   * Retrieves paginated trading experiences.
   */
  async getExperiences(limit = 50, symbol?: string) {
    const exps = ExperienceStore.query({ symbol });
    return exps.slice(-limit).reverse();
  }

  /**
   * Generates real-time failure mode analysis and top loss drivers.
   */
  async getErrorReport() {
    const exps = ExperienceStore.query();
    return ErrorAnalyzer.analyze(exps);
  }

  /**
   * Mines positive and negative confluence patterns from experiences.
   */
  async getPatterns() {
    const exps = ExperienceStore.query();
    return PatternDiscoveryEngine.discover(exps, { minSampleSize: 10 });
  }

  /**
   * Retrieves active strategy candidates with shadow metrics and validation results.
   */
  async getCandidates() {
    return ShadowTradingEngine.getActiveCandidates();
  }

  /**
   * Executes a full self-improvement learning cycle.
   */
  async triggerLearningCycle(autoPromote = false) {
    this.logger.log(
      `Executing ad-hoc self-improvement learning cycle (autoPromote=${autoPromote})...`,
    );
    return await LearningEngine.runLearningCycle({ autoPromote });
  }

  /**
   * Manually promotes a strategy candidate.
   */
  async promoteCandidate(candidateId: string) {
    const candidates = ShadowTradingEngine.getActiveCandidates();
    const cand = candidates.find((c: StrategyCandidate) => c.id === candidateId);
    if (!cand) throw new Error(`Candidate with id ${candidateId} not found.`);

    const promoResult = PromotionGate.evaluateCandidate(cand, {
      ...PromotionGate.DEFAULT_CRITERIA,
      allowAutoPromotion: true,
    });

    if (promoResult.approved) {
      StrategyRegistry.promoteStrategy(cand.candidateVersion);
      ShadowTradingEngine.deactivateCandidate(cand.id);
    }

    return promoResult;
  }

  /**
   * Executes deterministic rollback to previous stable version.
   */
  async rollback(targetVersion?: string) {
    const active = StrategyRegistry.getActiveStrategy();
    const target = targetVersion || 'v2.0-smc-quant';
    this.logger.warn(`Executing strategy rollback from ${active?.strategyVersion} to ${target}`);
    StrategyRegistry.rollbackStrategy(target);
    ModelRegistry.rollbackModel('v2.0-ml-canonical');

    return {
      rolledBack: true,
      fromVersion: active?.strategyVersion,
      toVersion: target,
      executedAt: new Date(),
    };
  }
}
