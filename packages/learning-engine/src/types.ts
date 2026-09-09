import { Direction, ICandle, ISignalSetup, MarketRegimeType, Timeframe } from '@quant/shared';
import { PointInTimeMarketSnapshot } from '@quant/trading-engine';

export type TradeOutcomeClassification =
  | 'GOOD_TRADE_WIN'
  | 'GOOD_TRADE_LOSS'
  | 'BAD_TRADE_WIN'
  | 'BAD_TRADE_LOSS'
  | 'EXECUTION_FAILURE'
  | 'DATA_FAILURE'
  | 'MODEL_FAILURE'
  | 'STRATEGY_FAILURE';

export type FailureMode =
  | 'WRONG_DIRECTION'
  | 'FALSE_BOS'
  | 'FALSE_CHOCH'
  | 'LIQUIDITY_MISREAD'
  | 'WEAK_DISPLACEMENT'
  | 'FAILED_ORDER_BLOCK'
  | 'FAILED_FVG'
  | 'BAD_PREMIUM_DISCOUNT'
  | 'HTF_CONFLICT'
  | 'REGIME_MISCLASSIFICATION'
  | 'VOLATILITY_MISREAD'
  | 'LOW_VOLUME'
  | 'LATE_ENTRY'
  | 'EARLY_ENTRY'
  | 'STOP_TOO_TIGHT'
  | 'TARGET_TOO_FAR'
  | 'BAD_RR'
  | 'ML_FALSE_POSITIVE'
  | 'ML_FALSE_NEGATIVE'
  | 'LLM_FALSE_POSITIVE'
  | 'LLM_FALSE_NEGATIVE'
  | 'SLIPPAGE'
  | 'EXECUTION_ERROR'
  | 'DATA_ERROR'
  | 'STRATEGY_FAILURE'
  | 'MODEL_FAILURE'
  | 'TIMEOUT_CHOP';

export interface TradingExperience {
  id: string;
  tradeId: string;
  signalId?: string;
  timestamp: Date;
  decisionTimestamp?: number;
  featureTimestamp?: number;
  labelStartTimestamp?: number;
  labelEndTimestamp?: number;
  instrument: {
    symbol: string;
    assetType: string;
    exchange?: string;
  };
  timeframe?: string;
  marketState: PointInTimeMarketSnapshot | any;
  decision: {
    action: 'BUY' | 'SELL' | 'WAIT' | 'NO_TRADE';
    score: number;
    grade?: string;
  };
  execution: {
    entryPrice: number;
    entryTime: Date;
    exitPrice?: number;
    exitTime?: Date;
  };
  risk: {
    stopLoss: number;
    target1?: number;
    target2?: number;
    target3?: number;
    riskAmount?: number;
    expectedR?: number;
  };
  prediction: {
    probabilityWin?: number;
    probabilityTP1?: number;
    probabilityTP2?: number;
    probabilityStopFirst?: number;
    expectedR?: number;
    confidence?: number;
  };
  outcome: {
    status: 'WIN' | 'LOSS' | 'TIMEOUT' | 'SCRATCH';
    pnl: number;
    pnlR: number;
    maxFavorableExcursion: number;
    maxAdverseExcursion: number;
    holdingTimeSeconds: number;
  };
  marketContext: {
    regime: string;
    volatilityRegime: string;
    session: string;
    dayOfWeek: number;
  };
  outcomeClassification: TradeOutcomeClassification;
  reasons: string[];
  failureReasons: FailureMode[];
  strategyVersion: string;
  modelVersion?: string;
  featureSchemaVersion: string;
  candlesDuringTrade?: any[];
  createdAt: Date;
}

export interface DeploymentBundle {
  bundleId: string;
  strategyVersion: string;
  modelVersion: string;
  featureSchemaVersion: string;
  riskConfigVersion: string;
  executionConfigVersion: string;
  deployedAt: Date;
  status: 'ACTIVE' | 'PREVIOUS' | 'ROLLED_BACK';
}

export interface IFailureModeStats {
  failureMode: FailureMode;
  count: number;
  frequency: number;
  totalLossAmount: number;
  lossContributionPct: number;
  averageR: number;
  winRate: number;
  expectancy: number;
  regimeDistribution: Record<string, number>;
  timeframeDistribution: Record<string, number>;
  instrumentDistribution: Record<string, number>;
}

