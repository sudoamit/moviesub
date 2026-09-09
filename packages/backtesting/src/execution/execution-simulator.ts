import { FillModel, IFill, ILatencyConfig, IOrder, OrderSide, OrderType, SameCandleAmbiguityMode } from './types';
import { ICandle } from '@quant/shared';
import { FillModelEngine } from './fill-model';
import { IExecutionEvent } from '@quant/risk-engine';
import { OHLCPathCursor } from './ohlc-path-cursor';

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

    // P1-5: Prevent duplicate active orders per exit target (TP1, TP2, TP3, SL) for a trade
    if (params.exitTarget && ['TP1', 'TP2', 'TP3', 'SL', 'TRAILING_STOP'].includes(params.exitTarget)) {
      for (const existingOrder of this.orders.values()) {
        if (
          existingOrder.tradeId === params.tradeId &&
          existingOrder.exitTarget === params.exitTarget &&
          existingOrder.status === 'PENDING'
        ) {
          existingOrder.status = 'CANCELLED';
        }
      }
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
    (order as any)._initialQty = params.quantity;

    this.orders.set(orderId, order);
    return order;
  }



  /**
   * Processes execution logic against a single candle/bar (non-recursive primitive).
   */
  processSingleExecutionBar(
    bar: ICandle,
    nextCandle?: ICandle,
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

    const candleTime =
      bar.timestamp instanceof Date ? bar.timestamp.getTime() : new Date(bar.timestamp).getTime();

    for (const [tradeId, tradeOrders] of pendingByTrade.entries()) {
      // P0/P1-1: OHLCPathCursor for progressive segment evaluation
      const cursor = new OHLCPathCursor(bar);

      while (!cursor.isFinished) {
        const seg = cursor.currentSegment;
        if (!seg) break;

        let segHasTrigger = false;
        let currentSegStart = seg.start;
        let currentOrders = Array.from(this.orders.values()).filter(
          (o) => o.tradeId === tradeId && o.status === 'PENDING',
        );

        while (currentOrders.length > 0) {
          const triggered: { order: IOrder; fill: IFill }[] = [];
          for (const order of currentOrders) {
            if (order.status !== 'PENDING') continue;

            let res: { isFilled: boolean; fill?: IFill };
            if (this.fillModel === FillModel.NEXT_BAR_MARKET && order.orderType === 'MARKET') {
              const orderSubTime = order.submittedAt || order.createdAt;
              if (orderSubTime < candleTime) {
                res = FillModelEngine.evaluateFill(
                  order,
                  bar,
                  undefined,
                  FillModel.OHLC_PATH,
                );
              } else {
                res = FillModelEngine.evaluateFill(
                  order,
                  bar,
                  nextCandle,
                  this.fillModel,
                );
              }
            } else {
              res = FillModelEngine.evaluateSegmentFill(
                order,
                currentSegStart,
                seg.end,
                candleTime,
                order.symbol,
                this.fillModel,
              );
            }

            if (res.isFilled && res.fill) {
              triggered.push({ order, fill: res.fill });
            }
          }

          if (triggered.length === 0) break;

          let nextTrigger: { order: IOrder; fill: IFill } | undefined;
          if (triggered.length === 1) {
            nextTrigger = triggered[0];
          } else {
            const segResolved = FillModelEngine.resolveSegmentConflict(
              triggered,
              currentSegStart,
              seg.end,
              this.ambiguityMode,
            );
            if (segResolved.winningOrder && segResolved.winningFill) {
              nextTrigger = { order: segResolved.winningOrder, fill: segResolved.winningFill };
            } else {
              nextTrigger = triggered[0];
            }
          }
          if (!nextTrigger) break;

          const { order, fill } = nextTrigger;
          segHasTrigger = true;

          const trigPrice = order.orderType === 'STOP' ? (order.stopPrice ?? fill.price) : (order.price ?? fill.price);
          currentSegStart = trigPrice;

          this.fillCounter++;
          fill.fillId = `${this.runId}_fill_${this.fillCounter}`;
          fill.orderCreatedAt = order.createdAt;
          fill.orderSubmittedAt = order.submittedAt;
          fill.exitOrderCreatedAt = order.createdAt;
          fill.exitOrderSubmittedAt = order.submittedAt;
          fill.exitTriggerTimestamp = fill.timestamp;
          fill.exitFillTimestamp = fill.timestamp;
          fill.segmentIndex = cursor.segmentIndex;
          fill.segmentType = seg.type;

          order.status = 'FILLED';
          order.filledAt = fill.timestamp;
          order.avgFillPrice = fill.price;
          order.fees = fill.fee;
          order.slippage = fill.slippage;
          order.remainingQuantity = 0;

          this.fills.push(fill);
          newFills.push(fill);

          const eventType =
            order.exitTarget === 'ENTRY'
              ? 'ENTRY_FILLED'
              : order.orderType === 'STOP'
                ? 'STOP_FILLED'
                : 'TP_FILLED';

          this.eventCounter++;
          const fillEvent: IExecutionEvent = {
            eventId: `${this.runId}_evt_fill_${this.eventCounter}`,
            tradeId: order.tradeId,
            orderId: order.orderId,
            symbol: order.symbol,
            eventType: eventType as any,
            timestamp: fill.timestamp,
            price: fill.price,
            quantity: fill.quantity,
            remainingQuantity: 0,
            fees: fill.fee,
            slippage: fill.slippage,
            reason: `Order ${order.orderId} filled at ${fill.price}`,
            exitTarget: fill.exitTarget || order.exitTarget,
            exitOrderId: order.orderId,
            exitClientOrderId: order.clientOrderId,
            triggerPrice: order.stopPrice || order.price,
            executedPrice: fill.price,
            exitOrderCreatedAt: order.createdAt,
            exitOrderSubmittedAt: order.submittedAt,
            exitTriggerTimestamp: fill.timestamp,
            exitFillTimestamp: fill.timestamp,
            segmentIndex: cursor.segmentIndex,
            segmentType: seg.type,
          };

          this.events.push(fillEvent);
          newEvents.push(fillEvent);

          if (order.orderType === 'STOP') {
            // Protective stop triggered -> Full exit, cancel all remaining orders for trade
            this.cancelTradeOrders(order.tradeId);
            break;
          } else {
            // Target limit order triggered -> Update protective stop order quantity to remaining open position size
            const remainingOrders = Array.from(this.orders.values()).filter(
              (o) => o.tradeId === tradeId && o.status === 'PENDING',
            );
            if (remainingOrders.length === 0) break;

            const slOrder = remainingOrders.find((o) => o.orderType === 'STOP');
            if (slOrder) {
              const initialQty = (slOrder as any)._initialQty || slOrder.quantity;
              const totalExitFilledQty = this.fills
                .filter((f) => f.tradeId === tradeId && f.exitTarget !== 'ENTRY')
                .reduce((sum, f) => sum + f.quantity, 0);
              const remainingPosQty = Math.max(0, initialQty - totalExitFilledQty);

              if (remainingPosQty > 0) {
                slOrder.quantity = remainingPosQty;
                slOrder.remainingQuantity = remainingPosQty;

                if (order.exitTarget === 'TP1') {
                  const entryFill = this.fills.find(
                    (f) => f.tradeId === tradeId && f.exitTarget === 'ENTRY',
                  );
                  const bePrice =
                    entryFill?.price ?? (order.referencePrice ?? slOrder.price);
                  if (bePrice !== undefined) {
                    slOrder.stopPrice = bePrice;
                    (slOrder as any).exitTarget = 'TRAILING_STOP';
                  }
                }
              } else {
                this.cancelTradeOrders(tradeId);
                break;
              }
            }
          }

          currentOrders = Array.from(this.orders.values()).filter(
            (o) => o.tradeId === tradeId && o.status === 'PENDING',
          );
        }

        // Advance cursor to next segment along path
        cursor.advance();
      }
    }

    return { fills: newFills, events: newEvents };
  }

  /**
   * Orchestrates candle processing across parent duration or lower-TF sub-bar series
   */
  processCandle(
    candle: ICandle,
    nextCandle?: ICandle,
    lowerTfCandles?: ICandle[],
    parentDurationMs?: number,
  ): { fills: IFill[]; events: IExecutionEvent[] } {
    // P1-E: LOWER_TIMEFRAME sub-bar evaluation mode
    const isLowerTfMode =
      (this.fillModel === FillModel.LOWER_TIMEFRAME ||
        this.ambiguityMode === SameCandleAmbiguityMode.LOWER_TIMEFRAME) &&
      lowerTfCandles !== undefined &&
      lowerTfCandles.length > 0;

    if (isLowerTfMode) {
      const subValidation = FillModelEngine.validateSubBars(candle, lowerTfCandles, parentDurationMs);
      if (!subValidation.isValid) {
        return { fills: [], events: [] };
      }
      const newFills: IFill[] = [];
      const newEvents: IExecutionEvent[] = [];
      for (const m1 of lowerTfCandles!) {
        const subRes = this.processSingleExecutionBar(m1);
        newFills.push(...subRes.fills);
        newEvents.push(...subRes.events);
      }
      return { fills: newFills, events: newEvents };
    }

    return this.processSingleExecutionBar(candle, nextCandle);
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

  cancelAllOrders(): number {
    let count = 0;
    for (const order of this.orders.values()) {
      if (order.status === 'PENDING') {
        order.status = 'CANCELLED';
        count++;
      }
    }
    return count;
  }

  restoreOrder(order: IOrder): void {
    if (!order || !order.orderId) return;
    this.orders.set(order.orderId, { ...order });
    const match = order.orderId.match(/_ord_(\d+)$/);
    if (match) {
      const idx = parseInt(match[1], 10);
      if (!isNaN(idx) && idx > this.orderCounter) {
        this.orderCounter = idx;
      }
    }
  }

  restoreOrders(orders: IOrder[]): void {
    for (const ord of orders) {
      this.restoreOrder(ord);
    }
  }

  getOrder(orderId: string): IOrder | undefined {
    return this.orders.get(orderId);
  }

  getTradeOrders(tradeId: string): IOrder[] {
    return Array.from(this.orders.values()).filter(
      (o) => o.tradeId === tradeId && o.status === 'PENDING',
    );
  }

  restoreFill(fill: IFill): void {
    if (!fill || !fill.fillId) return;
    this.fills.push({ ...fill });
    const match = fill.fillId.match(/_fill_(\d+)$/);
    if (match) {
      const idx = parseInt(match[1], 10);
      if (!isNaN(idx) && idx > this.fillCounter) {
        this.fillCounter = idx;
      }
    }
  }

  restoreFills(fills: IFill[]): void {
    for (const f of fills) {
      this.restoreFill(f);
    }
  }

  restoreEvent(event: IExecutionEvent): void {
    if (!event || !event.eventId) return;
    this.events.push({ ...event });
    const match = event.eventId.match(/_evt_(\d+)$/);
    if (match) {
      const idx = parseInt(match[1], 10);
      if (!isNaN(idx) && idx > this.eventCounter) {
        this.eventCounter = idx;
      }
    }
  }

  restoreEvents(events: IExecutionEvent[]): void {
    for (const ev of events) {
      this.restoreEvent(ev);
    }
  }

  getAllOrders(): IOrder[] {
    return Array.from(this.orders.values());
  }

  getAllFills(): IFill[] {
    return [...this.fills];
  }

  getAllEvents(): IExecutionEvent[] {
    return [...this.events];
  }
}
