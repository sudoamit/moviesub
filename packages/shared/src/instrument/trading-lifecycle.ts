import { Direction } from '../enums';
import { isLongDirection } from './canonical-r-calculator';

export type TradingLifecycleState =
  | 'signal'
  | 'potential'
  | 'ready'
  | 'not_eligible'
  | 'no_trade'
  | 'pending_order'
  | 'filled'
  | 'active'
  | 'closed'
  | 'cancelled'
  | 'rejected';

/**
 * Determines if an instrument is strictly long-only (e.g. true spot instruments).
 * Spot instruments cannot take short positions under exchange rules.
 */
export function isInstrumentLongOnly(params: {
  symbol: string;
  isOptionMode?: boolean;
  instrumentType?: string;
  marginMode?: string;
}): boolean {
  const { symbol, isOptionMode = false, instrumentType, marginMode } = params;
  if (isOptionMode) return false;
  if (marginMode === 'SPOT') return true;
  if (instrumentType === 'SPOT') return true;
  const sym = (symbol || '').toUpperCase();
  if (sym.endsWith('_SPOT')) return true;
  if (sym === 'BTCUSDT' || sym === 'BTCUSDT_SPOT' || sym === 'ETHUSDT' || sym === 'ETHUSDT_SPOT') {
    return true;
  }
  if ((sym === 'NIFTY' || sym === 'BANKNIFTY') && !isOptionMode) {
    return true;
  }
  return false;
}

/**
 * Execution Eligibility Gate
 * Evaluates whether an incoming strategy signal can be legally and structurally executed on the instrument.
 * A trade that cannot legally execute must NEVER enter READY_FOR_EXECUTION.
 */
export function checkExecutionEligibility(params: {
  symbol: string;
  direction?: Direction | string;
  isOptionMode?: boolean;
  instrumentType?: string;
  marginMode?: string;
}): { executionEligible: boolean; canExecute: boolean; reason?: string } {
  const { symbol, direction = 'BULLISH', isOptionMode = false, instrumentType, marginMode } = params;
  const dirStr = String(direction).toUpperCase();

  // Neutral signals cannot execute
  if (dirStr === 'NEUTRAL') {
    return {
      executionEligible: false,
      canExecute: false,
      reason: 'Neutral signals are not eligible for execution.',
    };
  }

  const isLongOnly = isInstrumentLongOnly({ symbol, isOptionMode, instrumentType, marginMode });
  const isBearish = dirStr === 'BEARISH' || dirStr === 'SELL' || dirStr === 'SHORT';

  // Spot short selling is strictly forbidden under exchange safety rules
  if (isLongOnly && isBearish) {
    return {
      executionEligible: false,
      canExecute: false,
      reason: `${symbol} is a long-only spot instrument. Short positions are strictly prohibited.`,
    };
  }

  return {
    executionEligible: true,
    canExecute: true,
  };
}

/**
 * Domain specification for a planned strategy setup before order execution.
 * Retains target geometry internally for pre-flight and execution planning,
 * but must NEVER be presented as live trade performance or actual positions.
 */
export interface PlannedTradeSetup {
  symbol: string;
  contractSymbol?: string;
  direction: Direction | 'BUY' | 'SELL' | 'BULLISH' | 'BEARISH' | string;
  underlyingTriggerPrice: number;
  currentSpotPrice?: number;
  distanceToTrigger?: number;
  isTriggerSatisfied?: boolean;
  executionEligible?: boolean;
  canExecute?: boolean;
  plannedEntryPrice: number;
  plannedStopLoss: number;
  plannedTargets: {
    tp1: number;
    tp2: number;
    tp3: number;
  };
  plannedQuantity: number;
  plannedRiskAmount?: number;
  expiry?: string;
  strike?: number;
  optionType?: 'CE' | 'PE' | string;
  status?: TradingLifecycleState | string;
}

/**
 * Domain specification for an actual executed position.
 * Populated ONLY after order execution confirmation and position creation.
 */
export interface ActualExecutedTrade {
  positionId: string;
  tradeId: string;
  symbol: string;
  contractSymbol?: string;
  direction: Direction | 'BUY' | 'SELL' | 'BULLISH' | 'BEARISH' | string;
  executedEntryPrice: number;
  executedStopLoss: number;
  executedTargets: {
    tp1: number;
    tp2: number;
    tp3: number;
  };
  executedQuantity: number;
  currentPrice?: number;
  filledAt: string;
  status: 'ACTIVE' | 'PARTIALLY_CLOSED' | 'CLOSED' | string;
  currentPnL: number;
  pnlPercent?: number;
  currentR: number;
  positionRisk: number;
  canonicalRR?: number;
  marginUsed?: number;
  isProfitLocked?: boolean;
  isBreakevenActive?: boolean;
}

/**
 * Determines whether live trade performance metrics (P&L, current R, trade performance, live risk)
 * are permitted to be displayed in the UI.
 *
 * Strict Product Rule:
 * SIGNAL ≠ TRADE
 * POTENTIAL SETUP ≠ TRADE
 * READY FOR EXECUTION ≠ TRADE
 * ORDER SUBMITTED ≠ TRADE
 *
 * Only ACTIVE or CLOSED positions may display live/historical trade metrics.
 */
