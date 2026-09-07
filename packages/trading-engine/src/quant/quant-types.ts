import {
  AssetType,
  Direction,
  ICandle,
  ISignalSetup,
  MarketRegimeType,
  SignalGrade,
  Timeframe,
} from '@quant/shared';
import { ISMCAnalysisResult } from '../types';

/**
 * Canonical Feature Schema Version
 * Increment this version whenever features or their ordering change.
 */
export const CANONICAL_FEATURE_SCHEMA_VERSION = '2.0';

/**
 * 28 Canonical V2 Features strictly ordered.
 */
export const CANONICAL_FEATURE_NAMES_V2 = [
  // 1-17 Core SMC & Market Context
  'smcScore',
  'obStrength',
  'fvgSize',
  'mtfAlignment',
  'killZoneSession',
  'smtDivergence',
  'volatilityAtr',
  'riskRewardRatio',
  'trendRegime',
  'liquiditySweep',
  'bosStrength',
  'chochStrength',
  'relativeVolume',
  'distanceToHTFLevel',
  'distanceToLiquidity',
  'marketSession',
  'dayOfWeek',
  // 18-28 Quantitative & Statistical Features
  'return1Bar',
  'return5Bar',
  'return20Bar',
  'returnSkewness',
  'parkinsonVolatility',
  'garmanKlassVolatility',
  'forecastVolatility',
  'volatilityPercentile',
  'distanceToVwap',
  'bollingerPosition',
  'multiHorizonConfluence',
] as const;

export type CanonicalFeatureNameV2 = (typeof CANONICAL_FEATURE_NAMES_V2)[number];
export const CANONICAL_V2_DIMENSION = CANONICAL_FEATURE_NAMES_V2.length;

export type CanonicalTradeFeatureVectorV2 = Record<CanonicalFeatureNameV2, number>;
export interface InstrumentIdentity {
  symbol: string;
  name?: string;
  assetType: AssetType | string;
  exchange: string;
  currency: string;
  lotSize: number;
  tickSize: number;
  contractSize?: number;
  underlyingSymbol?: string;
  strike?: number;
  optionType?: 'CE' | 'PE';
  expiry?: string;
}

/**
 * Market Return Analysis State
 */
export interface ReturnMetrics {
  return1Bar: number;
  return3Bar: number;
  return5Bar: number;
  return10Bar: number;
  return20Bar: number;
  return50Bar: number;
  rollingMeanReturn: number;
  rollingVariance: number;
  returnSkewness: number;
  returnKurtosis: number;
}

/**
 * Volatility Metrics & Forecast
 */
export interface VolatilityState {
  currentAtr: number;
  atrPercentage: number;
  realizedVolatility: number;
  parkinsonVolatility: number;
  garmanKlassVolatility: number;
  forecastVolatility: number;
  forecastVariance: number;
  volatilityPercentile: number; // 0 - 100
  volatilityBucket: 'P20' | 'P40' | 'P60' | 'P80' | 'HIGH';
  modelUsed: 'GARCH' | 'EWMA' | 'REALIZED';
  confidence: number;
}

/**
 * Semantic Market Regime Classification State
 */
export interface RegimeState {
  regime: MarketRegimeType;
  clusterId?: number;
  probability?: number;
  trendStrength: number; // 0 - 100
  volatilityPercentile: number; // 0 - 100
  confidence: number; // 0 - 100
  timestamp: Date;
}

/**
 * Momentum & Structure Metrics
 */
export interface MomentumStructureState {
  rsi14: number;
  macdLine: number;
  macdSignal: number;
  macdHist: number;
  rateOfChange10: number;
  distanceToVwap: number;
  distanceToEma20: number;
  distanceToEma50: number;
  distanceToEma200: number;
  bollingerPosition: number; // 0 (lower) to 1 (upper)
  bollingerBandwidth: number;
  relativeVolume: number;
  volumeZScore: number;
}

/**
 * SMC Quantified Metrics
 */
export interface SMCQuantState {
  bosStrength: number;
  chochStrength: number;
  liquiditySweepDepth: number;
  orderBlockStrength: number;
  fvgSizeAtrRatio: number;
  fvgFillPercentage: number;
  displacementRatio: number;
  premiumDiscountPosition: number; // 0 (extreme discount) to 1 (extreme premium)
  distanceToLiquidityPct: number;
  distanceToHTFOrderBlockPct: number;
}

