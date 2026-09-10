import { Direction, ICandle, IBacktestTrade, ISignalSetup, MarketRegimeType, Timeframe } from '@quant/shared';
import { PointInTimeMarketSnapshot } from '@quant/trading-engine';
export { PointInTimeMarketSnapshot };

export type SimulatedTrade = IBacktestTrade;

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
  features?: Record<string, number>;
  label?: number;
  labelBinary?: number;
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
  | 'TRAINED'
  | 'OOS_VALIDATED'
  | 'SHADOW_PENDING'
  | 'SHADOW_ACTIVE'
  | 'PROMOTION_ELIGIBLE'
  | 'PROMOTED'
  | 'REACTIVATED'
  | 'REJECTED'
  | 'ROLLED_BACK'
  | 'RETIRED'
  | 'GENERATED'
  | 'BACKTESTING'
  | 'VALIDATED'
  | 'SHADOW';

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
    monteCarloRuinProb?: number;
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
  symbol?: string;
  riskConfig?: any;
  executionConfig?: CandidateExecutionConfig;
  createdAt: Date;
  promotedAt?: Date;
}

export interface ExperienceDataset {
  experiences: (TradingExperience | TrainingExample)[];
  datasetId?: string;
  datasetHash: string;
  featureSchemaVersion: string;
  symbol?: string;
  timeframe?: string;
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

export interface CandidateMarketDataset extends MarketDataset {
  isContinuous?: boolean;
  expectedIntervalMs?: number;
}

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
  readonly trades: IBacktestTrade[];
}

export interface ScalerArtifact {
  readonly scalerParameters: Record<string, { mean: number; std: number; min: number; max: number }>;
  readonly [key: string]: unknown;
}

export interface ModelArtifact {
  readonly modelId: string;
  readonly modelVersion: string;
  readonly weights?: number[];
  readonly bias?: number;
  readonly scalerArtifact?: ScalerArtifact;
  readonly featureSchemaHash?: string;
  readonly scalerHash?: string;
  readonly selectedFeatures?: string[];
  readonly selectedFeatureHash?: string;
  readonly [key: string]: unknown;
}

export interface CandidateRiskConfig {
  readonly initialCapital: number;
  readonly maxRiskPerTrade: number;
  readonly lotSize?: number;
  readonly contractSize?: number;
  readonly maxAccountRiskLimit?: number;
  readonly maxLeverage?: number;
  readonly partialExitPolicy: {
    readonly tp1Ratio: number;
    readonly tp2Ratio: number;
    readonly tp3Ratio: number;
    readonly moveStopToBreakevenOnTp1: boolean;
    readonly trailStopOnTp2: boolean;
    readonly trailStopOffsetR: number;
  };
  readonly [key: string]: unknown;
}

export interface CandidateExecutionConfig {
  readonly candidateId: string;
  readonly candidateVersion: string;
  readonly strategyVersion: string;
  readonly configHash: string;
  readonly symbol: string;
  readonly fillModel: string;
  readonly ambiguityMode: string;
  readonly latencyMs: number;
  readonly minMtfScore: number;
  readonly stopLossAtrMultiplier?: number;
  readonly enablePartialTp1Trailing?: boolean;
  readonly highVolatilitySizingMultiplier?: number;
  readonly sizingMultiplier?: number;
  readonly filterRegime?: string;
  readonly regimeMode?: 'INCLUDE' | 'EXCLUDE';
  readonly minProbability?: number;
  readonly conditionRules?: string[];
  readonly fittedValue?: number;
  readonly [key: string]: unknown;
}

export interface CandidateStrategyConfig {
  readonly symbol: string;
  readonly minMtfScore: number;
  readonly stopLossAtrMultiplier?: number;
  readonly sizingMultiplier?: number;
  readonly highVolatilitySizingMultiplier?: number;
  readonly minProbability?: number;
  readonly filterRegime?: string;
  readonly regimeMode?: 'INCLUDE' | 'EXCLUDE';
  readonly scoringWeights?: Record<string, number>;
  readonly evidence?: {
    readonly sampleSize: number;
    readonly expectancyBefore: number;
    readonly expectancyAfterHistorical: number;
    readonly [key: string]: unknown;
  };
  readonly [key: string]: unknown;
}

