import { Direction, SignalState } from '@quant/shared';
export type ExecutionEventType = 'ENTRY_TRIGGERED' | 'ENTRY_FILLED' | 'PARTIAL_TP_FILLED' | 'STOP_MOVED' | 'STOP_FILLED' | 'TP1_FILLED' | 'TP2_FILLED' | 'TP3_FILLED' | 'POSITION_CLOSED' | 'ORDER_CANCELLED' | 'ORDER_REJECTED';
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
    timestamp: number;
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
    tp1Ratio: number;
    tp2Ratio: number;
    tp3Ratio: number;
    moveStopToBreakevenOnTp1: boolean;
    trailStopOnTp2: boolean;
    trailStopOffsetR?: number;
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
    entryTime: number;
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
    mae: number;
    mfe: number;
    entrySnapshot?: Readonly<IEntryExecutionSnapshot>;
}
export interface IRiskConfig {
    defaultRiskPercentage?: number;
    maxRiskPercentage?: number;
    maxAccountDrawdownPercent?: number;
    maxDailyDrawdownPercent?: number;
    maxWeeklyDrawdownPercent?: number;
    maxOpenRiskPercent?: number;
    maxConcurrentPositions?: number;
    maxSymbolExposurePercent?: number;
    maxCorrelatedExposurePercent?: number;
    maxConsecutiveLosses?: number;
    maxLeverage?: number;
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
