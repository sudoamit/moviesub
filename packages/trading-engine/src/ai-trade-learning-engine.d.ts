import { ICandle, ISignalSetup, Direction, MarketRegimeType } from '@quant/shared';
import { ISMCAnalysisResult } from './types';
/**
 * Feature Schema Version identifier.
 * Any modification to the feature names or ordering requires incrementing this version.
 */
export declare const FEATURE_SCHEMA_VERSION = "1.0";
/**
 * Deterministic, ordered list of feature names.
 * Array serialization strictly adheres to this index ordering.
 */
export declare const FEATURE_NAMES: readonly ["smcScore", "obStrength", "fvgSize", "mtfAlignment", "killZoneSession", "smtDivergence", "volatilityAtr", "riskRewardRatio", "trendRegime", "liquiditySweep", "bosStrength", "chochStrength", "relativeVolume", "distanceToHTFLevel", "distanceToLiquidity", "marketSession", "dayOfWeek"];
export type FeatureName = (typeof FEATURE_NAMES)[number];
export declare const FEATURE_VECTOR_DIMENSION: 17;
/**
 * Normalized 17-dimensional feature vector for trade prediction and learning.
 * All features are normalized to [0.0, 1.0].
 */
export interface TradeFeatureVector {
    smcScore: number;
    obStrength: number;
    fvgSize: number;
    mtfAlignment: number;
    killZoneSession: number;
    smtDivergence: number;
    volatilityAtr: number;
    riskRewardRatio: number;
    trendRegime: number;
    liquiditySweep: number;
    bosStrength: number;
    chochStrength: number;
    relativeVolume: number;
    distanceToHTFLevel: number;
    distanceToLiquidity: number;
    marketSession: number;
    dayOfWeek: number;
}
/**
 * Context provided to extract features at prediction time.
 * Strictly guarantees point-in-time state without future leakage.
 */
export interface IFeatureExtractionContext {
    signal: ISignalSetup;
    candles: ICandle[];
    smcAnalysis?: ISMCAnalysisResult | null;
    htfCandles?: ICandle[];
    smtDivergenceScore?: number;
    asOfTimestamp?: Date;
}
/**
 * FeatureVectorExtractor
 * Pure, deterministic extractor that maps trading engine state to a normalized feature vector.
 */
export declare class FeatureVectorExtractor {
    static readonly SCHEMA_VERSION = "1.0";
    static readonly FEATURE_NAMES: readonly ["smcScore", "obStrength", "fvgSize", "mtfAlignment", "killZoneSession", "smtDivergence", "volatilityAtr", "riskRewardRatio", "trendRegime", "liquiditySweep", "bosStrength", "chochStrength", "relativeVolume", "distanceToHTFLevel", "distanceToLiquidity", "marketSession", "dayOfWeek"];
    static readonly DIMENSION: 17;
    /**
     * Extracts a normalized TradeFeatureVector from point-in-time market and setup context.
     */
    static extract(context: IFeatureExtractionContext): TradeFeatureVector;
    /**
     * Serializes a TradeFeatureVector to a Float64 number array in exact deterministic feature order.
     */
    static toArray(features: TradeFeatureVector): number[];
    /**
     * Deserializes a number array back into a strongly-typed TradeFeatureVector.
     * Throws if the array length does not strictly equal the schema dimension.
     */
    static fromArray(arr: number[]): TradeFeatureVector;
    /**
     * Validates that all features in the vector are finite numbers strictly bounded in [0.0, 1.0].
     */
    static validateVector(features: TradeFeatureVector): {
        isValid: boolean;
        errors: string[];
    };
    /**
     * Computes classic Average True Range over period.
     */
    private static calculateAtr;
}
/**
 * Policy for handling candles where both Take Profit and Stop Loss are breached on the same bar.
 */