export interface IErrorReport {
  periodStart: Date;
  periodEnd: Date;
  totalTrades: number;
  overallWinRate: number;
  overallExpectancy: number;
  failureStats: IFailureModeStats[];
  topLossDrivers: IFailureModeStats[];
  recommendations: string[];
}

export interface DiscoveredPattern {
  id: string;
  type: 'POSITIVE_CONFLUENCE' | 'NEGATIVE_FILTER';
  conditions: string[];
  sampleSize: number;
  winRate: number;
  expectancy: number;
  averageR: number;
  profitFactor: number;
  maxDrawdownPct: number;
  confidenceInterval: [number, number]; // [lower, upper] 95% CI on expectancy
  pVal: number;
  robustnessScore: number;
}

export interface NoTradePrediction {
  probabilityBadSetup: number;
  expectedLossR: number;
  confidence: number;
  primaryRiskReason?: string;
}

export interface FeatureImportanceItem {
  featureName: string;
  importanceScore: number;
  rank: number;
  stabilityScore: number;
  driftDetected: boolean;
}

export interface FeatureSelectionResult {
  retainedFeatures: string[];
  prunedFeatures: string[];
  baselineExpectancy: number;
  optimizedExpectancy: number;
  deltaR: number;
}

export type StrategyCandidateType =
  | 'BASELINE'
  | 'FILTER'
  | 'THRESHOLD'
  | 'FEATURE'
  | 'MODEL'
  | 'REGIME'
  | 'VOLATILITY'
  | 'EXIT'
  | 'POSITION_SIZE'
  | 'RISK'
  | 'SIZING'
  | 'TRAILING';

export type CandidateStatus =
  | 'GENERATED' | 'BACKTESTING' | 'VALIDATED' | 'SHADOW' | 'PROMOTED' | 'REJECTED' | 'ROLLED_BACK';

export interface StrategyCandidate {
  id: string;
  baseStrategyVersion: string;
  candidateVersion: string;
  type: StrategyCandidateType;
  description: string;
  change: Record<string, unknown>;
  featureSchemaVersion?: string;
  evidence: {
    sampleSize: number;
    expectancyBefore: number;
    expectancyAfterHistorical: number;
    confidenceInterval?: [number, number];
    pValue?: number;
  };
  validationMetrics?: {
    inSampleExpectancy: number;
    walkForwardExpectancy: number;
    outOfSampleExpectancy: number;
    profitFactor: number;
    maxDrawdownPercent: number;
    monteCarloRuinProb: number;
    transactionCostSurvived: boolean;
  };
  shadowMetrics?: {
    shadowTradeCount: number;
    shadowExpectancy: number;
    shadowWinRate: number;
    shadowMaxDrawdown: number;
  };
  status: CandidateStatus;
  rejectionReason?: string;
  targetComponent?: string;
  createdAt: Date;
  promotedAt?: Date;
}

export interface ExperienceDataset {
  experiences: TradingExperience[];
  datasetId?: string;
  datasetHash: string;
  featureSchemaVersion: string;
  labelMetadata?: Record<string, unknown>;
  startTimestamp: number;
  endTimestamp: number;
}

export interface MarketDataset {
  symbol?: string;
  timeframe: string;
  executionCandles: ICandle[];
  higherTimeframeCandles?: Record<string, ICandle[]>;
  startTimestamp: number;
  endTimestamp: number;
  datasetHash: string;
  marketDataHash?: string;
  continuityMetadata?: {
    isContinuous: boolean;
    intervalMs: number;
    candleCount: number;
  };
}

export interface CandidateMarketDataset extends MarketDataset {}

export interface HistoricalExperienceOutcome {
  readonly _brand: 'HistoricalExperienceOutcome';
  readonly status: 'WIN' | 'LOSS' | 'TIMEOUT' | 'SCRATCH';
  readonly pnl: number;
  readonly pnlR: number;
  readonly maxFavorableExcursion: number;
  readonly maxAdverseExcursion: number;
  readonly holdingTimeSeconds: number;
  readonly exitPrice?: number;
  readonly exitTime?: Date;
}

