import { Direction, ICandle } from '@quant/shared';
import { IExecutionEvent } from '@quant/risk-engine';

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
  initialQuantity?: number;
  filledQuantity?: number;
  remainingQuantity: number;
  status: OrderStatus;
  createdAt: number;
  submittedAt: number;
  acknowledgedAt?: number;
  /** Timestamp of the first fill event */
  firstFilledAt?: number;
  /** Timestamp of the most recent fill event */
  lastFilledAt?: number;
  /** Timestamp when order reached terminal FILLED status */
  completedAt?: number;
  /** Alias for lastFilledAt / filled timestamp */
  filledAt?: number;
  /** Volume-weighted average fill price across all executions for this order */
  avgFillPrice?: number;
  /** Cumulative total fees paid across all fills for this order */
  fees: number;
  /** Cumulative total slippage incurred across all fills for this order */
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
  multiplier?: number; // Positive multiplier, e.g. 1.0 (NORMAL), 2.0 (DOUBLE), 3.0 (TRIPLE)
  feeConfig?: IFeeConfig;
  slippageConfig?: ISlippageConfig;
  spreadConfig?: ISpreadConfig;
}

export interface ExecutionModelConfig {
  fillModel: FillModel;
  ambiguityMode: SameCandleAmbiguityMode;
  latencyConfig: ILatencyConfig;
  slippageConfig?: ISlippageConfig;
  feeConfig?: IFeeConfig;
  spreadConfig?: ISpreadConfig;
  costStressConfig?: ExecutionCostStressConfig;
  partialFillRatio?: number;
}

export interface IExecutionSimulatorCheckpoint {
  version: number;
  runId: string;
  orderCounter: number;
  fillCounter: number;
  eventCounter: number;
  executionConfig: ExecutionModelConfig;
  orders: IOrder[];
  fills: IFill[];
  events: IExecutionEvent[];
}