export declare enum AmbiguousLabelPolicy {
    /** Default: Do not arbitrarily guess winner; exclude from training dataset */
    AMBIGUOUS = "AMBIGUOUS",
    /** Conservative: Treat any ambiguous same-bar breach as a loss (label = 0) */
    CONSERVATIVE = "CONSERVATIVE",
    /** Placeholder for high-frequency sub-minute tick / intrabar resolution */
    INTRABAR_DATA = "INTRABAR_DATA"
}
/**
 * Binary trade outcome label: 1 = Target reached before SL (Win), 0 = SL reached before Target (Loss).
 */
export type TradeOutcomeLabel = 0 | 1;
export interface ITradeEvaluationParams {
    direction: Direction | 'BULLISH' | 'BEARISH';
    entryPrice: number;
    stopLoss: number;
    targetPrice: number;
    entryTimestamp: Date;
    subsequentCandles: ICandle[];
    ambiguousPolicy?: AmbiguousLabelPolicy;
    maxHoldingBars?: number;
}
export interface ITradeOutcomeEvaluation {
    label: TradeOutcomeLabel | null;
    isAmbiguous: boolean;
    resolvedVia: 'TP_FIRST' | 'SL_FIRST' | 'EXPIRED' | 'AMBIGUOUS_SAME_BAR' | 'CONSERVATIVE_LOSS';
    exitPrice: number;
    exitTimestamp: Date;
    realizedRMultiple: number;
    durationBars: number;
}
/**
 * TradeLabelGenerator
 * Evaluates subsequent price action strictly after entry timestamp to determine authentic trade outcome labels.
 */
export declare class TradeLabelGenerator {
    static evaluateOutcome(params: ITradeEvaluationParams): ITradeOutcomeEvaluation | null;
}
/**
 * Supervised Training Example representing one historical trade observation.
 */
export interface TrainingExample {
    id: string;
    signalId?: string;
    symbol: string;
    featureSchemaVersion: string;
    features: TradeFeatureVector;
    featureArray: number[];
    label: TradeOutcomeLabel;
    outcomeR: number;
    predictionTimestamp: Date;
    availableForTrainingAt: Date;
}
export interface IBuildExampleParams {
    id: string;
    signalId?: string;
    signal: ISignalSetup;
    historicalCandlesUpToEntry: ICandle[];
    subsequentCandlesAfterEntry: ICandle[];
    smcAnalysis?: ISMCAnalysisResult | null;
    htfCandles?: ICandle[];
    smtDivergenceScore?: number;
    ambiguousPolicy?: AmbiguousLabelPolicy;
    targetSelection?: 'TP1' | 'TP2' | 'TP3';
}
/**
 * TrainingDatasetBuilder
 * Generates verified, leak-free training examples strictly validating temporal ordering.
 */
export declare class TrainingDatasetBuilder {
    /**
     * Builds a single validated TrainingExample from point-in-time state and future outcome candles.
     * Returns null if the trade is unresolved or ambiguous (under AMBIGUOUS policy).
     */
    static buildExample(params: IBuildExampleParams): TrainingExample | null;
    /**
     * Sorts a dataset strictly in chronological order by predictionTimestamp (ascending).
     * Time series data must NEVER be randomly shuffled.
     */
    static sortChronologically(examples: TrainingExample[]): TrainingExample[];
    /**
     * Validates a complete dataset for temporal causality, label validity, and feature schema integrity.
     */
    static validateDataset(examples: TrainingExample[]): {
        isValid: boolean;
        errors: string[];
    };
}
/**
 * Result returned by a PredictionModel.
 */
export interface PredictionResult {
    probability: number;
    rawLogit: number;
    featuresUsed: TradeFeatureVector;
    modelVersion: string;
}
export interface TrainingMetrics {
    totalExamples: number;
    epochsTrained: number;
    initialLoss: number;
    finalLoss: number;
    accuracy: number;
    precision: number;
    recall: number;
    f1Score: number;
    logLoss: number;
    brierScore: number;
    rocAuc: number;
    profitFactor: number;
    expectancyR: number;
    maxDrawdownR: number;
}
export interface EvaluationMetrics extends TrainingMetrics {
    sampleSize: number;
}
export interface IModelHyperparameters {
    learningRate: number;
    l2Regularization: number;
    batchSize: number;
    maxEpochs: number;
    convergenceTolerance: number;
    decayRate?: number;
}
export declare const DEFAULT_HYPERPARAMETERS: IModelHyperparameters;
/**
 * Abstraction interface for ML prediction models.
 */