export interface SimulatedBacktestOutcome {
  readonly _brand: 'SimulatedBacktestOutcome';
  readonly tradeCount: number;
  readonly winRate: number;
  readonly expectancyR: number;
  readonly totalPnLR: number;
  readonly profitFactor: number;
  readonly maxDrawdownPercent: number;
  readonly totalFees: number;
  readonly totalSlippage: number;
  readonly trades: any[];
}

export interface CandidateArtifact {
  readonly artifactId: string;
  readonly candidateId: string;
  readonly candidateVersion: string;
  readonly datasetHash: string;
  readonly strategyVersion: string;
  readonly strategyConfig: Record<string, unknown>;
  readonly modelArtifact?: Record<string, unknown>;
  readonly featureSchemaVersion: string;
  readonly featureSchemaHash?: string;
  readonly selectedFeatures: string[];
  readonly selectedFeatureHash?: string;
  readonly scalerArtifact?: Record<string, unknown>;
  readonly scalerHash?: string;
  readonly riskConfig: Record<string, unknown>;
  readonly executionConfig: Record<string, unknown>;
  readonly trainingSeed?: number;
  readonly candidateSeed?: number;
  readonly parentCandidateId?: string;
  readonly artifactVersion?: string;
  readonly createdAt: Date;
  readonly configHash: string;
}

export interface WalkForwardFold {
  foldIndex: number;
  trainRange: [Date, Date];
  validateRange: [Date, Date];
  testRange: [Date, Date];
  inSampleExpectancy: number;
  outOfSampleExpectancy: number;
  winRate: number;
  passed: boolean;
}

export interface WalkForwardValidationResult {
  folds: WalkForwardFold[];
  meanInSampleExpectancy: number;
  meanOutOfSampleExpectancy: number;
  oosDegradationPct: number;
  isRobust: boolean;
}

export interface MonteCarloSimulationResult {
  iterations: number;
  probabilityOfRuin: number;
  expectedDrawdownPct: number;
  maxDrawdown95Pct: number;
  maxDrawdown99Pct: number;
  medianExpectancyR: number;
  isRobust: boolean;
}

export interface ShadowTradeRecord {
  id: string;
  candidateId: string;
  symbol: string;
  timeframe: string;
  direction: Direction;
  entryPrice: number;
  entryTime: Date;
  exitPrice?: number;
  exitTime?: Date;
  pnl?: number;
  pnlR?: number;
  isClosed: boolean;
}

export interface PromotionCriteria {
  minHistoricalTrades: number;
  minShadowTrades: number;
  minOutOfSampleExpectancyDelta: number; // e.g. +0.05R
  maxAllowedDrawdownIncreasePct: number; // e.g. +10%
  maxMonteCarloRuinProbability: number; // e.g. 0.01 (1%)
  requireMultiRegimeRobustness: boolean;
  requireTransactionCostSurvival: boolean;
  allowAutoPromotion: boolean;
}

export interface PromotionEvaluationResult {
  approved: boolean;
  candidateId: string;
  candidateVersion: string;
  score: number;
  reasons: string[];
  rejectionDetails?: string[];
}

export interface DriftReport {
  hasDrift: boolean;
  featureDrift: boolean;
  predictionDrift: boolean;
  performanceDrift: boolean;
  regimeDrift: boolean;
  executionDrift: boolean;
  details: string[];
  recommendation: 'CONTINUE' | 'MONITOR_CLOSELY' | 'FREEZE_PROMOTIONS' | 'ROLLBACK';
}

export interface LearningMemoryItem {
  id: string;
  memoryType: 'PROVEN_PATTERN' | 'FAILURE_PATTERN' | 'REJECTED_HYPOTHESIS' | 'REGIME_RULE';
  key: string;
  summary: string;
  details: Record<string, unknown>;
  sampleSize: number;
  confidence: number;
  status: 'ACTIVE' | 'SUPERSEDED' | 'ARCHIVED';
  createdAt: Date;
  updatedAt: Date;
}

export interface LearningRunReport {
  id: string;
  startedAt: Date;
  completedAt: Date;
  trainingSeed?: number;
  experiencesUsed: number;
  hypothesesDiscovered: number;
  candidatesGenerated: number;
  candidatesPromoted: number;
  candidatesRejected: number;
  errorReport: IErrorReport;
  driftReport: DriftReport;
  summary: string;
}
