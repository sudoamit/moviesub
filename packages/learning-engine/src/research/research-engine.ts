import { ICandle } from '@quant/shared';
import { TradingExperience } from '../types';
import { ExperimentManager } from './experiment-manager';
import { ExperimentRegistry } from './experiment-registry';
import { HypothesisEngine } from './hypothesis-engine';
import { KnowledgeGraphEngine } from './knowledge-graph';
import { ResearchMemory } from './research-memory';
import { ScorecardEngine } from './scorecard';
import {
  KnowledgeGraph,
  ResearchExperiment,
  ResearchHypothesis,
  SelfImprovementScorecard,
} from './types';

export class ResearchEngine {
  /**
   * Executes a complete automated research cycle from raw trading experiences and historical candle context.
   */
  public static async runResearchCycle(
    experiences: TradingExperience[],
    candles: ICandle[],
    options: {
      instrument: string;
      timeframe: string;
      currentProductionVersion?: string;
    },
  ): Promise<{
    hypotheses: ResearchHypothesis[];
    experiments: ResearchExperiment[];
    scorecard: SelfImprovementScorecard;
    knowledgeGraph: KnowledgeGraph;
  }> {
    const instrument = options.instrument.toUpperCase();
    const timeframe = options.timeframe || '15m';
    const currentProdVersion = options.currentProductionVersion || 'v2.0-smc-quant';

    // 1. Update Knowledge Graph
    const knowledgeGraph = KnowledgeGraphEngine.buildFromExperiences(experiences);

    // 2. Mine Empirical Hypotheses
    const rawHypotheses = HypothesisEngine.mineHypothesesFromExperiences(experiences);
    const validHypotheses: ResearchHypothesis[] = [];

    for (const hyp of rawHypotheses) {
      // Check for redundancy in ResearchMemory
      const check = ResearchMemory.isHypothesisRedundant(hyp.condition);
      if (!check.redundant) {
        HypothesisEngine.validateHypothesisStructure(hyp);
        ResearchMemory.recordHypothesis(hyp);
        validHypotheses.push(hyp);
      }
    }

    // 3. Execute Experiments for new hypotheses
    const experiments: ResearchExperiment[] = [];
    for (const hyp of validHypotheses) {
      try {
        const exp = await ExperimentManager.executeExperiment(hyp, candles, {
          instrument,
          timeframe,
          baseStrategyVersion: currentProdVersion,
        });

        // Update hypothesis status in memory
        if (exp.status === 'PASSED') {
          ResearchMemory.updateHypothesisStatus(hyp.id, 'VALIDATED');
        } else {
          ResearchMemory.updateHypothesisStatus(
            hyp.id,
            'REJECTED',
            exp.rejectionReasons.join('; '),
          );
        }

        experiments.push(exp);
      } catch (err) {
        console.error(`Experiment execution failed for hypothesis ${hyp.id}:`, err);
      }
    }

    // 4. Generate Scorecard
    const scorecard = ScorecardEngine.generateSelfImprovementScorecard({
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