export interface CandidateArtifact {
  readonly artifactId: string;
  readonly candidateId: string;
  readonly modelId: string;
  readonly modelVersion: string;
  readonly strategyVersion: string;
  readonly candidateVersion: string;
  readonly artifactVersion: string;
  readonly featureSchemaVersion: string;
  readonly featureSchemaHash: string;
  readonly selectedFeatures: string[];
  readonly selectedFeatureHash: string;
  readonly scalerHash: string;
  readonly scalerArtifact?: ScalerArtifact | Record<string, unknown>;
  readonly modelArtifact?: ModelArtifact | Record<string, unknown>;
  readonly modelHash: string;
  readonly strategyConfig: CandidateStrategyConfig | Record<string, unknown>;
  readonly trainingDatasetHash: string;
  readonly validationDatasetHash: string;
  readonly oosDatasetHash: string;
  readonly marketDatasetHash: string;
  readonly developmentMarketDatasetHash?: string;
  readonly datasetHash: string; // compatibility alias
  readonly trainingMarketDatasetHash?: string;
  readonly validationMarketDatasetHash?: string;
  readonly oosMarketDatasetHash?: string;
  readonly trainingExperienceDatasetHash?: string;
  readonly validationExperienceDatasetHash?: string;
  readonly oosExperienceDatasetHash?: string;
  readonly trainingSeed: number;
  readonly candidateSeed?: number;
  readonly parentCandidateId?: string;
  readonly riskConfig: CandidateRiskConfig | Record<string, unknown>;
  readonly executionConfig: CandidateExecutionConfig | Record<string, unknown>;
  readonly status: CandidateStatus;
  readonly createdBy: string;
  readonly createdAt: Date;
  readonly configHash: string;
  readonly artifactHash: string;
  readonly symbol?: string;
  readonly evidence?: {
    readonly sampleSize: number;
    readonly expectancyBefore: number;
    readonly expectancyAfterHistorical: number;
    readonly [key: string]: unknown;
  };
}

export interface ValidatedCandidateArtifact extends CandidateArtifact {
  readonly _brand: 'ValidatedCandidateArtifact';
  readonly symbol: string;
  readonly riskConfig: CandidateRiskConfig;
  readonly executionConfig: CandidateExecutionConfig;
  readonly strategyConfig: CandidateStrategyConfig;
}

export interface WalkForwardFold {
  foldIndex: number;
  trainRange: [Date, Date];
  validateRange: [Date, Date];
  testRange: [Date, Date];
  inSampleExpectancy: number;
  outOfSampleExpectancy: number;
  winRate?: number;
  passed: boolean;
  simulatedTrades?: IBacktestTrade[];
}

export interface FoldArtifact {
  readonly foldIndex: number;
  // Explicit experience dataset hashes
  readonly trainExperienceDatasetHash: string;
  readonly validationExperienceDatasetHash: string;
  readonly oosExperienceDatasetHash: string;
  // Explicit market execution input hashes (warmup + evaluation)
  readonly trainMarketExecutionInputHash: string;
  readonly validationMarketExecutionInputHash: string;
  readonly oosMarketExecutionInputHash: string;
  // Market dataset aliases
  readonly trainMarketDatasetHash: string;
  readonly validationMarketDatasetHash: string;
  readonly oosMarketDatasetHash: string;

  readonly featureSchemaVersion: string;
  readonly selectedFeatures: string[];
  readonly scalerVersion: string;
  readonly scalerParameters: Record<string, { mean: number; std: number; min: number; max: number }>;
  readonly modelVersion: string;
  readonly modelParameters: { weights: number[]; bias: number };
  readonly strategyVersion: string;
  readonly candidateId: string;
  readonly candidateVersion: string;
  readonly strategyParameters: Record<string, string | number | boolean | null | undefined>;
  readonly candidateConfigHash: string;
  readonly trainingSeed: number;
  readonly createdAt: Date;
}