/**
 * Alternative Data State (VIX, PCR, OI, Funding Rate, Breadth)
 */
export interface AlternativeDataState {
  indiaVix?: number;
  vixPercentile?: number;
  putCallRatio?: number;
  openInterestChangePct?: number;
  marketAdvanceDeclineRatio?: number;
  cryptoFundingRate?: number;
  cryptoOpenInterest?: number;
  btcDominance?: number;
  isStale: boolean;
  timestamp: Date;
}

/**
 * Unified Quantitative State
 */
export interface QuantState {
  returns: ReturnMetrics;
  volatility: VolatilityState;
  momentum: MomentumStructureState;
  smcQuant: SMCQuantState;
  alternativeData?: AlternativeDataState;
  extractedAt: Date;
}

/**
 * Multi-Horizon Horizon State
 */
export interface HorizonState {
  timeframe: string;
  trend: Direction;
  regime: MarketRegimeType;
  volatilityAtr: number;
  momentumScore: number; // 0 - 100
  structureBroken: boolean;
}

/**
 * Multi-Horizon Quant State
 */
export interface MultiHorizonQuantState {
  macro: HorizonState;
  higherTimeframe: HorizonState;
  execution: HorizonState;
  alignment: 'ALIGNED' | 'PARTIALLY_ALIGNED' | 'CONFLICTED';
  confluenceScore: number; // 0 - 100
}

/**
 * Explainable 10-Pillar Quant + SMC Confluence Scorecard
 */
export interface QuantSMCScore {
  structureScore: number; // Max 15
  mtfScore: number; // Max 15
  liquidityScore: number; // Max 10
  obScore: number; // Max 10
  fvgScore: number; // Max 10
  volumeScore: number; // Max 10
  momentumScore: number; // Max 10
  regimeScore: number; // Max 10
  volatilityScore: number; // Max 5
  riskRewardScore: number; // Max 5
  totalScore: number; // Max 100
  grade: SignalGrade;
  rankingRationale: string[];
}

/**
 * Machine-Readable Machine Learning Prediction
 */
export interface MLTradePrediction {
  probabilityWin: number;
  probabilityTP1: number;
  probabilityTP2: number;
  probabilityStopFirst: number;
  expectedR: number;
  confidence: number;
  uncertainty: number;
  calibrated: boolean;
  featureSchemaVersion: string;
}

/**
 * Optional Structured LLM Assessment
 */
export interface LLMTradeAssessment {
  decision: 'APPROVE' | 'REJECT' | 'WAIT';
  confidence: number;
  concerns: string[];
  supportingFactors: string[];
  contradictoryFactors: string[];
  marketContext: string;
  requiresHumanReview: boolean;
  modelVersion: string;
  promptVersion: string;
}

/**
 * Machine-Readable Decision Trace for every trade setup
 */
export interface DecisionTrace {
  timestamp: Date;
  symbol: string;
  timeframe: string;
  smc: {
    bias: Direction;
    bos: string;
    choch: string;
    liquidity: string;
    ob: string;
    fvg: string;
  };
  quant: {
    regime: MarketRegimeType;
    volatility: string;
    forecastVol: number;
    momentum: number;
    relativeVolume: number;
  };
  ml: {
    probability: number;
    expectedR: number;
    confidence: number;
  };
  multiHorizon: {
    alignment: 'ALIGNED' | 'PARTIALLY_ALIGNED' | 'CONFLICTED';
    confluenceScore: number;
  };
  risk: {
    approved: boolean;
    positionSizeMultiplier: number;
    reasons: string[];
  };
  llmAssessment?: LLMTradeAssessment;
  finalDecision: 'BUY' | 'SELL' | 'WAIT' | 'NO_TRADE';
  whyThisTradeRanked: string[];
  invalidationRisks: string[];
}

/**
 * Canonical Point-In-Time Market Snapshot
 * Pure immutable container representing full state as of snapshot.timestamp.
 */
export interface PointInTimeMarketSnapshot {
  instrument: InstrumentIdentity;
  timestamp: Date;
  marketPrice: number;
  candles: {
    timeframe: string;
    lastClosedTimestamp: Date;
    candlesUsed: number;
  }[];
  smc: ISMCAnalysisResult;
  quant: QuantState;
  regime: RegimeState;
  volatility: VolatilityState;
  ml?: MLTradePrediction;
  multiHorizon: MultiHorizonQuantState;
  score: QuantSMCScore;
  trace: DecisionTrace;
}
