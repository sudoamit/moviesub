import { Direction, IBacktestResult, IBacktestTrade, ICandle, SignalGrade, SignalState, Timeframe } from '@quant/shared';

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

export interface IBacktestSimulationResult extends IBacktestResult {
  symbol: string;
  timeframe: string;
  initialCapital: number;
  finalEquity: number;
  equityCurve: IEquityPoint[];
}