export interface PredictionModel {
    readonly modelVersion: string;
    readonly featureSchemaVersion: string;
    predict(features: TradeFeatureVector): PredictionResult;
    predictProbability(features: TradeFeatureVector): number;
    update(features: TradeFeatureVector, label: TradeOutcomeLabel, outcomeR?: number): number;
    train(dataset: TrainingExample[]): TrainingMetrics;
    evaluate(dataset: TrainingExample[]): EvaluationMetrics;
    getWeights(): number[];
    getBias(): number;
    setWeights(weights: number[], bias: number): void;
}
/**
 * ModelEvaluationEngine
 * Pure quantitative metric evaluator for supervised binary trading models.
 */
export declare class ModelEvaluationEngine {
    /**
     * Computes full quantitative metrics on a dataset given a prediction model.
     */
    static calculateMetrics(examples: TrainingExample[], model: PredictionModel): EvaluationMetrics;
    /**
     * Computes ROC-AUC via rank-sum (Mann-Whitney U algorithm).
     */
    private static calculateRocAuc;
    private static calculateProfitFactor;
    private static calculateMaxDrawdown;
}
/**
 * TradePredictionModel
 * Baseline Supervised Logistic Regression model with online stochastic gradient descent,
 * mini-batch optimization, and L2 regularization.
 */
export declare class TradePredictionModel implements PredictionModel {
    readonly modelVersion: string;
    readonly featureSchemaVersion: string;
    private weights;
    private bias;
    private hyperparameters;
    constructor(modelVersion?: string, hyperparameters?: Partial<IModelHyperparameters>, initialWeights?: number[], initialBias?: number);
    /**
     * Evaluates raw logit: z = w^T * x + b
     */
    calculateLogit(featureArray: number[]): number;
    /**
     * Sigmoid activation: sigma(z) = 1 / (1 + exp(-z))
     */
    sigmoid(z: number): number;
    /**
     * Predicts win probability for a given TradeFeatureVector.
     */
    predictProbability(features: TradeFeatureVector): number;
    /**
     * Returns a complete PredictionResult object.
     */
    predict(features: TradeFeatureVector): PredictionResult;
    /**
     * Online Gradient Descent update from a single completed trade.
     * Performs one stochastic gradient step with L2 regularization.
     * Returns the immediate loss before update.
     */
    update(features: TradeFeatureVector, label: TradeOutcomeLabel): number;
    /**
     * Trains the model on a supervised training dataset using mini-batch gradient descent.
     */
    train(dataset: TrainingExample[]): TrainingMetrics;
    /**
     * Evaluates the model on an independent validation or test dataset.
     */
    evaluate(dataset: TrainingExample[]): EvaluationMetrics;
    getWeights(): number[];
    getBias(): number;
    setWeights(weights: number[], bias: number): void;
    /**
     * Returns feature importance ranked by absolute weight magnitude.
     */
    getFeatureImportance(): {
        feature: FeatureName;
        weight: number;
        absoluteWeight: number;
    }[];
}
/**
 * Configuration for chronological dataset splitting.
 */
export interface IChronologicalSplitConfig {
    trainRatio: number;
    validationRatio: number;
    outOfSampleRatio: number;
    minTrainExamples?: number;
}
export declare const DEFAULT_SPLIT_CONFIG: IChronologicalSplitConfig;
export interface IChronologicalDatasetSplits {
    train: TrainingExample[];
    validation: TrainingExample[];
    outOfSample: TrainingExample[];
    periods: {
        trainStart: Date;
        trainEnd: Date;
        validationStart: Date;
        validationEnd: Date;
        outOfSampleStart: Date;
        outOfSampleEnd: Date;
    };
    counts: {
        train: number;
        validation: number;
        outOfSample: number;
        total: number;
    };
}
/**
 * ChronologicalSplitter
 * Splits time series datasets strictly by chronological ordering without look-ahead or shuffling.
 */
