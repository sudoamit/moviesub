import { MarketRegimeType, Timeframe } from '@quant/shared';

export type ExperimentStatus = 'RUNNING' | 'PASSED' | 'FAILED' | 'REJECTED';

export type HypothesisStatus = 'DISCOVERED' | 'TESTING' | 'VALIDATED' | 'PROMOTED' | 'REJECTED';

export interface PerformanceMetrics {
  tradeCount: number;
  winRate: number;
  lossRate: number;
  expectancy: number; // in R multiples
  averageR: number;
  profitFactor: number;
  grossProfit: number;
  grossLoss: number;
  netPnL: number;
  maxDrawdownPercent: number;
  sharpeRatio: number;
  sortinoRatio: number;
  calmarRatio: number;
  averageHoldingTimeMinutes: number;
  mfeAverage: number;
  maeAverage: number;
  tp1Rate: number;
  tp2Rate: number;
  tp3Rate: number;
  slRate: number;
  timeoutRate: number;
}

export interface OptionsSpecificMetrics {
  averageIV: number;
  averagePremiumDecayPct: number;
  averageSpread: number;
  averageSlippage: number;
  expiryDistribution: Record<string, number>;
}

export interface RobustnessMetrics {
  walkForwardDegradationPct: number;
  monteCarloRuinProbability: number;
  monteCarloMedianDrawdown: number;
  monteCarlo95thPercentileDrawdown: number;
  monteCarlo5thPercentileReturn: number;
  monteCarlo95thPercentileReturn: number;
  slippageSurvivalScore: number; // 0 to 1 score surviving 1x, 2x, 3x slippage
  missedTradeSurvivalScore: number; // 0 to 1 score across 100%, 95%, 90%, 85% execution
  complexityPenalty: number; // Penalty based on rule and threshold count
  multiRegimeConsistencyScore: number;
}

export interface SlippageStressResult {
  multiplier: number; // 1.0, 2.0, 3.0
  expectancy: number;
  profitFactor: number;
  maxDrawdownPercent: number;
  isProfitable: boolean;
}

export interface MissedTradeStressResult {
  executionRatePct: number; // 100, 95, 90, 85
  expectancy: number;
  profitFactor: number;
  maxDrawdownPercent: number;
  isProfitable: boolean;
}

export interface MonteCarloMetrics {
  iterations: number;
  medianReturn: number;
  percentile5thReturn: number;
  percentile95thReturn: number;
  medianDrawdown: number;
  percentile95thDrawdown: number;
  probabilityOfRuin: number;
}

export interface AblationMatrixRow {
  configuration: string;
  removedComponent?: string;
  tradeCount: number;
  winRate: number;
  expectancy: number;
  profitFactor: number;
  maxDrawdownPercent: number;
  deltaRFromBaseline: number;
}

export interface AblationMatrixResult {
  baselineExpectancy: number;
  componentAblations: AblationMatrixRow[];
  modelHierarchyAblations: AblationMatrixRow[];
  mostCriticalComponent: string;
  leastEffectiveComponent: string;
}

export interface ResearchHypothesis {
  id: string;
  title: string;
  source: 'OUTCOME_ANALYSIS' | 'ERROR_ANALYSIS' | 'REGIME_STATS' | 'ML_ERROR' | 'LLM_ASSISTANT';
  condition: string;
  population: string; // e.g. "BTCUSDT 15m" or "NIFTY 15m Options"
  sampleSize: number;
  baselineExpectancy: number;
  candidateExpectancy?: number;
  expectedEffectR: number; // expected change in R
  confidenceInterval: [number, number]; // 95% CI
  pValue: number;
  status: HypothesisStatus;
  rejectionReason?: string;
  rulesDefinition: {
    feature?: string;
    operator?: '>' | '<' | '==' | '!=' | 'IN' | 'NOT_IN';
    threshold?: number | string;
    regimeFilter?: string[];
    volatilityFilter?: string[];
    timeframeFilter?: string[];
    sessionFilter?: string[];
  };
  testedCount: number;
  successCount: number;
  rejectedCount: number;
  createdAt: Date;
  lastTestedAt?: Date;
}

