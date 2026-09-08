import { ResearchService } from './research.service';
export declare class ResearchController {
    private readonly researchService;
    constructor(researchService: ResearchService);
    getScorecard(): Promise<{
        selfImprovementScorecard: import("@quant/learning-engine").SelfImprovementScorecard;
        learningScorecard: import("@quant/learning-engine").LearningScorecard;
    }>;
    getHypotheses(): Promise<import("@quant/learning-engine").ResearchHypothesis[]>;
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
    runExperiment(body: {
        hypothesisId?: string;
        symbol?: string;
        timeframe?: string;
        rulesDefinition?: any;
    }): Promise<import("@quant/learning-engine").ResearchExperiment>;
    getKnowledgeGraph(): Promise<import("@quant/learning-engine").KnowledgeGraph>;
    runAblation(body: {
        symbol?: string;
        timeframe?: string;
    }): Promise<import("@quant/backtesting").IComponentAblationResult>;
    getCounterfactuals(): Promise<{
        totalOpportunityLossR: number;
        recommendedExitPolicy: string;
        tp1SuperiorityPct: number;
        tp2SuperiorityPct: number;
        trailingBESuperiorityPct: number;
    }>;
}
