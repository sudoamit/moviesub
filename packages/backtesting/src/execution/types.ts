import { Direction, ICandle } from '@quant/shared';

export enum FillModel {
  NEXT_BAR_MARKET = 'NEXT_BAR_MARKET',
  LIMIT_TOUCH = 'LIMIT_TOUCH',
  LIMIT_WITH_SLIPPAGE = 'LIMIT_WITH_SLIPPAGE',
  OHLC_PATH = 'OHLC_PATH',
  LOWER_TIMEFRAME = 'LOWER_TIMEFRAME',
}

export enum SameCandleAmbiguityMode {
  CONSERVATIVE = 'CONSERVATIVE', // Assume Stop Loss hits first
  OPTIMISTIC = 'OPTIMISTIC', // Assume Take Profit hits first
  OHLC_PATH = 'OHLC_PATH', // Infer order from Open->Low/High->Close trajectory
  LOWER_TIMEFRAME = 'LOWER_TIMEFRAME', // Use sub-minute or 1m resolution data
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
  baseSlippageBps: number; // Base slippage in basis points (e.g. 2 bps = 0.02%)
  volatilityMultiplier: number;
  impactMultiplier: number;
  maxSlippageBps: number;
}

export interface IFeeConfig {
  brokerageFlat?: number; // Flat fee per order (e.g. INR 20 for NSE)
  brokerageRateBps?: number; // Brokerage in bps (e.g. 3 bps = 0.03%)
  sttRateBps?: number; // Securities Transaction Tax (e.g. 1.25 bps on sell intraday or 10 bps delivery)
  exchangeTurnoverBps?: number;
  gstRate?: number; // e.g. 0.18 (18% on brokerage + turnover)
  sebiTurnoverBps?: number;
}

export interface ISpreadConfig {
  baseSpreadBps: number; // Bid-ask spread in bps
  illiquidMultiplier: number;
}

export interface ILatencyConfig {
  submissionLatencyMs: number; // Time from trigger to exchange receipt (e.g. 15ms)
  processingLatencyMs: number;
}

export type CostStressMode = 'NORMAL' | 'MULTIPLIER' | 'ABSOLUTE';

export interface ExecutionCostStressConfig {
  mode: CostStressMode;
  multiplier?: number; // e.g. 1.0 (NORMAL), 2.0 (DOUBLE), 3.0 (TRIPLE)
  feeConfig?: IFeeConfig;
  slippageConfig?: ISlippageConfig;
  spreadConfig?: ISpreadConfig;
}