export declare class ChronologicalSplitter {
    static split(dataset: TrainingExample[], config?: Partial<IChronologicalSplitConfig>): IChronologicalDatasetSplits;
}
/**
 * Result of a single walk-forward fold.
 */
export interface IWalkForwardFold {
    foldIndex: number;
    train: TrainingExample[];
    test: TrainingExample[];
    trainPeriod: {
        start: Date;
        end: Date;
    };
    testPeriod: {
        start: Date;
        end: Date;
    };
    trainMetrics: TrainingMetrics;
    testMetrics: EvaluationMetrics;
}
export interface IWalkForwardValidationResult {
    folds: IWalkForwardFold[];
    meanTestLogLoss: number;
    meanTestAccuracy: number;
    meanTestRocAuc: number;
    meanTestBrierScore: number;
    isStable: boolean;
    stabilityScore: number;
}
/**
 * WalkForwardValidator
 * Evaluates model temporal generalization through expanding-window chronological walk-forward cross validation.
 */
export declare class WalkForwardValidator {
    /**
     * Executes an expanding-window walk-forward validation across N temporal folds.
     */
    static runWalkForward(dataset: TrainingExample[], modelFactory: () => PredictionModel, numFolds?: number): IWalkForwardValidationResult;
}
/**
 * Criteria required for a candidate model to be promoted to production.
 */
export interface IModelPromotionCriteria {
    minSampleSize: number;
    maxOutOfSampleLogLoss: number;
    minOutOfSampleRocAuc: number;
    maxDrawdownToleranceR: number;
    mustBeatBaseline: boolean;
}
export declare const DEFAULT_PROMOTION_CRITERIA: IModelPromotionCriteria;
export interface IModelPromotionDecision {
    isPromoted: boolean;
    decisionStatus: 'PROMOTED' | 'REJECTED' | 'INSUFFICIENT_DATA';
    reasons: string[];
    candidateMetrics: EvaluationMetrics;
    baselineMetrics?: EvaluationMetrics | null;
}
/**
 * ModelPromotionEngine
 * Evaluates candidate models against strict production acceptance criteria and baselines.
 */
export declare class ModelPromotionEngine {
    /**
     * Evaluates whether a candidate model qualifies for promotion to production.
     */
    static evaluatePromotion(candidateModel: PredictionModel, outOfSampleDataset: TrainingExample[], baselineModel?: PredictionModel | null, criteria?: Partial<IModelPromotionCriteria>): IModelPromotionDecision;
}
/**
 * Reliability diagram calibration bin.
 */
export interface ICalibrationBin {
    binIndex: number;
    minProbability: number;
    maxProbability: number;
    binRangeLabel: string;
    sampleCount: number;
    meanPredictedProbability: number;
    observedWinRate: number;
    calibrationError: number;
}
export type CalibrationStatus = 'EXCELLENT' | 'GOOD' | 'FAIR' | 'POOR' | 'INSUFFICIENT_DATA' | 'NOT_AVAILABLE' | 'UNKNOWN';
export interface ICalibrationReport {
    bins: ICalibrationBin[];
    expectedCalibrationError: number;
    maximumCalibrationError: number;
    totalSamples: number;
    status: CalibrationStatus;
    brierScore: number;
    description: string;
}
export interface IConfidenceInterval {
    lower: number;
    upper: number;
    confidenceLevel: number;
    sampleSize: number;
}
export interface ICalibratedPrediction {
    rawProbability: number;
    calibratedProbability: number;
    confidenceInterval: IConfidenceInterval | null;
    confidenceStatus: 'CALIBRATED' | 'INSUFFICIENT_DATA';
    calibrationStatus: CalibrationStatus;
    sampleSize: number;
    modelVersion: string;
}
/**
 * ProbabilityCalibrationEngine
 * Pure quantitative calibration engine calculating Expected Calibration Error (ECE),
 * reliability bins, Platt scaling, and statistical Wilson Score confidence intervals.
 */
