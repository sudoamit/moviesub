import {
  Direction,
  IBacktestResult,
  IBacktestTrade,
  ICandle,
  SignalGrade,
  SignalState,
  Timeframe,
} from '@quant/shared';
import { IPartialExitPolicy, PositionLot, IExecutionEvent } from '@quant/risk-engine';
import { FillModel, SameCandleAmbiguityMode } from './execution/types';
export { FillModel, SameCandleAmbiguityMode };

export interface IEquityPoint {
  timestamp: Date;
  equity: number;
  drawdownPercent: number;
}

export interface IEquitySnapshot {
  timestamp: Date;
  cash: number;
  realizedPnL: number;
  unrealizedPnL: number;
  equity: number;
  marginUsed: number;
  availableMargin: number;
  grossExposure: number;
  netExposure: number;
  fees: number;
  slippage: number;
  drawdownPercent: number;
}

export interface IQuantitativeMetrics {
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number;
  profitFactor: number;
  netPnL: number;
  totalReturnPercent: number;
  cagr: number;
  averageR: number;
  medianR: number;
  averageWin: number;
  averageLoss: number;
  payoffRatio: number;
  expectancy: number;
  maxDrawdownPercent: number;
  drawdownDurationBars: number;
  recoveryTimeBars: number;
  sharpeRatio: number;
  sortinoRatio: number;
  calmarRatio: number;
  valueAtRisk95: number;
  cvar95: number;
  exposurePercent: number;
  turnover: number;
  totalFees: number;
  totalSlippage: number;
  maxMAE: number;
  maxMFE: number;
  maxConsecutiveLosses: number;
  finalEquity: number;
}

export interface IBacktestOptions {
  runId?: string;
  symbol: string;
  candles: ICandle[];
  htf1Candles?: ICandle[];
  htf2Candles?: ICandle[];
  executionTimeframe?: Timeframe | string;
  htf1Timeframe?: string;
  htf2Timeframe?: string;
  timeframe?: Timeframe | string;
  initialCapital?: number;
  riskPerTradePercent?: number;
  minScore?: number;
  minGrade?: SignalGrade;
  lotSize?: number;
  slippagePercent?: number;
  commissionPerLot?: number;
  fillModel?: FillModel;
  ambiguityMode?: SameCandleAmbiguityMode;
  partialExitPolicy?: IPartialExitPolicy;
  lowerTfCandles?: ICandle[];
  strategyMode?: 'SMC' | 'SAIYAN_OCC' | 'HYBRID';
  asOfTimestamp?: Date | number;
  warmupBars?: number;
  minimumCandles?: number;

  // Replay & Candidate Evaluation Options
  experiences?: any[];
  stopLossAtrMultiplier?: number;
  sizingMultiplier?: number;
  highVolatilitySizingMultiplier?: number;
  filterRegime?: string;
  regimeMode?: 'INCLUDE' | 'EXCLUDE';
  minProbability?: number;
  conditionRules?: string[];
  enablePartialTp1Trailing?: boolean;
  candidateArtifact?: any;
  modelArtifact?: any;
  scoringWeights?: any;
  strategyConfig?: any;
}

export type AblationVariant =
  | 'SMC_ONLY'
  | 'SMC_PLUS_REGIME'
  | 'SMC_PLUS_VOLATILITY'
  | 'SMC_PLUS_ML'
  | 'SMC_PLUS_QUANT'
  | 'FULL_SYSTEM';

export interface IAblationComparisonRow {
  variant: AblationVariant;
  totalTrades: number;
  winRate: number;
  averageR: number;
  profitFactor: number;
  netPnL: number;
  maxDrawdownPercent: number;
  sharpeRatio: number;
  expectancy: number;
  deltaRFromBaseline?: number;
}

export interface IAblationStudyResult {
  symbol: string;
  timeframe: string;
  candleCount?: number;
  baselineExpectancy?: number;
  variants: IAblationComparisonRow[];
  bestVariant: AblationVariant;
  recommendation: string;
}

export type ComponentAblationVariant =
  | 'FULL_SYSTEM_BASELINE'
  | 'WITHOUT_LIQUIDITY'
  | 'WITHOUT_ORDER_BLOCK'
  | 'WITHOUT_FVG'
  | 'WITHOUT_DISPLACEMENT'
  | 'WITHOUT_REGIME'
  | 'WITHOUT_VOLATILITY'
  | 'WITHOUT_ML'
  | 'WITHOUT_VOLUME';

export interface IComponentAblationResult {
  symbol: string;
  timeframe: string;
  baselineExpectancy: number;
  results: {
    variant: ComponentAblationVariant;
    tradeCount: number;
    winRate: number;
    expectancy: number;
    profitFactor: number;
    maxDrawdownPercent: number;
    deltaRFromBaseline: number;
  }[];
  mostCriticalFeature: string;
  leastEffectiveFeature: string;
}

export interface IRegimePerformanceSummary {
  regime: string;
  totalTrades: number;
  winRate: number;
  averageR: number;
  profitFactor: number;
  netPnL: number;
}

export interface IVolatilityPerformanceSummary {
  bucket: string;
  totalTrades: number;
  winRate: number;
  averageR: number;
  profitFactor: number;
  netPnL: number;
}

export interface IBenchmarkComparison {
  benchmarkSymbol: string;
  benchmarkReturnPercent: number;
  strategyReturnPercent: number;
  excessReturnPercent: number;
  benchmarkSharpe: number;
  strategySharpe: number;
}

export interface IBacktestSimulationResult
  extends
    Omit<
      IBacktestResult,
      | 'sharpeRatio'
      | 'finalEquity'
      | 'winRate'
      | 'profitFactor'
      | 'netPnL'
      | 'expectancy'
      | 'maxDrawdownPercent'
      | 'maxConsecutiveLosses'
      | 'totalTrades'
      | 'winningTrades'
      | 'losingTrades'
      | 'averageR'
    >,
    IQuantitativeMetrics {
  runId?: string;
  symbol: string;
  timeframe: string;
  initialCapital: number;
  finalEquity: number;
  equityCurve: IEquityPoint[];
  equitySnapshots?: IEquitySnapshot[];
  positionLots?: PositionLot[];
  executionEvents?: IExecutionEvent[];
  regimeBreakdown?: IRegimePerformanceSummary[];
  volatilityBreakdown?: IVolatilityPerformanceSummary[];
  benchmarkComparison?: IBenchmarkComparison;
}
