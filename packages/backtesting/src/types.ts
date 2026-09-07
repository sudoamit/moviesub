import {
  Direction,
  IBacktestResult,
  IBacktestTrade,
  ICandle,
  SignalGrade,
  SignalState,
  Timeframe,
} from '@quant/shared';

export interface IBacktestOptions {
  symbol: string;
  candles: ICandle[];
  timeframe?: Timeframe | string;
  initialCapital?: number;
  riskPerTradePercent?: number;
  minScore?: number;
  minGrade?: SignalGrade;
  lotSize?: number;
  slippagePercent?: number;
  commissionPerLot?: number;
}

export interface IEquityPoint {
  timestamp: Date;
  equity: number;
  drawdownPercent: number;
}

export type AblationVariant =
  | 'SMC_ONLY'
  | 'SMC_PLUS_REGIME'
  | 'SMC_PLUS_VOLATILITY'
  | 'SMC_PLUS_ML'
  | 'SMC_PLUS_QUANT'
  | 'FULL_SYSTEM';

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

export interface IBacktestSimulationResult extends IBacktestResult {
  symbol: string;
  timeframe: string;
  initialCapital: number;
  finalEquity: number;
  equityCurve: IEquityPoint[];
  regimeBreakdown?: IRegimePerformanceSummary[];
  volatilityBreakdown?: IVolatilityPerformanceSummary[];
  benchmarkComparison?: IBenchmarkComparison;
}

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
}

export interface IAblationStudyResult {
  symbol: string;
  timeframe: string;
  candleCount: number;
  variants: IAblationComparisonRow[];
  bestVariant: AblationVariant;
  recommendation: string;
}
