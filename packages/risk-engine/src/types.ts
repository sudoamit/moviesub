import { Direction, IInstrument, IPositionSizing, ISignalSetup, SignalState } from '@quant/shared';

export type ExecutionEventType =
  | 'ENTRY_TRIGGERED'
  | 'ENTRY_FILLED'
  | 'PARTIAL_TP_FILLED'
  | 'STOP_MOVED'
  | 'STOP_FILLED'
  | 'TP1_FILLED'
  | 'TP2_FILLED'
  | 'TP3_FILLED'
  | 'POSITION_CLOSED'
  | 'ORDER_CANCELLED'
  | 'ORDER_REJECTED';

export interface IEntryExecutionSnapshot {
  entryPrice: number;
  referencePrice: number;
  quantity: number;
  fee: number;
  slippage: number;
  signalTimestamp: number;
  executionTimestamp: number;
  orderCreatedAt?: number;
  orderSubmittedAt?: number;
  orderId?: string;
  clientOrderId?: string;
  side: 'BUY' | 'SELL';
  initialStopLoss: number;
  tp1: number;
  tp2: number;
  tp3: number;
}

export interface IExecutionEvent {
  eventId: string;
  tradeId: string;
  orderId?: string;
  symbol: string;
  eventType: ExecutionEventType;
  timestamp: number; // Canonical UTC epoch ms
  price: number;
  quantity: number;
  remainingQuantity: number;
  fees: number;
  slippage: number;
  reason: string;
  exitTarget?: 'TP1' | 'TP2' | 'TP3' | 'SL' | 'TRAILING_STOP' | 'ENTRY' | string;
  exitOrderId?: string;
  exitClientOrderId?: string;
  triggerPrice?: number;
  executedPrice?: number;
  exitOrderCreatedAt?: number;
  exitOrderSubmittedAt?: number;
  exitTriggerTimestamp?: number;
  exitFillTimestamp?: number;
  segmentIndex?: number;
  segmentType?: string;
}

export interface IPartialFillRecord {
  fillId: string;
  targetType: 'ENTRY' | 'TP1' | 'TP2' | 'TP3' | 'STOP_LOSS' | 'TRAILING_STOP' | 'MANUAL';
  timestamp: number;
  price: number;
  quantity: number;
  remainingQuantity: number;
  realizedPnl: number;
  realizedR: number;
  fee: number;
  slippage: number;
  exitOrderId?: string;
  exitClientOrderId?: string;
  triggerPrice?: number;
  executedPrice?: number;
  exitOrderCreatedAt?: number;
  exitOrderSubmittedAt?: number;
  exitTriggerTimestamp?: number;
  exitFillTimestamp?: number;
  segmentIndex?: number;
  segmentType?: string;
}

export interface IPartialExitPolicy {
  tp1Ratio: number; // e.g. 0.30 (30% scale-out)
  tp2Ratio: number; // e.g. 0.30 (30% scale-out)
  tp3Ratio: number; // e.g. 0.40 (40% runner)
  moveStopToBreakevenOnTp1: boolean;
  trailStopOnTp2: boolean;
  trailStopOffsetR?: number;
  autoDeriveTargets?: boolean;
  defaultRMultiples?: { r1: number; r2: number; r3: number };
}

export type PositionStatus = 'PENDING' | 'OPEN' | 'PARTIALLY_CLOSED' | 'CLOSED' | 'CANCELLED';

export interface PositionLot {
  id: string;
  tradeId: string;
  symbol: string;
  direction: Direction;
  initialQuantity: number;
  remainingQuantity: number;
  entryPrice: number;
  entryTime: number; // Canonical UTC epoch ms
  initialStopLoss: number;
  currentStopLoss: number;
  tp1: number;
  tp2: number;
  tp3: number;
  realizedPnl: number;
  unrealizedPnl: number;
  realizedR: number;
  status: PositionStatus;
  openedAt: number;
  closedAt?: number;
  partialFills: IPartialFillRecord[];
  events: IExecutionEvent[];
  mae: number; // Maximum Adverse Excursion (in price distance & percentage)
  mfe: number; // Maximum Favorable Excursion (in price distance & percentage)
  entrySnapshot?: Readonly<IEntryExecutionSnapshot>;
}

export interface IRiskConfig {
  defaultRiskPercentage?: number; // e.g. 1.0 (1%)
  maxRiskPercentage?: number; // e.g. 2.5 (2.5%)
  maxAccountDrawdownPercent?: number; // e.g. 10.0 (10%)
  maxDailyDrawdownPercent?: number; // e.g. 5.0 (5%)
  maxWeeklyDrawdownPercent?: number; // e.g. 8.0 (8%)
  maxOpenRiskPercent?: number; // e.g. 6.0 (6%)
  maxConcurrentPositions?: number; // e.g. 5
  maxSymbolExposurePercent?: number; // e.g. 25.0 (25%)
  maxCorrelatedExposurePercent?: number; // e.g. 15.0 (15%)
  maxConsecutiveLosses?: number; // e.g. 3
  maxLeverage?: number; // e.g. 10
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
  positionLot?: PositionLot;
  events?: IExecutionEvent[];
}
