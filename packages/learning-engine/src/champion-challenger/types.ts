/**
 * Phase 10 — Champion vs Challenger Domain Types
 * Immutable evaluation identity, model registry records, fair comparison, and promotion eligibility.
 */

export type ModelStatus = 'CANDIDATE' | 'CHALLENGER' | 'CHAMPION' | 'RETIRED' | 'INVALID';

export interface ModelRecord {
  readonly modelId: string;
  readonly modelVersion: string;
  readonly modelType: string;
  readonly artifactLocation: string;
  readonly artifactHash: string;
  readonly trainingRunId: string;
  readonly datasetVersion: string;
  readonly featureVersion: string;
  readonly labelVersion: string;
  readonly createdAt: number;
  readonly status: ModelStatus;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface ChampionRecord {
  readonly slotId: string;
  readonly modelId: string;
  readonly modelVersion: string;
  readonly artifactHash: string;
  readonly assignedAt: number;
  readonly registryVersion: number;
  readonly assignmentReason?: string;
  readonly promotionDecisionId?: string;
  readonly evaluationId?: string;
}

export type ChallengerStatus = 'ACTIVE_CHALLENGER' | 'EVALUATING' | 'REJECTED' | 'RETIRED';

export interface ChallengerRecord {
  readonly slotId: string;
  readonly modelId: string;
  readonly modelVersion: string;
  readonly artifactHash: string;
  readonly registeredAt: number;
  readonly sourceTrainingRunId: string;
  readonly status: ChallengerStatus;
  readonly statusReason?: string;
}

export interface EvaluationIdentity {
  readonly evaluationId: string;
  readonly modelId: string;
  readonly modelVersion: string;
  readonly artifactHash: string;
  readonly trainingRunId: string;
  readonly datasetVersion: string;
  readonly datasetHash: string;
  readonly featureVersion: string;
  readonly featureSchemaHash: string;
  readonly labelVersion: string;
  readonly codeCommit: string;
  readonly walkForwardConfigVersion: string;
  readonly walkForwardConfigHash: string;
  readonly executionConfigVersion: string;
  readonly executionConfigHash: string;
  readonly riskConfigVersion: string;
  readonly riskConfigHash: string;
  readonly costConfigVersion: string;
  readonly costConfigHash: string;
  readonly partialExitPolicyVersion: string;
  readonly partialExitPolicyHash: string;
  readonly strategyConfigVersion: string;
  readonly strategyConfigHash: string;
  readonly evaluationWindowStart: number;
  readonly evaluationWindowEnd: number;
  readonly randomSeed: number;
  readonly createdAt: number;
}

export interface EvaluationMetrics {
  readonly netPnL: number;
  readonly totalReturn: number;
  readonly maxDrawdownPercent: number;
  readonly profitFactor: number;
  readonly winRate: number;
  readonly tradeCount: number;
  readonly averageTrade: number;
  readonly averageWin: number;
  readonly averageLoss: number;
  readonly expectancy: number;
  readonly fees: number;
  readonly slippage: number;
  readonly sharpeRatio?: number;
  readonly sortinoRatio?: number;
  readonly cagr?: number;
}

export interface TradeStatistics {
  readonly grossProfit: number;
  readonly grossLoss: number;
  readonly winningTrades: number;
  readonly losingTrades: number;
  readonly maxConsecutiveWins: number;
  readonly maxConsecutiveLosses: number;
  readonly averageHoldingPeriodMs: number;
}

export interface RiskStatistics {
  readonly maxDrawdownAmount: number;
  readonly maxDrawdownPercent: number;
  readonly valueAtRisk95?: number;
  readonly conditionalVaR95?: number;
}

export interface CostStatistics {
  readonly totalFees: number;
  readonly totalSlippage: number;
  readonly feeDragPercent: number;
  readonly slippageDragPercent: number;
}

export interface EvaluationBundle {
  readonly evaluationIdentity: EvaluationIdentity;
  readonly evaluationFingerprint: string;
  readonly resultHash: string;
  readonly bundleHash: string;
  readonly modelMetadata: Readonly<Record<string, unknown>>;
  readonly metrics: EvaluationMetrics;
  readonly tradeStatistics: TradeStatistics;
  readonly riskStatistics: RiskStatistics;
  readonly costStatistics: CostStatistics;
  readonly walkForwardStatistics?: Readonly<Record<string, unknown>>;
  readonly perWindowResults?: ReadonlyArray<Record<string, unknown>>;
  readonly validationResults?: Readonly<Record<string, unknown>>;
  readonly comparisonMetadata?: Readonly<Record<string, unknown>>;
}

export interface MetricDeltas {
  readonly netPnlDelta: number;
  readonly returnDelta: number;
  readonly drawdownDelta: number; // Positive means challenger has higher (worse) drawdown
  readonly sharpeDelta?: number;
  readonly sortinoDelta?: number;
  readonly profitFactorDelta: number;
  readonly winRateDelta: number;
  readonly tradeCountDelta: number;
  readonly expectancyDelta: number;
  readonly costDelta: number;
}

export interface ComparisonResult {
  readonly isComparable: boolean;
  readonly violationReasons: string[];
  readonly championEvaluationId: string;
  readonly challengerEvaluationId: string;
  readonly championFingerprint: string;
  readonly challengerFingerprint: string;
  readonly championBundleHash?: string;
  readonly challengerBundleHash?: string;
  readonly championMetrics?: EvaluationMetrics;
  readonly challengerMetrics?: EvaluationMetrics;
  readonly deltas?: MetricDeltas;
  readonly comparedAt: number;
}

export interface FairPromotionCriteria {
  readonly minTradeCount: number;
  readonly minExpectancyDelta: number;
  readonly maxDrawdownDeteriorationPercent: number; // Max allowed increase in maxDrawdownPercent (e.g. 2.0%)
  readonly minWinRateDelta?: number;
  readonly minSharpeDelta?: number;
  readonly minProfitFactor?: number;
}

export type Phase10PromotionCriteria = FairPromotionCriteria;

export interface PromotionEligibility {
  readonly eligible: boolean;
  readonly reasons: string[];
  readonly criteriaMet: Readonly<Record<string, boolean>>;
  readonly evaluatedAt: number;
}

/**
 * Model Registry Persistence Storage Interface
 */
export interface IModelRegistryStore {
  saveModel(model: ModelRecord): void;
  getModel(modelId: string): ModelRecord | undefined;
  saveChampion(champion: ChampionRecord): void;
  getChampion(slotId: string): ChampionRecord | undefined;
  saveChallenger(challenger: ChallengerRecord): void;
  getChallengers(slotId: string): ChallengerRecord[];
  getAllModels(): ModelRecord[];
  getAllChampions(): ChampionRecord[];
  getAllChallengers(): ChallengerRecord[];
  clear(): void;
  executeTransaction<T>(operation: () => T): T;
}
