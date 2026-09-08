import { FillModel, IFill, ILatencyConfig, IOrder, OrderSide, OrderType, SameCandleAmbiguityMode } from './types';
import { ICandle } from '@quant/shared';
import { FillModelEngine } from './fill-model';
import { IExecutionEvent } from '@quant/risk-engine';

export class ExecutionSimulator {
  private orders: Map<string, IOrder> = new Map();
  private fills: IFill[] = [];
  private events: IExecutionEvent[] = [];
  private fillModel: FillModel;
  private ambiguityMode: SameCandleAmbiguityMode;
  private latencyConfig: ILatencyConfig;
  private orderCounter = 0;
  private fillCounter = 0;
  private eventCounter = 0;
  private runId: string;

  constructor(
    fillModel: FillModel = FillModel.OHLC_PATH,
    ambiguityMode: SameCandleAmbiguityMode = SameCandleAmbiguityMode.CONSERVATIVE,
    latencyConfig: ILatencyConfig = { submissionLatencyMs: 15, processingLatencyMs: 5 },
    runId = 'bt1',
  ) {
    this.fillModel = fillModel;
    this.ambiguityMode = ambiguityMode;
    this.latencyConfig = latencyConfig;
    this.runId = runId;
  }

  submitOrder(params: {
    clientOrderId?: string;
    tradeId: string;
    symbol: string;
    side: OrderSide;
    orderType: OrderType;
    price?: number;
    stopPrice?: number;
    quantity: number;
    timestamp: number;
    referencePrice?: number;
    maxRiskDrift?: number;
    signalTimestamp?: number;
    ambiguityMode?: SameCandleAmbiguityMode;
    exitTarget?: 'TP1' | 'TP2' | 'TP3' | 'SL' | 'TRAILING_STOP' | 'ENTRY' | string;
    ocoGroupId?: string;
  }): IOrder {
    if (params.signalTimestamp && params.timestamp < params.signalTimestamp) {
      throw new Error(
        `Order creation timestamp (${params.timestamp}) cannot precede signal timestamp (${params.signalTimestamp})`,
      );
    }

    this.orderCounter++;
    const orderId = `${this.runId}_ord_${this.orderCounter}`;
    const clientOrderId = params.clientOrderId || `${this.runId}_cl_${this.orderCounter}`;

    const order: IOrder = {
      orderId,
      clientOrderId,
      tradeId: params.tradeId,
      symbol: params.symbol,
      side: params.side,
      orderType: params.orderType,
      price: params.price,
      stopPrice: params.stopPrice,
      quantity: params.quantity,
      remainingQuantity: params.quantity,
      status: 'PENDING',
      createdAt: params.timestamp,
      submittedAt: params.timestamp + this.latencyConfig.submissionLatencyMs,
      fees: 0,
      slippage: 0,
      referencePrice: params.referencePrice,
      maxRiskDrift: params.maxRiskDrift,
      signalTimestamp: params.signalTimestamp,
      ambiguityMode: params.ambiguityMode || this.ambiguityMode,
      exitTarget: params.exitTarget,
      ocoGroupId: params.ocoGroupId,
    };

    this.orders.set(orderId, order);
    return order;
  }