export function validateExecutionModelConfig(config: ExecutionModelConfig): void {
  if (!config || typeof config !== 'object') {
    throw new Error('INVALID_EXECUTION_MODEL_CONFIG: Config must be an object');
  }

  // 1. fillModel
  if (!Object.values(FillModel).includes(config.fillModel)) {
    throw new Error(`INVALID_FILL_MODEL: Invalid fill model "${config.fillModel}"`);
  }

  // 2. ambiguityMode
  if (!Object.values(SameCandleAmbiguityMode).includes(config.ambiguityMode)) {
    throw new Error(`INVALID_AMBIGUITY_MODE: Invalid ambiguity mode "${config.ambiguityMode}"`);
  }

  // 3. latencyConfig
  if (!config.latencyConfig || typeof config.latencyConfig !== 'object') {
    throw new Error('INVALID_LATENCY_CONFIG: latencyConfig must be an object');
  }
  if (
    !Number.isFinite(config.latencyConfig.submissionLatencyMs) ||
    config.latencyConfig.submissionLatencyMs < 0 ||
    !Number.isFinite(config.latencyConfig.processingLatencyMs) ||
    config.latencyConfig.processingLatencyMs < 0
  ) {
    throw new Error('INVALID_LATENCY_CONFIG: Latency values must be non-negative finite numbers');
  }

  // 4. slippageConfig (if defined)
  if (config.slippageConfig !== undefined) {
    const s = config.slippageConfig;
    if (!s || typeof s !== 'object') {
      throw new Error('INVALID_SLIPPAGE_CONFIG: slippageConfig must be an object');
    }
    if (
      !Number.isFinite(s.baseSlippageBps) || s.baseSlippageBps < 0 ||
      !Number.isFinite(s.volatilityMultiplier) || s.volatilityMultiplier < 0 ||
      !Number.isFinite(s.impactMultiplier) || s.impactMultiplier < 0 ||
      !Number.isFinite(s.maxSlippageBps) || s.maxSlippageBps < 0 ||
      s.maxSlippageBps < s.baseSlippageBps
    ) {
      throw new Error('INVALID_SLIPPAGE_CONFIG: Slippage parameters must be non-negative finite numbers with maxSlippageBps >= baseSlippageBps');
    }
  }

  // 5. feeConfig (if defined)
  if (config.feeConfig !== undefined) {
    const f = config.feeConfig;
    if (!f || typeof f !== 'object') {
      throw new Error('INVALID_FEE_CONFIG: feeConfig must be an object');
    }
    const feeFields: (keyof IFeeConfig)[] = [
      'brokerageFlat',
      'brokerageRateBps',
      'sttRateBps',
      'exchangeTurnoverBps',
      'gstRate',
      'sebiTurnoverBps',
    ];
    for (const field of feeFields) {
      if (f[field] !== undefined) {
        const val = f[field];
        if (typeof val !== 'number' || !Number.isFinite(val) || val < 0) {
          throw new Error(`INVALID_FEE_CONFIG: ${field} must be a non-negative finite number, got ${val}`);
        }
      }
    }
  }

  // 6. spreadConfig (if defined)
  if (config.spreadConfig !== undefined) {
    const sp = config.spreadConfig;
    if (!sp || typeof sp !== 'object') {
      throw new Error('INVALID_SPREAD_CONFIG: spreadConfig must be an object');
    }
    if (
      !Number.isFinite(sp.baseSpreadBps) || sp.baseSpreadBps < 0 ||
      !Number.isFinite(sp.illiquidMultiplier) || sp.illiquidMultiplier < 0
    ) {
      throw new Error('INVALID_SPREAD_CONFIG: Spread parameters must be non-negative finite numbers');
    }
  }

  // 7. costStressConfig (if defined)
  if (config.costStressConfig !== undefined) {
    const cs = config.costStressConfig;
    if (!cs || typeof cs !== 'object') {
      throw new Error('INVALID_COST_STRESS_CONFIG: costStressConfig must be an object');
    }
    const validModes: CostStressMode[] = ['NORMAL', 'MULTIPLIER', 'ABSOLUTE'];
    if (!validModes.includes(cs.mode)) {
      throw new Error(`INVALID_COST_STRESS_CONFIG: Invalid mode "${cs.mode}"`);
    }
    if (cs.multiplier !== undefined) {
      if (!Number.isFinite(cs.multiplier) || cs.multiplier < 0) {
        throw new Error(`INVALID_COST_STRESS_CONFIG: multiplier must be a non-negative finite number, got ${cs.multiplier}`);
      }
    }
    if (cs.slippageConfig !== undefined) {
      const s = cs.slippageConfig;
      if (
        !Number.isFinite(s.baseSlippageBps) || s.baseSlippageBps < 0 ||
        !Number.isFinite(s.volatilityMultiplier) || s.volatilityMultiplier < 0 ||
        !Number.isFinite(s.impactMultiplier) || s.impactMultiplier < 0 ||
        !Number.isFinite(s.maxSlippageBps) || s.maxSlippageBps < 0
      ) {
        throw new Error('INVALID_COST_STRESS_CONFIG: Nested slippageConfig contains invalid values');
      }
    }
    if (cs.spreadConfig !== undefined) {
      const sp = cs.spreadConfig;
      if (
        !Number.isFinite(sp.baseSpreadBps) || sp.baseSpreadBps < 0 ||
        !Number.isFinite(sp.illiquidMultiplier) || sp.illiquidMultiplier < 0
      ) {
        throw new Error('INVALID_COST_STRESS_CONFIG: Nested spreadConfig contains invalid values');
      }
    }
  }

  // 8. partialFillRatio (if defined)
  if (config.partialFillRatio !== undefined) {
    if (
      !Number.isFinite(config.partialFillRatio) ||
      config.partialFillRatio <= 0 ||
      config.partialFillRatio > 1
    ) {
      throw new Error(
        `INVALID_PARTIAL_FILL_RATIO: partialFillRatio must be a finite number between 0 and 1, got ${config.partialFillRatio}`,
      );
    }
  }
}