export function shouldDisplayLiveTradeMetrics(state: TradingLifecycleState): boolean {
  return state === 'active' || state === 'closed';
}

/**
 * Resolves the authoritative trading lifecycle state from backend evidence.
 * Does NOT infer active trade merely because a strategy signal exists.
 * A trade that cannot legally execute must NEVER enter 'ready'.
 */
export function resolveTradingLifecycleState(params: {
  hasActivePosition?: boolean;
  hasActiveTrade?: boolean;
  positionStatus?: string | null;
  isPositionClosed?: boolean;
  isPlacingOrder?: boolean;
  executionState?: string | null;
  orderRejectionReason?: string | null;
  hasSignal?: boolean;
  isTriggerSatisfied?: boolean;
  executionEligible?: boolean;
  canExecute?: boolean;
  closedTradeSummary?: any;
}): TradingLifecycleState {
  const {
    hasActivePosition,
    hasActiveTrade,
    positionStatus,
    isPositionClosed,
    isPlacingOrder,
    executionState,
    orderRejectionReason,
    hasSignal,
    isTriggerSatisfied,
    executionEligible,
    canExecute,
    closedTradeSummary,
  } = params;

  const isPosActive = Boolean(hasActivePosition || hasActiveTrade);

  // 1. Authoritative active position is the ONLY source of truth for an active trade
  if (
    isPosActive &&
    (positionStatus === 'OPEN' || positionStatus === 'PARTIALLY_CLOSED' || positionStatus === 'ACTIVE' || !positionStatus)
  ) {
    return 'active';
  }

  // 2. Closed position state
  if (isPositionClosed || positionStatus === 'CLOSED' || Boolean(closedTradeSummary)) {
    return 'closed';
  }

  // 3. Rejected execution / failure
  if (
    orderRejectionReason ||
    executionState === 'FAILED_FINAL' ||
    executionState === 'FAILED_RETRYABLE' ||
    executionState === 'REJECTED'
  ) {
    return 'rejected';
  }

  // 4. Pending order submission (asynchronous order dispatch awaiting broker fill)
  if (
    isPlacingOrder ||
    executionState === 'EXECUTING' ||
    executionState === 'RESERVED' ||
    executionState === 'SUBMITTED' ||
    executionState === 'ORDER_SUBMITTED' ||
    executionState === 'PENDING' ||
    executionState === 'ROUTING_TO_EXCHANGE' ||
    executionState === 'PLACING'
  ) {
    return 'pending_order';
  }

  // 5. Filled order awaiting position entity hydration
  if (executionState === 'EXECUTED' && !isPosActive) {
    return 'filled';
  }

  // 6. Signal exists, not executed
  if (hasSignal) {
    // If trade cannot execute on this instrument (e.g. spot short forbidden), it is strictly NOT ELIGIBLE.
    // It must NEVER enter 'ready' (READY FOR EXECUTION).
    if (executionEligible === false || canExecute === false) {
      return 'not_eligible';
    }
    return isTriggerSatisfied ? 'ready' : 'potential';
  }

  return 'potential';
}

/**
 * Calculates P&L strictly from executed position parameters.
 * For LONG: (currentPrice - executedEntryPrice) * executedQuantity * fxRate
 * For SHORT: (executedEntryPrice - currentPrice) * executedQuantity * fxRate
 */
export function calculateExecutedPositionPnL(params: {
  executedEntryPrice: number;
  currentPrice: number;
  executedQuantity: number;
  direction?: Direction | string;
  isLong?: boolean;
  fxRate?: number;
}): number {
  const { executedEntryPrice, currentPrice, executedQuantity, direction = 'BUY', isLong, fxRate = 1.0 } = params;
  if (!executedQuantity || executedQuantity <= 0 || !executedEntryPrice || executedEntryPrice <= 0) {
    return 0;
  }
  const effectiveIsLong = typeof isLong === 'boolean' ? isLong : isLongDirection(direction);
  const move = effectiveIsLong ? currentPrice - executedEntryPrice : executedEntryPrice - currentPrice;
  return Number((move * executedQuantity * fxRate).toFixed(2));
}

/**
 * Calculates current R multiple achieved strictly from executed position parameters.
 * For LONG: (currentPrice - executedEntryPrice) / (executedEntryPrice - executedStopLoss)
 * For SHORT: (executedEntryPrice - currentPrice) / (executedStopLoss - executedEntryPrice)
 */
export function calculateExecutedPositionR(params: {
  executedEntryPrice: number;
  executedStopLoss: number;
  currentPrice: number;
  direction?: Direction | string;
  isLong?: boolean;
}): number {
  const { executedEntryPrice, executedStopLoss, currentPrice, direction = 'BUY', isLong } = params;
  const effectiveIsLong = typeof isLong === 'boolean' ? isLong : isLongDirection(direction);
  const riskDist = effectiveIsLong ? executedEntryPrice - executedStopLoss : executedStopLoss - executedEntryPrice;
  if (!riskDist || riskDist <= 0 || isNaN(riskDist)) {
    return 0;
  }
  const move = effectiveIsLong ? currentPrice - executedEntryPrice : executedEntryPrice - currentPrice;
  return Number((move / riskDist).toFixed(2));
}
