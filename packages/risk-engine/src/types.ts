import { Direction, IInstrument, IPositionSizing, ISignalSetup, SignalState } from '@quant/shared';

export interface IRiskConfig {
  defaultRiskPercentage?: number; // e.g. 1.0 (1%)
  maxRiskPercentage?: number;     // e.g. 2.5 (2.5%)
  maxAccountDrawdownPercent?: number; // e.g. 10.0 (10%)
  maxDailyDrawdownPercent?: number;   // e.g. 5.0 (5%)
  maxOpenRiskPercent?: number;        // e.g. 6.0 (6%)
  maxConcurrentPositions?: number;    // e.g. 5
}

export interface IOpenPosition {
  id: string;
  symbol: string;
  assetType: string;
  direction: Direction;
  entryPrice: number;
  stopLoss: number;
  units: number;
  riskAmount: number;
  currentPrice: number;
  unrealizedPnL: number;
  openTimestamp: Date;
}

export interface ITradeStateUpdate {
  signalId?: string;
  symbol: string;
  previousState: SignalState;
  newState: SignalState;
  currentPrice: number;
  pnlRMultiple: number;
  isClosed: boolean;
  notes: string;
}
