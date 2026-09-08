import { ExperienceStore } from './experience-store';
import { TemporalDatasetBuilder } from './dataset-manager';
import { ErrorAnalyzer } from './error-analyzer';
import { PatternDiscoveryEngine } from './pattern-discovery';
import { FeatureSelector } from './feature-selector';
import { ModelTrainer } from './model-trainer';
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
  embargoMs?: number;
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
    const embargoMs = options.embargoMs ?? 0;

    // 1. Ingest experiences
    const experiences = ExperienceStore.query();
    const expCount = experiences.length;

    // 2. Build temporal dataset splits (Train, Validation, OOS) with label end purging & embargo
    let trainSlice = experiences;
    let valSlice = experiences;
    let oosSlice = experiences;

    if (experiences.length >= 10) {
      const datasetBuilder = new TemporalDatasetBuilder();
      const symbol = experiences[0]?.instrument?.symbol || 'BTCUSDT';

      const datasetSamples = experiences.map((exp) => {
        const entryMs = exp.labelStartTimestamp || (exp.execution?.entryTime ? new Date(exp.execution.entryTime).getTime() : new Date(exp.timestamp).getTime());
        const exitMs = exp.labelEndTimestamp || (exp.execution?.exitTime ? new Date(exp.execution.exitTime).getTime() : entryMs + 1800000);
        return {
          sampleId: exp.id,
          timestamp: new Date(exp.timestamp).getTime(),
          labelStartTimestamp: entryMs,
          labelEndTimestamp: exitMs,
          features: exp.marketState?.quant || {},
          labelBinary: exp.outcome?.status === 'WIN' ? 1 : 0,
          labelContinuousR: exp.outcome?.pnlR || 0,
          regime: exp.marketContext?.regime || 'UNKNOWN',
          volatilityBucket: exp.marketContext?.volatilityRegime || 'NORMAL',
        };
      });

      const record = datasetBuilder.createDataset(symbol, '1h', datasetSamples);
      const splits = datasetBuilder.splitDataset(record.metadata.datasetId, 0.6, 0.2, 0.2, embargoMs);

      const trainIds = new Set(splits.train.map((s) => s.sampleId));
      const valIds = new Set(splits.validation.map((s) => s.sampleId));
      const oosIds = new Set(splits.outOfSample.map((s) => s.sampleId));

      trainSlice = experiences.filter((e) => trainIds.has(e.id));
      valSlice = experiences.filter((e) => valIds.has(e.id));
      oosSlice = experiences.filter((e) => oosIds.has(e.id));
    }

    // 3. Perform Error Analysis strictly on Train slice
    const errorReport = ErrorAnalyzer.analyze(trainSlice);

    // 4. Discover Patterns strictly on Train slice
    const patterns = PatternDiscoveryEngine.discover(trainSlice);

    // 5. Select Features & Evaluate Subsets strictly on Train slice
    const featureSelection = FeatureSelector.selectFeatures(trainSlice);

    // 6. Train Canonical ML Model strictly on Train slice
    const modelArtifact = ModelTrainer.trainModel(trainSlice);

    // 7. Domain Metrics on Train slice
    RegimePerformanceAnalyzer.analyze(trainSlice);
    VolatilityPerformanceAnalyzer.analyze(trainSlice);
    StrategyPerformanceAnalyzer.analyze(trainSlice);

    // 8. Candidate Generation based on Train-only patterns, feature selection, and trained ML model
    const candidates = CandidateGenerator.generateCandidates({
      baseStrategyVersion: baseVersion,
      errorReport,
      patterns,
      modelArtifact,
      featureSelection,
    });

    let promotedCount = 0;
    let rejectedCount = 0;
    let shadowCount = 0;

    // 9. Validation Pipeline for each generated Candidate
    for (const cand of candidates) {
      if (!valSlice || valSlice.length === 0) {
        throw new Error('INSUFFICIENT_PURGED_VALIDATION_DATA');
      }
      if (!oosSlice || oosSlice.length === 0) {
        throw new Error('INSUFFICIENT_FINAL_OOS_DATA');
      }

      // 9a. Historical Simulation on Validation slice of development dataset
      const valEval = CandidateEvaluator.evaluate(cand, valSlice);
      if (!valEval.passed) {
        cand.status = 'REJECTED';
        cand.rejectionReason = valEval.rejectionReason || 'Validation evaluation failed.';
        rejectedCount++;
        continue;
      }

      // 9b. Walk-Forward Purged & Embargo Validation on Development Dataset
      const devExperiences = [...trainSlice, ...valSlice];
      const wfEval = WalkForwardValidator.validate(cand, devExperiences, { embargoMs });

      // 9c. Robustness & Transaction Costs
      const costEval = RobustnessEngine.evaluateCosts(cand, valSlice);

      // 9d. Candidate-Specific Seeded Monte Carlo Stress Simulation
      if (!valEval.simulatedRMultiples || valEval.simulatedRMultiples.length === 0) {
        throw new Error('INSUFFICIENT_CANDIDATE_EXECUTION_RESULTS');
      }
      const mcEval = MonteCarloEngine.simulate(valEval.simulatedRMultiples, { seed: 42 });

      // 9e. FINAL OOS BACKTEST on untouched out-of-sample holdout dataset
      const finalOosEval = CandidateEvaluator.evaluate(cand, oosSlice);

      cand.validationMetrics = {
        inSampleExpectancy: wfEval.meanInSampleExpectancy || valEval.candidateExpectancy,
        walkForwardExpectancy: wfEval.meanOutOfSampleExpectancy || valEval.candidateExpectancy,
        outOfSampleExpectancy: finalOosEval.candidateExpectancy,
        profitFactor: finalOosEval.profitFactor,
        maxDrawdownPercent: finalOosEval.maxDrawdownPercent,
        monteCarloRuinProb: mcEval.probabilityOfRuin,
        transactionCostSurvived: costEval.survivedDoubleCosts,
      };

      // 9f. Candidate enters SHADOW state (must undergo live/simulated observation period before promotion)
      cand.status = 'SHADOW';
      ShadowTradingEngine.activateCandidate(cand);
      shadowCount++;

      // 9g. Evaluate promotion ONLY if candidate has completed shadow trade evidence
      if (options.autoPromote && cand.shadowMetrics && cand.shadowMetrics.shadowTradeCount >= 10) {
        const promoResult = PromotionGate.evaluateCandidate(cand, {
          ...PromotionGate.DEFAULT_CRITERIA,
          allowAutoPromotion: true,
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
        }
      } else {
        LearningMemory.setMemory({
          key: `shadow-${cand.candidateVersion}`,
          memoryType: 'REJECTED_HYPOTHESIS',
          summary: `Candidate placed in shadow observation: ${cand.description}`,
          details: { ...cand.change, validationMetrics: cand.validationMetrics },
          sampleSize: cand.evidence.sampleSize,
          confidence: 80,
          status: 'ACTIVE',
        });
      }
    }

    // 10. Drift Detection
    const driftReport = DriftDetector.evaluateDrift(experiences);

    // 11. Rollback Evaluation
    RollbackManager.checkAndExecuteRollback(experiences);

    // 12. Mark Scheduler
    LearningScheduler.markCycleCompleted(expCount);
    const completedAt = new Date();

    const summary = `Self-Improvement cycle completed in ${completedAt.getTime() - startedAt.getTime()}ms. Processed ${expCount} experiences, mined ${patterns.length} patterns, generated ${candidates.length} candidates (${shadowCount} placed in shadow observation, ${promotedCount} promoted, ${rejectedCount} rejected). System drift: ${driftReport.hasDrift ? 'DETECTED' : 'NORMAL'}.`;

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
