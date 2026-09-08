import { ICandle } from '@quant/shared';
import { TradingExperience } from '../types';
import { KnowledgeGraph, ResearchExperiment, ResearchHypothesis, SelfImprovementScorecard } from './types';
export declare class ResearchEngine {
    /**
     * Executes a complete automated research cycle from raw trading experiences and historical candle context.
     */
    static runResearchCycle(experiences: TradingExperience[], candles: ICandle[], options: {
        instrument: string;
        timeframe: string;
        currentProductionVersion?: string;
    }): Promise<{
        hypotheses: ResearchHypothesis[];
        experiments: ResearchExperiment[];
        scorecard: SelfImprovementScorecard;
        knowledgeGraph: KnowledgeGraph;
    }>;
}
