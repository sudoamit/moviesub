export declare enum FillModel {
    NEXT_BAR_MARKET = "NEXT_BAR_MARKET",
    LIMIT_TOUCH = "LIMIT_TOUCH",
    LIMIT_WITH_SLIPPAGE = "LIMIT_WITH_SLIPPAGE",
    OHLC_PATH = "OHLC_PATH",
    LOWER_TIMEFRAME = "LOWER_TIMEFRAME"
}
export declare enum SameCandleAmbiguityMode {
    CONSERVATIVE = "CONSERVATIVE",// Assume Stop Loss hits first
    OPTIMISTIC = "OPTIMISTIC",// Assume Take Profit hits first
    OHLC_PATH = "OHLC_PATH",// Infer order from Open->Low/High->Close trajectory
    LOWER_TIMEFRAME = "LOWER_TIMEFRAME"
}
export type OrderType = 'MARKET' | 'LIMIT' | 'STOP' | 'STOP_LIMIT';
export type OrderSide = 'BUY' | 'SELL';
export type OrderStatus = 'PENDING' | 'FILLED' | 'PARTIALLY_FILLED' | 'CANCELLED' | 'REJECTED';
export interface IOrder {
    orderId: string;
    clientOrderId: string;
    tradeId: string;
    symbol: string;
    side: OrderSide;
    orderType: OrderType;
    price?: number;
    stopPrice?: number;
    quantity: number;
    remainingQuantity: number;
    status: OrderStatus;
    createdAt: number;
    submittedAt: number;
    acknowledgedAt?: number;
    filledAt?: number;
    avgFillPrice?: number;
    fees: number;
    slippage: number;
    rejectionReason?: string;
    referencePrice?: number;
    maxRiskDrift?: number;
    signalTimestamp?: number;
    ambiguityMode?: SameCandleAmbiguityMode;
    exitTarget?: 'TP1' | 'TP2' | 'TP3' | 'SL' | 'TRAILING_STOP' | 'ENTRY' | string;
    ocoGroupId?: string;
}
export interface IFill {
    fillId: string;
    orderId: string;
    tradeId: string;
    symbol: string;
    side: OrderSide;
    price: number;
    quantity: number;
    fee: number;
    slippage: number;
    timestamp: number;
    isPartial: boolean;
    exitTarget?: 'TP1' | 'TP2' | 'TP3' | 'SL' | 'TRAILING_STOP' | 'ENTRY' | string;
    orderCreatedAt?: number;
    orderSubmittedAt?: number;
    exitOrderCreatedAt?: number;
    exitOrderSubmittedAt?: number;
    exitTriggerTimestamp?: number;
    exitFillTimestamp?: number;
    segmentIndex?: number;
    segmentType?: string;
}
export interface ISlippageConfig {
    baseSlippageBps: number;
    volatilityMultiplier: number;
    impactMultiplier: number;
    maxSlippageBps: number;
}
export interface IFeeConfig {
    brokerageFlat?: number;
    brokerageRateBps?: number;
    sttRateBps?: number;
    exchangeTurnoverBps?: number;
    gstRate?: number;
    sebiTurnoverBps?: number;
}
export interface ISpreadConfig {
    baseSpreadBps: number;
    illiquidMultiplier: number;
}
export interface ILatencyConfig {
    submissionLatencyMs: number;
    processingLatencyMs: number;
}
