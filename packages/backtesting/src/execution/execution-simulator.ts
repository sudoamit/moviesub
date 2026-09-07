import { FillModel, IFill, ILatencyConfig, IOrder, OrderSide, OrderType } from './types';
import { ICandle } from '@quant/shared';
import { FillModelEngine } from './fill-model';
import { IExecutionEvent } from '@quant/risk-engine';

export class ExecutionSimulator {
  private orders: Map<string, IOrder> = new Map();
  private fills: IFill[] = [];
  private events: IExecutionEvent[] = [];
  private fillModel: FillModel;
  private latencyConfig: ILatencyConfig;

  constructor(
    fillModel: FillModel = FillModel.OHLC_PATH,
    latencyConfig: ILatencyConfig = { submissionLatencyMs: 15, processingLatencyMs: 5 },
  ) {
    this.fillModel = fillModel;
    this.latencyConfig = latencyConfig;
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
  }): IOrder {
    const orderId = `ord_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const clientOrderId = params.clientOrderId || `cl_${orderId}`;

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

    for (const [orderId, order] of this.orders.entries()) {
      if (order.status !== 'PENDING') continue;

      const fillResult = FillModelEngine.evaluateFill(
        order,
        candle,
        nextCandle,
        this.fillModel,
        lowerTfCandles,
      );

      if (fillResult.isFilled && fillResult.fill) {
        const fill = fillResult.fill;
        order.status = 'FILLED';
        order.filledAt = fill.timestamp;
        order.avgFillPrice = fill.price;
        order.fees = fill.fee;
        order.slippage = fill.slippage;
        order.remainingQuantity = 0;

        this.fills.push(fill);
        newFills.push(fill);

        const fillEvent: IExecutionEvent = {
          eventId: `evt_fill_${fill.timestamp}_${orderId}`,
          tradeId: order.tradeId,
          orderId,
          symbol: order.symbol,
          eventType: 'ENTRY_FILLED',
          timestamp: fill.timestamp,
          price: fill.price,
          quantity: fill.quantity,
          remainingQuantity: 0,
          fees: fill.fee,
          slippage: fill.slippage,
          reason: `Order ${orderId} filled at ${fill.price}`,
        };

        this.events.push(fillEvent);
        newEvents.push(fillEvent);
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