export declare class ProbabilityCalibrationEngine {
    /**
     * Generates a 10-bin reliability diagram calibration report from predicted probabilities and actual labels.
     */
    static generateCalibrationReport(items: {
        predictedProb: number;
        actualLabel: number;
    }[], numBins?: number): ICalibrationReport;
    /**
     * Calculates a 95% Wilson Score confidence interval for a predicted probability.
     * If sample size is insufficient (< minSampleSize), returns null.
     */
    static calculateConfidenceInterval(probability: number, supportingSampleSize: number, minSampleSize?: number, confidenceLevel?: number): IConfidenceInterval | null;
}
/**
 * PlattScaler
 * Univariate logistic calibration mapping uncalibrated model probabilities to calibrated posteriors.
 */
export declare class PlattScaler {
    private a;
    private b;
    private isFitted;
    /**
     * Fits Platt scaling parameters (A, B) using maximum likelihood on validation set probabilities.
     */
    fit(probabilities: number[], labels: TradeOutcomeLabel[], maxIter?: number, lr?: number): void;
    /**
     * Calibrates a single predicted probability.
     */
    calibrate(rawProb: number): number;
    getParameters(): {
        a: number;
        b: number;
        isFitted: boolean;
    };
}
/**
 * Trade payoff configuration specifying reward and risk parameters.
 */
export interface ITradePayoffStructure {
    targetR: number;
    lossR?: number;
    partialScaleOut?: {
        tp1R: number;
        tp1Ratio: number;
        tp2R: number;
        tp2Ratio: number;
    };
}
export interface IExpectedValueResult {
    winProbability: number;
    lossProbability: number;
    averageWinR: number;
    averageLossR: number;
    expectedValueR: number;
    kellyCriterionFraction: number;
    isPositiveExpectancy: boolean;
}
/**
 * Four-tier AI recommendation enum.
 * Strictly respects risk engine separation of concerns (never outputs position sizes).
 */
export type AIRecommendationStatus = 'HIGH_CONFIDENCE' | 'MODERATE_CONFIDENCE' | 'LOW_CONFIDENCE' | 'WAIT';
export interface IAIRecommendationResult {
    recommendation: AIRecommendationStatus;
    winProbability: number;
    expectedValueR: number;
    averageWinR: number;
    averageLossR: number;
    supportingSampleSize: number;
    calibrationStatus: CalibrationStatus;
    confidenceInterval: IConfidenceInterval | null;
    confidenceStatus: 'CALIBRATED' | 'UNCALIBRATED' | 'INSUFFICIENT_DATA';
    reasons: string[];
    modelVersion: string;
}
export interface IEvaluateRecommendationParams {
    probability: number;
    payoff: ITradePayoffStructure;
    supportingSampleSize: number;
    calibrationStatus?: CalibrationStatus;
    minSampleSize?: number;
    modelVersion?: string;
}
/**
 * ExpectedValueEngine
 * Calculates mathematical expectation, Kelly fraction, and sample-size gated AI recommendations.
 */
export declare class ExpectedValueEngine {
    /**
     * Computes expected value in R-multiples given win probability and trade payoff structure.
     */
    static calculateExpectedValue(winProbability: number, payoff: ITradePayoffStructure): IExpectedValueResult;
    /**
     * Evaluates AI recommendation with strict sample-size gating and calibration checks.
     */
    static evaluateRecommendation(params: IEvaluateRecommendationParams): IAIRecommendationResult;
}
/**
 * Persisted model state encapsulating weights, hyperparameters, validation metrics, and version lineage.
 */