  processCandle(
    candle: ICandle,
    nextCandle?: ICandle,
    lowerTfCandles?: ICandle[],
  ): { fills: IFill[]; events: IExecutionEvent[] } {
    const newFills: IFill[] = [];
    const newEvents: IExecutionEvent[] = [];

    // Group pending orders by tradeId
    const pendingByTrade = new Map<string, IOrder[]>();
    for (const order of this.orders.values()) {
      if (order.status !== 'PENDING') continue;
      const list = pendingByTrade.get(order.tradeId) || [];
      list.push(order);
      pendingByTrade.set(order.tradeId, list);
    }

    for (const [tradeId, tradeOrders] of pendingByTrade.entries()) {
      if (tradeOrders.length === 1) {
        const order = tradeOrders[0];
        const res = FillModelEngine.evaluateFill(
          order,
          candle,
          nextCandle,
          this.fillModel,
          lowerTfCandles,
        );

        if (res.isFilled && res.fill) {
          this.fillCounter++;
          const fill = res.fill;
          fill.fillId = `${this.runId}_fill_${this.fillCounter}`;

          order.status = 'FILLED';
          order.filledAt = fill.timestamp;
          order.avgFillPrice = fill.price;
          order.fees = fill.fee;
          order.slippage = fill.slippage;
          order.remainingQuantity = 0;

          this.fills.push(fill);
          newFills.push(fill);

          this.eventCounter++;
          const fillEvent: IExecutionEvent = {
            eventId: `${this.runId}_evt_fill_${this.eventCounter}`,
            tradeId: order.tradeId,
            orderId: order.orderId,
            symbol: order.symbol,
            eventType: order.orderType === 'STOP' ? 'STOP_FILLED' : 'ENTRY_FILLED',
            timestamp: fill.timestamp,
            price: fill.price,
            quantity: fill.quantity,
            remainingQuantity: 0,
            fees: fill.fee,
            slippage: fill.slippage,
            reason: `Order ${order.orderId} filled at ${fill.price}`,
          };

          this.events.push(fillEvent);
          newEvents.push(fillEvent);

          if (order.ocoGroupId) {
            this.cancelOcoGroup(order.ocoGroupId, order.orderId);
          }
        }
      } else {
        // Multiple pending orders for trade -> Centralized Ambiguity Conflict Resolution
        const conflictRes = FillModelEngine.resolveSameCandleConflict(
          tradeOrders,
          candle,
          nextCandle,
          this.fillModel,
          this.ambiguityMode,
          lowerTfCandles,
        );

        if (conflictRes.winningFill && conflictRes.winningOrder) {
          const order = conflictRes.winningOrder;
          this.fillCounter++;
          const fill = conflictRes.winningFill;
          fill.fillId = `${this.runId}_fill_${this.fillCounter}`;

          order.status = 'FILLED';
          order.filledAt = fill.timestamp;
          order.avgFillPrice = fill.price;
          order.fees = fill.fee;
          order.slippage = fill.slippage;
          order.remainingQuantity = 0;

          this.fills.push(fill);
          newFills.push(fill);

          this.eventCounter++;
          const fillEvent: IExecutionEvent = {
            eventId: `${this.runId}_evt_fill_${this.eventCounter}`,
            tradeId: order.tradeId,
            orderId: order.orderId,
            symbol: order.symbol,
            eventType: order.orderType === 'STOP' ? 'STOP_FILLED' : 'ENTRY_FILLED',
            timestamp: fill.timestamp,
            price: fill.price,
            quantity: fill.quantity,
            remainingQuantity: 0,
            fees: fill.fee,
            slippage: fill.slippage,
            reason: `Order ${order.orderId} filled at ${fill.price} (${conflictRes.reason})`,
          };

          this.events.push(fillEvent);
          newEvents.push(fillEvent);

          if (order.ocoGroupId) {
            this.cancelOcoGroup(order.ocoGroupId, order.orderId);
          }
        }
      }
    }

    return { fills: newFills, events: newEvents };
  }

  cancelOrder(orderId: string): boolean {
    const order = this.orders.get(orderId);
    if (order && order.status === 'PENDING') {
      order.status = 'CANCELLED';
      return true;
    }
    return false;
  }

  cancelTradeOrders(tradeId: string): number {
    let count = 0;
    for (const order of this.orders.values()) {
      if (order.tradeId === tradeId && order.status === 'PENDING') {
        order.status = 'CANCELLED';
        count++;
      }
    }
    return count;
  }

  cancelOcoGroup(ocoGroupId: string, exceptOrderId?: string): number {
    let count = 0;
    for (const order of this.orders.values()) {
      if (
        order.ocoGroupId === ocoGroupId &&
        order.orderId !== exceptOrderId &&
        order.status === 'PENDING'
      ) {
        order.status = 'CANCELLED';
        count++;
      }
    }
    return count;
  }

  getOrder(orderId: string): IOrder | undefined {
    return this.orders.get(orderId);
  }

  getAllFills(): IFill[] {
    return [...this.fills];
  }

  getAllEvents(): IExecutionEvent[] {
    return [...this.events];
  }
}
