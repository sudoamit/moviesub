import { FillModel, IFill, ILatencyConfig, IOrder, OrderSide, OrderType, SameCandleAmbiguityMode } from './types';
import { ICandle } from '@quant/shared';
import { IExecutionEvent } from '@quant/risk-engine';
export declare class ExecutionSimulator {
    private orders;
    private fills;
    private events;
    private fillModel;
    private ambiguityMode;
    private latencyConfig;
    private orderCounter;
    private fillCounter;
    private eventCounter;
    private runId;
    constructor(fillModel?: FillModel, ambiguityMode?: SameCandleAmbiguityMode, latencyConfig?: ILatencyConfig, runId?: string);
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
    }): IOrder;
    /**
     * Processes execution logic against a single candle/bar (non-recursive primitive).
     */
    processSingleExecutionBar(bar: ICandle, nextCandle?: ICandle): {
        fills: IFill[];
        events: IExecutionEvent[];
    };
    /**
     * Orchestrates candle processing across parent duration or lower-TF sub-bar series
     */
    processCandle(candle: ICandle, nextCandle?: ICandle, lowerTfCandles?: ICandle[], parentDurationMs?: number): {
        fills: IFill[];
        events: IExecutionEvent[];
    };
    cancelOrder(orderId: string): boolean;
    cancelTradeOrders(tradeId: string): number;
    cancelOcoGroup(ocoGroupId: string, exceptOrderId?: string): number;
    getOrder(orderId: string): IOrder | undefined;
    getTradeOrders(tradeId: string): IOrder[];
    getAllFills(): IFill[];
    getAllEvents(): IExecutionEvent[];
}