export interface IPersistedModelState {
    id?: string;
    version: string;
    algorithm: string;
    featureSchemaVersion: string;
    status: 'CANDIDATE' | 'ACTIVE' | 'ARCHIVED' | 'REJECTED';
    weights: number[];
    bias: number;
    hyperparameters: IModelHyperparameters;
    metrics: EvaluationMetrics;
    calibrationReport?: ICalibrationReport | null;
    trainingExampleCount: number;
    validationExampleCount: number;
    outOfSampleExampleCount: number;
    trainingPeriod?: {
        start: Date;
        end: Date;
    };
    validationPeriod?: {
        start: Date;
        end: Date;
    };
    outOfSamplePeriod?: {
        start: Date;
        end: Date;
    };
    trainingStartedAt?: Date;
    trainingCompletedAt?: Date;
    createdAt: Date;
    updatedAt: Date;
}
/**
 * ModelPersistenceManager
 * Serializes and deserializes TradePredictionModels with schema validation and integrity checks.
 */
export declare class ModelPersistenceManager {
    /**
     * Serializes an active TradePredictionModel and evaluation metrics into a portable IPersistedModelState.
     */
    static serialize(model: TradePredictionModel, meta: {
        status?: 'CANDIDATE' | 'ACTIVE' | 'ARCHIVED' | 'REJECTED';
        metrics: EvaluationMetrics;
        calibrationReport?: ICalibrationReport | null;
        trainingExampleCount: number;
        validationExampleCount: number;
        outOfSampleExampleCount: number;
        trainingPeriod?: {
            start: Date;
            end: Date;
        };
        validationPeriod?: {
            start: Date;
            end: Date;
        };
        outOfSamplePeriod?: {
            start: Date;
            end: Date;
        };
        hyperparameters?: Partial<IModelHyperparameters>;
    }): IPersistedModelState;
    /**
     * Deserializes a persisted model state back into an operational TradePredictionModel.
     * Throws an error if the feature schema version or weights dimension does not match.
     */
    static deserialize(state: IPersistedModelState): TradePredictionModel;
}
/**
 * In-memory model registry managing model version history, promotions, and active production routing.
 */
export declare class ModelRegistry {
    private versions;
    private assetActiveVersions;
    private activeVersionId;
    /**
     * Registers a new model version in the registry. Never overwrites existing versions without explicit promotion.
     */
    registerVersion(state: IPersistedModelState, asset?: string): void;
    /**
     * Promotes a validated candidate model to production for an asset.
     * Archives previous active version.
     */
    promoteVersion(version: string, asset?: string): void;
    /**
     * Retrieves the active production TradePredictionModel for a given asset (e.g. NIFTY or BTCUSDT).
     */
    getActiveModel(asset?: string): TradePredictionModel | null;
    getActiveVersionState(asset?: string): IPersistedModelState | null;
    getVersion(version: string): IPersistedModelState | null;
    getAllVersions(): IPersistedModelState[];
    clear(): void;
}
/**
 * Deterministic post-mortem failure & success classification taxonomy.
 */
export type PostMortemClassification = 'LIQUIDITY_SWEEP_FAILURE' | 'HTF_COUNTERTREND' | 'SESSION_CLOSE_REVERSAL' | 'VOLATILITY_EXPANSION_STOP' | 'EARLY_ENTRY_BEFORE_CONFIRMATION' | 'NEWS_SPIKE' | 'TARGET_ACHIEVED' | 'STANDARD_STOP_OUT' | 'TRADE_EXPIRED';
export interface ITradePostMortemInput {
    tradeId?: string;
    symbol: string;
    direction: 'BULLISH' | 'BEARISH';
    entryPrice: number;
    stopLoss: number;
    targets: {
        tp1: number;
        tp2: number;
        tp3?: number;
    };
    entryTimestamp: Date;
    subsequentCandles: ICandle[];
    marketRegime?: MarketRegimeType;
    htfTrendAligned?: boolean;
    atrAtEntry?: number;
    entrySignalConfirmed?: boolean;
    hasNewsEventDuringTrade?: boolean;
}
export interface ITradePostMortemReport {
    symbol: string;
    direction: 'BULLISH' | 'BEARISH';
    entryPrice: number;
    stopLoss: number;
    outcome: 'TP1_HIT' | 'TP2_HIT' | 'TP3_HIT' | 'SL_HIT' | 'EXPIRED';
    realizedRMultiple: number;
    mfeR: number;
    maeR: number;
    timeToResolutionMinutes: number;
    exitTimestamp: Date;
    classification: PostMortemClassification;
    classificationRationale: string;
    marketRegime: string;
    keyContributingFactors: {
        factor: string;
        impact: string;
    }[];
}
/**
 * PostMortemAnalyticsEngine
 * Deterministically evaluates trade execution, MFE/MAE excursions, and root-cause failure classifications.
 */
