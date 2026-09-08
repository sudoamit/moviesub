import { ExperienceStore } from './experience-store';
import { ErrorAnalyzer } from './error-analyzer';
import { PatternDiscoveryEngine } from './pattern-discovery';
import { FeatureSelector } from './feature-selector';
import { RegimePerformanceAnalyzer } from './regime-performance-analyzer';
import { VolatilityPerformanceAnalyzer } from './volatility-performance-analyzer';
import { StrategyPerformanceAnalyzer } from './strategy-performance-analyzer';
import { CandidateGenerator } from './candidate-generator';
import { CandidateEvaluator } from './candidate-evaluator';
import { WalkForwardValidator } from './walk-forward-validator';
import { RobustnessEngine } from './robustness-engine';
import { MonteCarloEngine } from './monte-carlo-engine';
import { ShadowTradingEngine } from './shadow-trading-engine';
import { PromotionGate } from './promotion-gate';
import { RollbackManager } from './rollback-manager';
import { DriftDetector } from './drift-detector';
import { LearningMemory } from './learning-memory';
import { LearningScheduler } from './learning-scheduler';
import { LearningRunReport, StrategyCandidate } from './types';

export interface ILearningCycleOptions {
  baseStrategyVersion?: string;
  autoPromote?: boolean;
}

export class LearningEngine {
  public static readonly VERSION = '1.0.0';

  /**
   * Executes a complete, end-to-end self-improvement learning cycle across all modules.
   */
  public static async runLearningCycle(
    options: ILearningCycleOptions = {},
  ): Promise<LearningRunReport> {
    const startedAt = new Date();
    const baseVersion = options.baseStrategyVersion || 'v2.0-smc-quant';

    // 1. Ingest experiences
    const experiences = ExperienceStore.query();
    const expCount = experiences.length;

    // 2. Error Analysis
    const errorReport = ErrorAnalyzer.analyze(experiences);

    // 3. Pattern Discovery
    const patterns = PatternDiscoveryEngine.discover(experiences);

    // 4. Feature Selection
    const featureSelection = FeatureSelector.selectFeatures(experiences);

    // 5. Domain Metrics
    const regimeStats = RegimePerformanceAnalyzer.analyze(experiences);
    const volStats = VolatilityPerformanceAnalyzer.analyze(experiences);
    const stratStats = StrategyPerformanceAnalyzer.analyze(experiences);

    // 6. Candidate Generation
    const candidates = CandidateGenerator.generateCandidates({
      baseStrategyVersion: baseVersion,
      errorReport,
      patterns,
    });

    let promotedCount = 0;
    let rejectedCount = 0;

    // 7. Validation Pipeline for each Candidate
    for (const cand of candidates) {
      // 7a. Historical Simulation
      const histEval = CandidateEvaluator.evaluate(cand, experiences);
      if (!histEval.passed) {
        cand.status = 'REJECTED';
        cand.rejectionReason = histEval.rejectionReason || 'Historical evaluation failed.';
        rejectedCount++;
        continue;
      }

      // 7b. Walk-Forward Purged & Embargo Validation
      const wfEval = WalkForwardValidator.validate(cand, experiences);

      // 7c. Robustness & Transaction Costs
      const costEval = RobustnessEngine.evaluateCosts(cand, experiences);

      // 7d. Candidate-Specific Seeded Monte Carlo Stress Simulation
      const candRMultiples =
        histEval.simulatedRMultiples && histEval.simulatedRMultiples.length > 0
          ? histEval.simulatedRMultiples
          : experiences.map((e) => e.outcome.pnlR);
      const mcEval = MonteCarloEngine.simulate(candRMultiples, { seed: 42 });

      cand.validationMetrics = {
        inSampleExpectancy: wfEval.meanInSampleExpectancy || histEval.candidateExpectancy,
        walkForwardExpectancy: wfEval.meanOutOfSampleExpectancy || histEval.candidateExpectancy,
        outOfSampleExpectancy: wfEval.meanOutOfSampleExpectancy || histEval.candidateExpectancy,
        profitFactor: histEval.profitFactor,
        maxDrawdownPercent: histEval.maxDrawdownPercent,
        monteCarloRuinProb: mcEval.probabilityOfRuin,
        transactionCostSurvived: costEval.survivedDoubleCosts,
      };

      // 7e. Activate in Shadow Trading Engine
      ShadowTradingEngine.activateCandidate(cand);

      // 7f. Evaluate for Promotion
      const promoResult = PromotionGate.evaluateCandidate(cand, {
        ...PromotionGate.DEFAULT_CRITERIA,
        allowAutoPromotion: !!options.autoPromote,
      });

      if (promoResult.approved) {
        promotedCount++;
        LearningMemory.setMemory({
          key: `promoted-${cand.candidateVersion}`,
          memoryType: 'PROVEN_PATTERN',
          summary: `Promoted strategy candidate: ${cand.description}`,
          details: { ...cand.change, ...cand.validationMetrics },
          sampleSize: cand.evidence.sampleSize,
          confidence: cand.evidence.pValue ? Math.round((1 - cand.evidence.pValue) * 100) : 95,
          status: 'ACTIVE',
        });
      } else {
        rejectedCount++;
        LearningMemory.setMemory({
          key: `rejected-${cand.candidateVersion}`,
          memoryType: 'REJECTED_HYPOTHESIS',
          summary: `Rejected candidate: ${cand.description}. Reason: ${cand.rejectionReason}`,
          details: { ...cand.change, rejectionDetails: promoResult.rejectionDetails },
          sampleSize: cand.evidence.sampleSize,
          confidence: 80,
          status: 'ACTIVE',
        });
      }
    }

    // 8. Drift Detection
    const driftReport = DriftDetector.evaluateDrift(experiences);

    // 9. Rollback Evaluation
    RollbackManager.checkAndExecuteRollback(experiences);

    // 10. Mark Scheduler
    LearningScheduler.markCycleCompleted(expCount);
    const completedAt = new Date();

    const summary = `Self-Improvement cycle completed in ${completedAt.getTime() - startedAt.getTime()}ms. Processed ${expCount} experiences, mined ${patterns.length} patterns, generated ${candidates.length} candidates (${promotedCount} promoted, ${rejectedCount} rejected/in-shadow). System drift: ${driftReport.hasDrift ? 'DETECTED' : 'NORMAL'}.`;

    return {
      id: `learn-run-${Date.now()}`,
      startedAt,
      completedAt,
      experiencesUsed: expCount,
      hypothesesDiscovered: patterns.length,
      candidatesGenerated: candidates.length,
      candidatesPromoted: promotedCount,
      candidatesRejected: rejectedCount,
      errorReport,
      driftReport,
      summary,
    };
  }
}
