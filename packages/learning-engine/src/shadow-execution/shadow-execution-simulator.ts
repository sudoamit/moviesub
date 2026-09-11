import { randomUUID } from 'crypto';
import {
  IShadowExecutionPort,
  assertShadowExecution
} from './safety-guard';
import {
  ShadowOrder,
  ShadowFill,
  ShadowPosition,
  ShadowPortfolioState,
  DecisionContext
} from './types';
import { deepFreeze } from '../champion-challenger/evaluation-identity';

export interface ShadowExecutionSimulatorConfig {
  readonly initialCapital: number;
  readonly feeRateBps: number; // e.g. 5 bps = 0.0005
  readonly slippageBps: number; // e.g. 2 bps = 0.0002
  readonly spreadPercent: number; // e.g. 0.0001
}

export type Phase11ShadowExecutionConfig = ShadowExecutionSimulatorConfig;

export const DEFAULT_SHADOW_EXECUTION_CONFIG: ShadowExecutionSimulatorConfig = {
  initialCapital: 100000,
  feeRateBps: 5,
  slippageBps: 2,
  spreadPercent: 0.0001,
};

/**
 * ShadowExecutionSimulator
 *
 * Implements IShadowExecutionPort for purely simulated execution of Challenger decisions.
 * Completely isolates shadow portfolio balance, margin, positions, and drawdown from live state.
 */
export class ShadowExecutionSimulator implements IShadowExecutionPort {
  public readonly isLiveBroker = false as const;
  private readonly config: ShadowExecutionSimulatorConfig;
  private shadowCash: number;
  private shadowPeakEquity: number;
  private readonly openPositionsMap = new Map<string, ShadowPosition>();
  private readonly closedPositions: ShadowPosition[] = [];
  private readonly fills: ShadowFill[] = [];
  private readonly orders = new Map<string, ShadowOrder>();

  constructor(config?: Partial<ShadowExecutionSimulatorConfig>) {
    this.config = { ...DEFAULT_SHADOW_EXECUTION_CONFIG, ...config };
    this.shadowCash = this.config.initialCapital;
    this.shadowPeakEquity = this.config.initialCapital;
  }

  /**
   * Submits a shadow order for simulated execution.
   */
  public submitShadowOrder(order: ShadowOrder, context?: DecisionContext): ShadowFill {
    if (context) {
      assertShadowExecution(context, this);
    }

    if (!order || !order.shadowOrderId || order.quantity <= 0) {
      throw new Error('INVALID_SHADOW_ORDER: Order is null, missing shadowOrderId, or quantity <= 0');
    }

    this.orders.set(order.shadowOrderId, deepFreeze({ ...order, status: 'FILLED' }));

    const feeMultiplier = this.config.feeRateBps / 10000;
    const slippageMultiplier = this.config.slippageBps / 10000;

    // Slippage increases buy price, decreases sell price
    const slippagePriceDelta = order.requestedPrice * slippageMultiplier;
    const fillPrice =
      order.side === 'BUY'
        ? order.requestedPrice + slippagePriceDelta
        : order.requestedPrice - slippagePriceDelta;

    const notional = fillPrice * order.quantity;
    const fee = notional * feeMultiplier;
    const slippage = slippagePriceDelta * order.quantity;

    const fill: ShadowFill = {
      fillId: `sfill_${randomUUID()}`,
      shadowOrderId: order.shadowOrderId,
      fillPrice,
      filledQuantity: order.quantity,
      fillTimestamp: order.createdAt,
      fee,
      slippage,
    };

    const frozenFill = deepFreeze(fill);
    this.fills.push(frozenFill);

    // Open a shadow position
    const position: ShadowPosition = {
      positionId: `spos_${randomUUID()}`,
      shadowOrderId: order.shadowOrderId,
      decisionId: order.decisionId,
      instrument: order.instrument,
      side: order.side,
      quantity: order.quantity,
      entryPrice: fillPrice,
      stopLoss: order.stopLoss,
      takeProfit: order.takeProfit,
      openedAt: order.createdAt,
      status: 'OPEN',
      fees: fee,
      slippage,
    };

    const frozenPosition = deepFreeze(position);
    this.openPositionsMap.set(position.positionId, frozenPosition);

    // Deduct entry fees from shadow cash
    this.shadowCash -= fee;

    return frozenFill;
  }

  /**
   * Closes an existing shadow position with simulated exit price.
   */
  public closeShadowPosition(
    positionId: string,
    exitPrice: number,
    closedAt: number,
    exitReason: 'STOPPED' | 'TARGET_HIT' | 'TIME_EXIT' | 'CLOSED' = 'CLOSED'
  ): ShadowPosition {
    const existing = this.openPositionsMap.get(positionId);
    if (!existing || existing.status !== 'OPEN') {
      throw new Error(`SHADOW_POSITION_NOT_FOUND: Open shadow position '${positionId}' not found`);
    }

    const feeMultiplier = this.config.feeRateBps / 10000;
    const exitNotional = exitPrice * existing.quantity;
    const exitFee = exitNotional * feeMultiplier;

    // Gross PnL
    const priceDelta = existing.side === 'BUY' ? exitPrice - existing.entryPrice : existing.entryPrice - exitPrice;
    const grossPnL = priceDelta * existing.quantity;
    const netPnL = grossPnL - (existing.fees + exitFee);

    this.shadowCash += netPnL;
    const currentEquity = this.getShadowEquity();
    if (currentEquity > this.shadowPeakEquity) {
      this.shadowPeakEquity = currentEquity;
    }

    const closedPosition: ShadowPosition = {
      ...existing,
      status: exitReason,
      closedAt,
      exitPrice,
      realizedPnL: netPnL,
      fees: existing.fees + exitFee,
    };

    const frozenClosed = deepFreeze(closedPosition);
    this.openPositionsMap.delete(positionId);
    this.closedPositions.push(frozenClosed);

    return frozenClosed;
  }

  public cancelShadowOrder(shadowOrderId: string): boolean {
    const existing = this.orders.get(shadowOrderId);
    if (!existing) return false;
    this.orders.set(shadowOrderId, deepFreeze({ ...existing, status: 'CANCELLED' }));
    return true;
  }

  public getShadowCash(): number {
    return this.shadowCash;
  }

  public getShadowEquity(): number {
    let unrealized = 0;
    // Base equity on cash + realized outcomes
    return this.shadowCash + unrealized;
  }

  public getShadowPortfolioState(): ShadowPortfolioState {
    const equity = this.getShadowEquity();
    if (equity > this.shadowPeakEquity) {
      this.shadowPeakEquity = equity;
    }
    const drawdownPercent =
      this.shadowPeakEquity > 0
        ? ((this.shadowPeakEquity - equity) / this.shadowPeakEquity) * 100
        : 0;

    return deepFreeze({
      portfolioId: 'shadow-portfolio-isolated',
      shadowCash: this.shadowCash,
      shadowEquity: equity,
      shadowPeakEquity: this.shadowPeakEquity,
      shadowDrawdownPercent: Math.max(0, drawdownPercent),
      openPositions: Array.from(this.openPositionsMap.values()),
      lastUpdatedAt: Date.now(),
    });
  }

  public getClosedPositions(): ShadowPosition[] {
    return [...this.closedPositions];
  }

  public getFills(): ShadowFill[] {
    return [...this.fills];
  }
}