export interface ResearchExperiment {
  id: string;
  experimentHash: string;
  hypothesisId?: string;
  hypothesis: string;
  instrument: string;
  timeframe: string;
  baseStrategyVersion: string;
  candidateStrategyVersion: string;
  featureSchemaVersion: string;
  datasetMetadata: {
    datasetVersion: string;
    dataSource: string;
    downloadTime: Date;
    candleCount: number;
    timeRange: [Date, Date];
    dataQuality: 'PRISTINE' | 'ADEQUATE' | 'DEGRADED';
  };
  trainingPeriod: {
    start: Date;
    end: Date;
  };
  validationPeriod: {
    start: Date;
    end: Date;
  };
  testPeriod: {
    start: Date;
    end: Date;
  };
  holdoutPeriod: {
    start: Date;
    end: Date;
  };
  sampleSize: number;
  baselineMetrics: PerformanceMetrics;
  candidateMetrics: PerformanceMetrics;
  robustnessMetrics: RobustnessMetrics;
  slippageStressScenarios: SlippageStressResult[];
  missedTradeScenarios: MissedTradeStressResult[];
  monteCarloMetrics: MonteCarloMetrics;
  optionsMetrics?: OptionsSpecificMetrics;
  benchmarks: {
    productionExpectancy: number;
    candidateExpectancy: number;
    buyAndHoldReturnPct: number;
    assetBenchmarkName: string;
  };
  complexity: {
    ruleCount: number;
    thresholdCount: number;
    featureCount: number;
    dependencyCount: number;
    complexityScore: number;
  };
  status: ExperimentStatus;
  rejectionReasons: string[];
  passedOutOfSample: boolean;
  passedHoldout: boolean;
  createdAt: Date;
  completedAt?: Date;
}

export interface KnowledgeGraphNode {
  id: string;
  type: 'REGIME' | 'SETUP' | 'FEATURE' | 'ENTRY_QUALITY' | 'EXIT_QUALITY' | 'OUTCOME' | 'ERROR';
  name: string;
  properties: Record<string, unknown>;
  frequency: number;
  averageR: number;
  winRate: number;
}

export interface KnowledgeGraphEdge {
  id: string;
  sourceNodeId: string;
  targetNodeId: string;
  relationship: 'TRIGGERS' | 'CORRELATES_WITH' | 'CAUSES_FAILURE' | 'AMPLIFIES' | 'SUPPRESSES';
  weight: number; // 0 to 1
  sampleCount: number;
  pVal: number;
}

export interface KnowledgeGraph {
  nodes: KnowledgeGraphNode[];
  edges: KnowledgeGraphEdge[];
  lastUpdated: Date;
}

export interface SelfImprovementScorecard {
  experiencesCount: number;
  newPatternsDiscovered: number;
  hypothesesGenerated: number;
  experimentsExecuted: number;
  candidatesGenerated: number;
  candidatesPassedOOS: number;
  candidatesInShadow: number;
  candidatesPromoted: number;
  candidatesRejected: number;
  currentProductionVersion: string;
  bestCandidateVersion?: string;
  expectedImprovementDeltaR: number;
  systemState: 'IMPROVING' | 'OBSERVING_PLATEAU' | 'DRIFT_ALERT';
  reportDate: Date;
}

export interface LearningScorecard {
  versions: {
    version: string;
    expectancyR: number;
    maxDrawdownPct: number;
    profitFactor: number;
    brierCalibrationScore: number;
    winRate: number;
    sharpeRatio: number;
    promotedAt: Date;
  }[];
  expectancyTrend: { from: number; to: number; deltaR: number };
  drawdownTrend: { from: number; to: number; deltaPct: number };
  profitFactorTrend: { from: number; to: number; deltaPF: number };
  calibrationTrend: { from: number; to: number; deltaBrier: number };
}
