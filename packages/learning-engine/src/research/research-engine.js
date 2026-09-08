"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ResearchEngine = void 0;
const experiment_manager_1 = require("./experiment-manager");
const hypothesis_engine_1 = require("./hypothesis-engine");
const knowledge_graph_1 = require("./knowledge-graph");
const research_memory_1 = require("./research-memory");
const scorecard_1 = require("./scorecard");
class ResearchEngine {
    /**
     * Executes a complete automated research cycle from raw trading experiences and historical candle context.
     */
    static async runResearchCycle(experiences, candles, options) {
        const instrument = options.instrument.toUpperCase();
        const timeframe = options.timeframe || '15m';
        const currentProdVersion = options.currentProductionVersion || 'v2.0-smc-quant';
        // 1. Update Knowledge Graph
        const knowledgeGraph = knowledge_graph_1.KnowledgeGraphEngine.buildFromExperiences(experiences);
        // 2. Mine Empirical Hypotheses
        const rawHypotheses = hypothesis_engine_1.HypothesisEngine.mineHypothesesFromExperiences(experiences);
        const validHypotheses = [];
        for (const hyp of rawHypotheses) {
            // Check for redundancy in ResearchMemory
            const check = research_memory_1.ResearchMemory.isHypothesisRedundant(hyp.condition);
            if (!check.redundant) {
                hypothesis_engine_1.HypothesisEngine.validateHypothesisStructure(hyp);
                research_memory_1.ResearchMemory.recordHypothesis(hyp);
                validHypotheses.push(hyp);
            }
        }
        // 3. Execute Experiments for new hypotheses
        const experiments = [];
        for (const hyp of validHypotheses) {
            try {
                const exp = await experiment_manager_1.ExperimentManager.executeExperiment(hyp, candles, {
                    instrument,
                    timeframe,
                    baseStrategyVersion: currentProdVersion,
                });
                // Update hypothesis status in memory
                if (exp.status === 'PASSED') {
                    research_memory_1.ResearchMemory.updateHypothesisStatus(hyp.id, 'VALIDATED');
                }
                else {
                    research_memory_1.ResearchMemory.updateHypothesisStatus(hyp.id, 'REJECTED', exp.rejectionReasons.join('; '));
                }
                experiments.push(exp);
            }
            catch (err) {
                console.error(`Experiment execution failed for hypothesis ${hyp.id}:`, err);
            }
        }
        // 4. Generate Scorecard
        const scorecard = scorecard_1.ScorecardEngine.generateSelfImprovementScorecard({
            experiencesCount: experiences.length,
            newPatternsCount: validHypotheses.length,
            currentProductionVersion: currentProdVersion,
            shadowCount: experiments.filter((e) => e.status === 'PASSED').length,
        });
        return {
            hypotheses: validHypotheses,
            experiments,
            scorecard,
            knowledgeGraph,
        };
    }
}
exports.ResearchEngine = ResearchEngine;
//# sourceMappingURL=research-engine.js.map