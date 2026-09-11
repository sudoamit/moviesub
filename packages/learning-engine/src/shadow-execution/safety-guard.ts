import {
  DecisionContext,
  ShadowOrder,
  ShadowFill,
  TradingDecision
} from './types';

/**
 * Live Broker/Execution Port Interface
 * Only CHAMPION in LIVE mode can invoke this port.
 */
export interface ILiveExecutionPort {
  readonly isLiveBroker: true;
  submitLiveOrder(decision: TradingDecision): Promise<{ liveOrderId: string; status: string }>;
  cancelLiveOrder(liveOrderId: string): Promise<boolean>;
}

/**
 * Shadow Execution Port Interface
 * Only CHALLENGER (or shadow simulation) can invoke this port.
 * Does NOT place real orders or touch live capital.
 */
export interface IShadowExecutionPort {
  readonly isLiveBroker: false;
  submitShadowOrder(order: ShadowOrder): ShadowFill;
  cancelShadowOrder(shadowOrderId: string): boolean;
}

/**
 * Hard runtime safety guard asserting that a decision is valid for shadow execution.
 * Fails closed if any live execution attempt or inconsistent state is detected.
 */
export function assertShadowExecution(
  context: DecisionContext,
  port?: unknown
): void {
  if (!context || typeof context !== 'object') {
    throw new Error('SAFETY_VIOLATION: Missing decision context in shadow execution');
  }

  if (context.mode !== 'SHADOW') {
    throw new Error(
      `SAFETY_VIOLATION: Mode must be 'SHADOW' for shadow execution, found '${context.mode}'`
    );
  }

  if (context.modelRole !== 'CHALLENGER') {
    throw new Error(
      `SAFETY_VIOLATION: Model role must be 'CHALLENGER' for shadow execution, found '${context.modelRole}'`
    );
  }

  if (port && typeof port === 'object' && 'isLiveBroker' in port && (port as { isLiveBroker: boolean }).isLiveBroker === true) {
    throw new Error('SAFETY_VIOLATION: Attempted to route shadow execution through ILiveExecutionPort');
  }
}

/**
 * Hard runtime safety guard asserting that a decision is valid for live execution.
 * Fails closed if Challenger or shadow mode attempts to invoke live execution.
 */
export function assertLiveExecution(
  context: DecisionContext,
  port?: unknown
): void {
  if (!context || typeof context !== 'object') {
    throw new Error('SAFETY_VIOLATION: Missing decision context in live execution');
  }

  if (context.modelRole === 'CHALLENGER') {
    throw new Error('CRITICAL_SAFETY_VIOLATION: Challenger model attempted to invoke live execution path');
  }

  if (context.mode !== 'LIVE') {
    throw new Error(
      `SAFETY_VIOLATION: Only LIVE mode can invoke live execution, found '${context.mode}'`
    );
  }

  if (context.modelRole !== 'CHAMPION') {
    throw new Error(
      `SAFETY_VIOLATION: Only CHAMPION role can invoke live execution, found '${context.modelRole}'`
    );
  }

  if (port && typeof port === 'object' && 'isLiveBroker' in port && (port as { isLiveBroker: boolean }).isLiveBroker !== true) {
    throw new Error('SAFETY_VIOLATION: Attempted to route live execution through non-live port');
  }
}