export interface WalkForwardValidationResult {
  folds: WalkForwardFold[];
  meanInSampleExpectancy: number;
  meanOutOfSampleExpectancy: number;
  oosDegradationPct: number;
  isRobust: boolean;
  readonly foldArtifacts?: ReadonlyArray<FoldArtifact>;
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

export interface CandidateMeasurementResult {
  candidateId: string;
  baselineExpectancy: number;
  candidateExpectancy: number;
  expectancyDelta: number;
  profitFactor: number;
  maxDrawdownPercent: number;
  totalSimulatedTrades: number;
  simulatedRMultiples: number[];
  simulatedTrades?: IBacktestTrade[];
  baselineTrades?: number;
}

export interface ICandidateMeasurementOptions {
  baselineCandidate?: StrategyCandidate | CandidateArtifact;
  dataset?: CandidateMarketDataset;
  marketDataset?: CandidateMarketDataset;
  candles?: ICandle[];
  evaluationStartTimestamp?: number;
  evaluationEndTimestamp?: number;
  costPerTradeR?: number;
  feeConfig?: any;
  slippageConfig?: any;
  spreadConfig?: any;
  latencyConfig?: any;
  feeRate?: number;
  slippageBps?: number;
  minimumCandles?: number;
  warmupBars?: number;
  symbol?: string;
  timeframe?: string;
  riskConfig?: CandidateRiskConfig | Record<string, unknown>;
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

export interface ShadowEvaluationWindow {
  candidateId: string;
  marketDatasetHash: string;
  startTimestamp: number;
  endTimestamp: number;
  minimumObservations: number;
  minimumTrades: number;
}

export interface ShadowEvaluationMetrics {
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  grossPnL: number;
  netPnL: number;
  pnlR: number;
  profitFactor: number;
  maxDrawdown: number;
  maxDrawdownR: number;
  expectancy: number;
  averageR: number;
  medianR: number;
  largestLoss: number;
  largestWin: number;
  fees: number;
  slippage: number;
  observationsCount: number;
}

export interface ShadowEvaluationResult {
  candidateId: string;
  passed: boolean;
  metrics: ShadowEvaluationMetrics;
  reasons: string[];
  rejectionReason?: string;
  window: ShadowEvaluationWindow;
  shadowDatasetHash: string;
  shadowMarketDatasetHash?: string;
  shadowFeatureObservationHash?: string;
  shadowExecutionEvidenceHash?: string;
  shadowStartTimestamp: number;
  shadowEndTimestamp: number;
  evaluatedAt: number;
}

export interface PromotionPolicy {
  policyVersion?: string;
  minimumShadowTrades: number;
  minimumShadowObservations: number;
  minimumProfitFactor: number;
  minimumExpectancyR: number;
  maximumDrawdownR: number;
  minimumWinRate?: number;
  requirePositiveNetPnl: boolean;
  requireIndependentShadowWindow: boolean;
  allowAutoPromotion: boolean;
}

export interface PromotionGateInput {
  candidateArtifact: CandidateArtifact;
  shadowResult: ShadowEvaluationResult;
  policy: PromotionPolicy;
}

export interface PromotionDecision {
  decision: 'PROMOTE' | 'REJECT';
  candidateId: string;
  evidenceId?: string;
  evaluatedAt: number;
  reasons: string[];
  rejectionReasons?: string[];
  metrics: ShadowEvaluationMetrics;
  policyVersion: string;
}

export interface PromotionEvidence {
  evidenceId: string;
  candidateId: string;
  artifactHash: string;
  trainingDatasetHash: string;
  validationDatasetHash: string;
  oosDatasetHash: string;
  shadowDatasetHash: string;
  shadowWindowStart: number;
  shadowWindowEnd: number;
  shadowMetrics: ShadowEvaluationMetrics;
  promotionPolicyVersion: string;
  promotionDecision: 'PROMOTE' | 'REJECT';
  decisionReasons: string[];
  evaluatedAt: number;
}

export interface ProductionModelState {
  strategyId: string;
  environment: 'paper' | 'live';
  activeCandidateId: string;
  activeModelVersion: string;
  activeStrategyVersion: string;
  activeArtifactHash: string;
  activatedAt: number;
  activationId: string;
  previousCandidateId?: string;
  previousModelVersion?: string;
  previousArtifactHash?: string;
  promotionEvidenceId?: string;
}

export type ModelRegistryEventType =
  | 'CANDIDATE_REGISTERED'
  | 'OOS_VALIDATED'
  | 'SHADOW_STARTED'
  | 'SHADOW_COMPLETED'
  | 'PROMOTION_EVALUATED'
  | 'PROMOTION_REJECTED'
  | 'PROMOTION_ELIGIBLE'
  | 'PRODUCTION_ACTIVATED'
  | 'PRODUCTION_ROLLED_BACK'
  | 'CANDIDATE_RETIRED';

export interface ModelRegistryEvent {
  eventId: string;
  candidateId: string;
  artifactHash: string;
  timestamp: number;
  eventType: ModelRegistryEventType;
  previousStatus?: CandidateStatus;
  newStatus: CandidateStatus;
  reason?: string;
  metadata?: Record<string, unknown>;
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

// ============================================================================
// PHASE 9: SELF-IMPROVING RETRAINING & CANDIDATE GENERATION DOMAIN CONTRACTS
// ============================================================================

export interface TrainingExample {
  readonly exampleId: string;
  readonly decisionTimestamp: number;
  readonly featureTimestamp: number;
  readonly labelStartTimestamp: number;
  readonly labelEndTimestamp: number;
  readonly features: readonly number[];
  readonly featureNames: readonly string[];
  readonly featureSchemaHash: string;
  readonly marketDatasetHash: string;
  readonly strategyVersion: string;
  readonly candidateVersion?: string;
  readonly label: number; // 1.0 (win/favorable) or 0.0 (loss)
  readonly outcomeR: number; // realized or counterfactual R-multiple (mandatory finite number)
  readonly exitType: string; // e.g. TP1, TP2, TP3, SL, TRAILING_STOP (mandatory authoritative provenance)
  readonly regime: string;
  readonly volatilityBucket: string;
  readonly source: 'HISTORICAL' | 'SHADOW';
}

export interface TrainingDataset {
  readonly datasetId: string;
  readonly datasetHash: string;
  readonly examples: readonly TrainingExample[];
  readonly startTimestamp: number;
  readonly endTimestamp: number;
  readonly featureSchemaHash: string;
  readonly featureNames: readonly string[];
  readonly sampleCount: number;
  readonly symbol: string;
  readonly timeframe: string;
}

export interface ValidationDataset {
  readonly datasetId: string;
  readonly datasetHash: string;
  readonly examples: readonly TrainingExample[];
  readonly startTimestamp: number;
  readonly endTimestamp: number;
  readonly featureSchemaHash: string;
  readonly sampleCount: number;
  readonly purgedOverlapCount: number;
  readonly embargoMs: number;
}

export interface OOSDataset {
  readonly datasetId: string;
  readonly datasetHash: string;
  readonly examples: readonly TrainingExample[];
  readonly startTimestamp: number;
  readonly endTimestamp: number;
  readonly featureSchemaHash: string;
  readonly sampleCount: number;
  readonly purgedOverlapCount: number;
  readonly embargoMs: number;
}

export interface CandidateHypothesis {
  readonly hypothesisId: string;
  readonly hypothesisHash: string;
  readonly candidateId: string;
  readonly baseStrategyVersion: string;
  readonly candidateVersion: string;
  readonly type: StrategyCandidateType;
  readonly description: string;
  readonly parameterChanges: Readonly<Record<string, unknown>>;
  readonly selectedFeatures?: readonly string[];
  readonly modelType?: 'LOGISTIC_V2' | 'GBM' | 'LINEAR';
  readonly modelHyperparameters?: Readonly<Record<string, unknown>>;
  readonly regimeFilters?: readonly string[];
  readonly entryFilters?: Readonly<Record<string, unknown>>;
  readonly exitOverrides?: Readonly<Record<string, unknown>>;
  readonly sourceTrainWindow: {
    readonly startTimestamp: number;
    readonly endTimestamp: number;
    readonly trainingDatasetHash: string;
  };
}

export interface CandidateTrainingResult {
  readonly hypothesis: CandidateHypothesis;
  readonly modelArtifact: ModelArtifact;
  readonly scalerArtifact: ScalerArtifact;
  readonly modelHash: string;
  readonly scalerHash: string;
  readonly selectedFeatureHash: string;
  readonly trainingLoss: number;
  readonly trainingSampleCount: number;
  readonly trainedAt: number;
}

export interface CandidateValidationResult {
  readonly hypothesisId: string;
  readonly passed: boolean;
  readonly validationExpectancyR: number;
  readonly validationWinRate?: number;
  readonly validationProfitFactor: number;
  readonly validationMaxDrawdownR: number;
  readonly validationTradeCount: number;
  readonly walkForwardExpectancyR: number;
  readonly walkForwardFoldsPassed: number;
  readonly walkForwardTotalFolds: number;
  readonly rejectionReason?: string;
  readonly simulatedRMultiples: readonly number[];
}

export interface CandidateOOSResult {
  readonly hypothesisId: string;
  readonly oosExpectancyR: number;
  readonly oosWinRate?: number;
  readonly oosProfitFactor: number;
  readonly oosMaxDrawdownPercent: number;
  readonly oosTradeCount: number;
  readonly oosMarketDatasetHash: string;
  readonly executionDerived: boolean;
  readonly monteCarloRuinProbability?: number;
  readonly isMonteCarloAvailable: boolean;
  readonly transactionCostSurvived: boolean;
}

export interface RetrainingRunConfig {
  readonly maxCandidates: number;
  readonly maxTrainingRuns: number;
  readonly maxFeatureCombinations: number;
  readonly maxHyperparameterCombinations: number;
  readonly embargoMs: number;
  readonly experienceCutoffTimestamp?: number;
  readonly baseStrategyVersion: string;
  readonly symbol: string;
  readonly timeframe: string;
  readonly riskConfig: CandidateRiskConfig;
  readonly executionConfig: CandidateExecutionConfig;
  readonly baseCandidate?: StrategyCandidate | ValidatedCandidateArtifact;
  readonly seed?: number;
  readonly numFolds?: number;
  readonly minimumCandles?: number;
  readonly warmupBars?: number;
  readonly minValidationTrades?: number;
  readonly minOOSTrades?: number;
  readonly minValidationExpectancyR?: number;
  readonly minValidationProfitFactor?: number;
}

export type RetrainingRunStatus =
  | 'IDLE'
  | 'DATASET_BUILDING'
  | 'DATASET_VALIDATED'
  | 'TRAINING'
  | 'VALIDATION'
  | 'WALK_FORWARD'
  | 'OOS_EVALUATION'
  | 'CANDIDATE_ARTIFACT_CREATED'
  | 'REGISTERED'
  | 'COMPLETED'
  | 'FAILED'
  | 'REJECTED';

export interface RetrainingRunRecord {
  readonly runId: string;
  readonly startedAt: number;
  readonly completedAt?: number;
  readonly marketDatasetHash: string;
  readonly experienceDatasetHash: string;
  readonly trainingWindow: { readonly start: number; readonly end: number };
  readonly validationWindow: { readonly start: number; readonly end: number };
  readonly oosWindow: { readonly start: number; readonly end: number };
  readonly candidateIds: readonly string[];
  readonly selectedCandidateId?: string;
  readonly modelVersions: readonly string[];
  readonly configHash: string;
  readonly resultHash?: string;
  readonly status: RetrainingRunStatus;
  readonly failureReason?: string;
}