export declare class PostMortemAnalyticsEngine {
    /**
     * Generates a rigorous post-mortem report for a completed or expired trade.
     */
    static analyzeTrade(input: ITradePostMortemInput): ITradePostMortemReport;
    /**
     * Deterministic rule-based classification algorithm.
     */
    private static classifyOutcome;
}
/**
 * Online learning configuration and safety parameters.
 */
export interface IOnlineLearningConfig {
    learningRate?: number;
    l2Regularization?: number;
    maxWeightChangeNorm?: number;
    decayRate?: number;
    maxAllowedLossSpike?: number;
    checkpointWindowSize?: number;
}
export interface IOnlineUpdateResult {
    tradeId?: string;
    symbol: string;
    previousWeights: number[];
    updatedWeights: number[];
    weightDeltaNorm: number;
    learningRateApplied: number;
    predictionProbability: number;
    actualLabel: 0 | 1;
    instantaneousLoss: number;
    isRollbackTriggered: boolean;
    status: 'UPDATED' | 'CLIPPED' | 'ROLLED_BACK' | 'REJECTED_SCHEMA_MISMATCH';
}
interface IWeightCheckpoint {
    weights: number[];
    bias: number;
    timestamp: Date;
    updateCount: number;
    rollingLoss: number;
}
/**
 * OnlineLearningEngine
 * Applies single-step SGD updates upon live trade closure with strict safety bounds,
 * norm clipping, checkpointing, and automatic rollback on loss spikes.
 */
export declare class OnlineLearningEngine {
    private config;
    private checkpoints;
    private updateCount;
    private recentLosses;
    constructor(config?: IOnlineLearningConfig);
    /**
     * Applies an online gradient descent update using the point-in-time features and realized binary outcome.
     */
    updateModel(model: TradePredictionModel, tradeOutcome: {
        tradeId?: string;
        symbol: string;
        features: TradeFeatureVector;
        featureSchemaVersion?: string;
        actualLabel: 0 | 1;
    }): IOnlineUpdateResult;
    getCheckpoints(): IWeightCheckpoint[];
    getUpdateCount(): number;
}
/**
 * Historical prediction and realized outcome sample for drift monitoring.
 */
export interface IDriftEvaluationSample {
    predictionProbability: number;
    actualOutcome: 0 | 1;
    realizedR: number;
    expectedR: number;
    features: TradeFeatureVector;
    timestamp: Date;
}
/**
 * Continuous Model Drift & Performance Health Monitor.
 * Detects feature shift, prediction drift, calibration degradation, and expectancy decay.
 */
export declare class ModelDriftDetector {
    private samples;
    private readonly maxSamples;
    constructor(maxSamples?: number);
    /**
     * Records a completed trade prediction and actual outcome.
     */
    recordSample(sample: IDriftEvaluationSample): void;
    /**
     * Generates a comprehensive drift and health report across the rolling window.
     */
    evaluateDrift(asset?: string, modelVersion?: string, baselineMetrics?: {
        brierScore?: number;
        ece?: number;
        winRate?: number;
    }): {
        modelVersion: string;
        asset: string;
        evaluatedAt: Date;
        sampleCount: number;
        featureDriftDetected: boolean;
        predictionDriftDetected: boolean;
        calibrationDriftDetected: boolean;
        brierScore: number;
        expectedCalibrationError: number;
        maximumCalibrationError: number;
        rollingWinRate: number;
        rollingExpectancyR: number;
        recommendedAction: "CONTINUE_LIVE" | "REDUCE_RISK" | "SWITCH_TO_PAPER" | "DISABLE_MODEL";
        reasons: string[];
    };
    clear(): void;
}
export {};
