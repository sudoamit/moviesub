"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LearningEngine = void 0;
const experience_store_1 = require("./experience-store");
const dataset_manager_1 = require("./dataset-manager");
const error_analyzer_1 = require("./error-analyzer");
const pattern_discovery_1 = require("./pattern-discovery");
const feature_selector_1 = require("./feature-selector");
const model_trainer_1 = require("./model-trainer");
const regime_performance_analyzer_1 = require("./regime-performance-analyzer");
const volatility_performance_analyzer_1 = require("./volatility-performance-analyzer");
const strategy_performance_analyzer_1 = require("./strategy-performance-analyzer");
const candidate_generator_1 = require("./candidate-generator");
const candidate_evaluator_1 = require("./candidate-evaluator");
const walk_forward_validator_1 = require("./walk-forward-validator");
const robustness_engine_1 = require("./robustness-engine");
const monte_carlo_engine_1 = require("./monte-carlo-engine");
const shadow_trading_engine_1 = require("./shadow-trading-engine");
const promotion_gate_1 = require("./promotion-gate");
const rollback_manager_1 = require("./rollback-manager");
const drift_detector_1 = require("./drift-detector");
const learning_memory_1 = require("./learning-memory");
const learning_scheduler_1 = require("./learning-scheduler");
class LearningEngine {
    static VERSION = '1.0.0';
    /**
     * Executes a complete, end-to-end self-improvement learning cycle across all modules.
     */
    static async runLearningCycle(options = {}) {
        const startedAt = new Date();
        const baseVersion = options.baseStrategyVersion || 'v2.0-smc-quant';
        // 1. Ingest experiences
        const experiences = experience_store_1.ExperienceStore.query();
        const expCount = experiences.length;
        // 2. Build temporal dataset splits (Train, Validation, OOS) with label end purging
        let trainSlice = experiences;
        let valSlice = experiences;
        let oosSlice = experiences;
        if (experiences.length >= 10) {
            const datasetBuilder = new dataset_manager_1.TemporalDatasetBuilder();
            const symbol = experiences[0]?.instrument?.symbol || 'BTCUSDT';
            const datasetSamples = experiences.map((exp) => ({
                sampleId: exp.id,
                timestamp: new Date(exp.timestamp).getTime(),
                labelStartTimestamp: exp.labelStartTimestamp,
                labelEndTimestamp: exp.labelEndTimestamp,
                features: exp.marketState?.quant || {},
                labelBinary: exp.outcome?.status === 'WIN' ? 1 : 0,
                labelContinuousR: exp.outcome?.pnlR || 0,
                regime: exp.marketContext?.regime || 'UNKNOWN',
                volatilityBucket: exp.marketContext?.volatilityRegime || 'NORMAL',
            }));
            const record = datasetBuilder.createDataset(symbol, '1h', datasetSamples);
            const splits = datasetBuilder.splitDataset(record.metadata.datasetId, 0.6, 0.2, 0.2);
            const trainIds = new Set(splits.train.map((s) => s.sampleId));
            const valIds = new Set(splits.validation.map((s) => s.sampleId));
            const oosIds = new Set(splits.outOfSample.map((s) => s.sampleId));
            trainSlice = experiences.filter((e) => trainIds.has(e.id));
            valSlice = experiences.filter((e) => valIds.has(e.id));
            oosSlice = experiences.filter((e) => oosIds.has(e.id));
        }
        // 3. Perform Error Analysis strictly on Train slice
        const errorReport = error_analyzer_1.ErrorAnalyzer.analyze(trainSlice);
        // 4. Discover Patterns strictly on Train slice
        const patterns = pattern_discovery_1.PatternDiscoveryEngine.discover(trainSlice);
        // 5. Select Features & Evaluate Subsets strictly on Train slice
        const featureSelection = feature_selector_1.FeatureSelector.selectFeatures(trainSlice);
        // 6. Train Canonical ML Model on Train slice
        const modelArtifact = model_trainer_1.ModelTrainer.trainModel(trainSlice);
        // 7. Domain Metrics on Train slice
        const regimeStats = regime_performance_analyzer_1.RegimePerformanceAnalyzer.analyze(trainSlice);
        const volStats = volatility_performance_analyzer_1.VolatilityPerformanceAnalyzer.analyze(trainSlice);
        const stratStats = strategy_performance_analyzer_1.StrategyPerformanceAnalyzer.analyze(trainSlice);
        // 8. Candidate Generation based on Train-only patterns and trained model
        const candidates = candidate_generator_1.CandidateGenerator.generateCandidates({
            baseStrategyVersion: baseVersion,
            errorReport,
            patterns,
        });
        let promotedCount = 0;
        let rejectedCount = 0;
        // 9. Validation Pipeline for each generated Candidate
        for (const cand of candidates) {
            // 9a. Historical Simulation on Validation slice of development dataset
            const valEval = candidate_evaluator_1.CandidateEvaluator.evaluate(cand, valSlice.length > 0 ? valSlice : trainSlice);
            if (!valEval.passed) {
                cand.status = 'REJECTED';
                cand.rejectionReason = valEval.rejectionReason || 'Validation evaluation failed.';
                rejectedCount++;
                continue;
            }
            // 9b. Walk-Forward Purged & Embargo Validation on Development Dataset
            const devExperiences = [...trainSlice, ...valSlice];
            const wfEval = walk_forward_validator_1.WalkForwardValidator.validate(cand, devExperiences.length >= 18 ? devExperiences : experiences);
            // 9c. Robustness & Transaction Costs
            const costEval = robustness_engine_1.RobustnessEngine.evaluateCosts(cand, valSlice.length > 0 ? valSlice : trainSlice);
            // 9d. Candidate-Specific Seeded Monte Carlo Stress Simulation
            const candRMultiples = valEval.simulatedRMultiples && valEval.simulatedRMultiples.length > 0
                ? valEval.simulatedRMultiples
                : valSlice.map((e) => e.outcome.pnlR);
            const mcEval = monte_carlo_engine_1.MonteCarloEngine.simulate(candRMultiples, { seed: 42 });
            // 9e. FINAL OOS BACKTEST on untouched out-of-sample holdout dataset
            const finalOosEval = candidate_evaluator_1.CandidateEvaluator.evaluate(cand, oosSlice.length > 0 ? oosSlice : valSlice);
            cand.validationMetrics = {
                inSampleExpectancy: wfEval.meanInSampleExpectancy || valEval.candidateExpectancy,
                walkForwardExpectancy: wfEval.meanOutOfSampleExpectancy || valEval.candidateExpectancy,
                outOfSampleExpectancy: finalOosEval.candidateExpectancy || wfEval.meanOutOfSampleExpectancy,
                profitFactor: finalOosEval.profitFactor || valEval.profitFactor,
                maxDrawdownPercent: finalOosEval.maxDrawdownPercent || valEval.maxDrawdownPercent,
                monteCarloRuinProb: mcEval.probabilityOfRuin,
                transactionCostSurvived: costEval.survivedDoubleCosts,
            };
            // 9f. Candidate enters Shadow state (must undergo observation period before promotion)
            cand.status = 'SHADOW';
            shadow_trading_engine_1.ShadowTradingEngine.activateCandidate(cand);
            // 9g. Promotion Gate evaluates ONLY candidates with completed shadow periods
            const promoResult = promotion_gate_1.PromotionGate.evaluateCandidate(cand, {
                ...promotion_gate_1.PromotionGate.DEFAULT_CRITERIA,
                allowAutoPromotion: !!options.autoPromote,
            });
            if (promoResult.approved) {
                promotedCount++;
                learning_memory_1.LearningMemory.setMemory({
                    key: `promoted-${cand.candidateVersion}`,
                    memoryType: 'PROVEN_PATTERN',
                    summary: `Promoted strategy candidate: ${cand.description}`,
                    details: { ...cand.change, ...cand.validationMetrics },
                    sampleSize: cand.evidence.sampleSize,
                    confidence: cand.evidence.pValue ? Math.round((1 - cand.evidence.pValue) * 100) : 95,
                    status: 'ACTIVE',
                });
            }
            else {
                rejectedCount++;
                learning_memory_1.LearningMemory.setMemory({
                    key: `shadow-${cand.candidateVersion}`,
                    memoryType: 'REJECTED_HYPOTHESIS',
                    summary: `Candidate placed in shadow / rejected: ${cand.description}`,
                    details: { ...cand.change, rejectionDetails: promoResult.rejectionDetails },
                    sampleSize: cand.evidence.sampleSize,
                    confidence: 80,
                    status: 'ACTIVE',
                });
            }
        }
        // 8. Drift Detection
        const driftReport = drift_detector_1.DriftDetector.evaluateDrift(experiences);
        // 9. Rollback Evaluation
        rollback_manager_1.RollbackManager.checkAndExecuteRollback(experiences);
        // 10. Mark Scheduler
        learning_scheduler_1.LearningScheduler.markCycleCompleted(expCount);
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
exports.LearningEngine = LearningEngine;
//# sourceMappingURL=learning-engine.js.map