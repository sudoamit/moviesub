import { PrismaService } from '../common/prisma/prisma.service';
import { CandlesService } from '../candles/candles.service';
import { ResearchExperiment, ResearchHypothesis } from '@quant/learning-engine';
export declare class ResearchService {
    private readonly prisma;
    private readonly candlesService;
    private readonly logger;
    constructor(prisma: PrismaService, candlesService: CandlesService);
    private seedDefaultHypotheses;
    /**
     * Retrieves Self-Improvement Scorecard and Learning Scorecard
     */
    getScorecard(): Promise<{
        selfImprovementScorecard: import("@quant/learning-engine").SelfImprovementScorecard;
        learningScorecard: import("@quant/learning-engine").LearningScorecard;
    }>;
    /**
     * Lists all research hypotheses
     */
    getHypotheses(): Promise<ResearchHypothesis[]>;
    /**
     * Lists all research experiments
     */
    getExperiments(): Promise<{
        id: string;
        experimentHash: string;
        hypothesis: string;
        instrument: string;
        timeframe: string;
        baseStrategyVersion: string;
        candidateStrategyVersion: string;
        featureSchemaVersion: string;
        datasetMetadata: any;
        trainingPeriod: any;
        validationPeriod: any;
        testPeriod: any;
        holdoutPeriod: any;
        sampleSize: number;
        baselineMetrics: any;
        candidateMetrics: any;
        robustnessMetrics: any;
        slippageStressScenarios: any;
        missedTradeScenarios: any;
        monteCarloMetrics: any;
        benchmarks: any;
        complexity: any;
        status: any;
        rejectionReasons: any;
        passedOutOfSample: boolean;
        passedHoldout: boolean;
        createdAt: Date;
    }[]>;
    /**
     * Runs an automated research experiment for a hypothesis against historical market data.
     */
    runExperiment(dto: {
        hypothesisId?: string;
        symbol?: string;
        timeframe?: string;
        rulesDefinition?: any;
    }): Promise<ResearchExperiment>;
    /**
     * Returns current multidimensional Knowledge Graph
     */
    getKnowledgeGraph(): Promise<import("@quant/learning-engine").KnowledgeGraph>;
    /**
     * Runs granular 8-way feature component ablation study
     */
    runAblation(symbol?: string, timeframe?: string): Promise<import("@quant/backtesting").IComponentAblationResult>;
    /**
     * Evaluates post-trade counterfactual exits across trading experiences
     */
    getCounterfactuals(): Promise<{
        totalOpportunityLossR: number;
        recommendedExitPolicy: string;
        tp1SuperiorityPct: number;
        tp2SuperiorityPct: number;
        trailingBESuperiorityPct: number;
    }>;
}
