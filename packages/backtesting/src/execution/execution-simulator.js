"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ExecutionSimulator = void 0;
const types_1 = require("./types");
const fill_model_1 = require("./fill-model");
const ohlc_path_cursor_1 = require("./ohlc-path-cursor");
class ExecutionSimulator {
    orders = new Map();
    fills = [];
    events = [];
    fillModel;
    ambiguityMode;
    latencyConfig;
    orderCounter = 0;
    fillCounter = 0;
    eventCounter = 0;
    runId;
    constructor(fillModel = types_1.FillModel.OHLC_PATH, ambiguityMode = types_1.SameCandleAmbiguityMode.CONSERVATIVE, latencyConfig = { submissionLatencyMs: 15, processingLatencyMs: 5 }, runId = 'bt1') {
        this.fillModel = fillModel;
        this.ambiguityMode = ambiguityMode;
        this.latencyConfig = latencyConfig;
        this.runId = runId;
    }
    submitOrder(params) {
        if (params.signalTimestamp && params.timestamp < params.signalTimestamp) {
            throw new Error(`Order creation timestamp (${params.timestamp}) cannot precede signal timestamp (${params.signalTimestamp})`);
        }
        // P1-5: Prevent duplicate active orders per exit target (TP1, TP2, TP3, SL) for a trade
        if (params.exitTarget && ['TP1', 'TP2', 'TP3', 'SL', 'TRAILING_STOP'].includes(params.exitTarget)) {
            for (const existingOrder of this.orders.values()) {
                if (existingOrder.tradeId === params.tradeId &&
                    existingOrder.exitTarget === params.exitTarget &&
                    existingOrder.status === 'PENDING') {
                    existingOrder.status = 'CANCELLED';
                }
            }
        }
        this.orderCounter++;
        const orderId = `${this.runId}_ord_${this.orderCounter}`;
        const clientOrderId = params.clientOrderId || `${this.runId}_cl_${this.orderCounter}`;
        const order = {
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
        order._initialQty = params.quantity;
        this.orders.set(orderId, order);
        return order;
    }
    /**
     * Processes execution logic against a single candle/bar (non-recursive primitive).
     */
    processSingleExecutionBar(bar, nextCandle) {
        const newFills = [];
        const newEvents = [];
        // Group pending orders by tradeId
        const pendingByTrade = new Map();
        for (const order of this.orders.values()) {
            if (order.status !== 'PENDING')
                continue;
            const list = pendingByTrade.get(order.tradeId) || [];
            list.push(order);
            pendingByTrade.set(order.tradeId, list);
        }
        const candleTime = bar.timestamp instanceof Date ? bar.timestamp.getTime() : new Date(bar.timestamp).getTime();
        for (const [tradeId, tradeOrders] of pendingByTrade.entries()) {
            // P0/P1-1: OHLCPathCursor for progressive segment evaluation
            const cursor = new ohlc_path_cursor_1.OHLCPathCursor(bar);
            while (!cursor.isFinished) {
                const seg = cursor.currentSegment;
                if (!seg)
                    break;
                let segHasTrigger = false;
                let currentOrders = Array.from(this.orders.values()).filter((o) => o.tradeId === tradeId && o.status === 'PENDING');
                while (currentOrders.length > 0) {
                    const triggered = [];
                    for (const order of currentOrders) {
                        if (order.status !== 'PENDING')
                            continue;
                        let res;
                        if (this.fillModel === types_1.FillModel.NEXT_BAR_MARKET && order.orderType === 'MARKET') {
                            res = fill_model_1.FillModelEngine.evaluateFill(order, bar, nextCandle, this.fillModel);
                        }
                        else {
                            res = fill_model_1.FillModelEngine.evaluateSegmentFill(order, seg.start, seg.end, candleTime, order.symbol, this.fillModel);
                        }
                        if (res.isFilled && res.fill) {
                            triggered.push({ order, fill: res.fill });
                        }
                    }
                    if (triggered.length === 0)
                        break;
                    let nextTrigger;
                    if (triggered.length === 1) {
                        nextTrigger = triggered[0];
                    }
                    else {
                        const segResolved = fill_model_1.FillModelEngine.resolveSegmentConflict(triggered, seg.start, seg.end, this.ambiguityMode);
                        if (segResolved.winningOrder && segResolved.winningFill) {
                            nextTrigger = { order: segResolved.winningOrder, fill: segResolved.winningFill };
                        }
                        else {
                            nextTrigger = triggered[0];
                        }
                    }
                    if (!nextTrigger)
                        break;
                    const { order, fill } = nextTrigger;
                    segHasTrigger = true;
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
                    const eventType = order.exitTarget === 'ENTRY'
                        ? 'ENTRY_FILLED'
                        : order.orderType === 'STOP'
                            ? 'STOP_FILLED'
                            : 'TP_FILLED';
                    this.eventCounter++;
                    const fillEvent = {
                        eventId: `${this.runId}_evt_fill_${this.eventCounter}`,
                        tradeId: order.tradeId,
                        orderId: order.orderId,
                        symbol: order.symbol,
                        eventType: eventType,
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
                    }
                    else {
                        // Target limit order triggered -> Update protective stop order quantity to remaining open position size
                        const remainingOrders = Array.from(this.orders.values()).filter((o) => o.tradeId === tradeId && o.status === 'PENDING');
                        if (remainingOrders.length === 0)
                            break;
                        const slOrder = remainingOrders.find((o) => o.orderType === 'STOP');
                        if (slOrder) {
                            const initialQty = slOrder._initialQty || slOrder.quantity;
                            const totalExitFilledQty = this.fills
                                .filter((f) => f.tradeId === tradeId && f.exitTarget !== 'ENTRY')
                                .reduce((sum, f) => sum + f.quantity, 0);
                            const remainingPosQty = Math.max(0, initialQty - totalExitFilledQty);
                            if (remainingPosQty > 0) {
                                slOrder.quantity = remainingPosQty;
                                slOrder.remainingQuantity = remainingPosQty;
                            }
                            else {
                                this.cancelTradeOrders(tradeId);
                                break;
                            }
                        }
                    }
                    currentOrders = Array.from(this.orders.values()).filter((o) => o.tradeId === tradeId && o.status === 'PENDING');
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
    processCandle(candle, nextCandle, lowerTfCandles, parentDurationMs) {
        // P1-E: LOWER_TIMEFRAME sub-bar evaluation mode
        const isLowerTfMode = (this.fillModel === types_1.FillModel.LOWER_TIMEFRAME ||
            this.ambiguityMode === types_1.SameCandleAmbiguityMode.LOWER_TIMEFRAME) &&
            lowerTfCandles !== undefined &&
            lowerTfCandles.length > 0;
        if (isLowerTfMode) {
            const subValidation = fill_model_1.FillModelEngine.validateSubBars(candle, lowerTfCandles, parentDurationMs);
            if (!subValidation.isValid) {
                return { fills: [], events: [] };
            }
            const newFills = [];
            const newEvents = [];
            for (const m1 of lowerTfCandles) {
                const subRes = this.processSingleExecutionBar(m1);
                newFills.push(...subRes.fills);
                newEvents.push(...subRes.events);
            }
            return { fills: newFills, events: newEvents };
        }
        return this.processSingleExecutionBar(candle, nextCandle);
    }
    cancelOrder(orderId) {
        const order = this.orders.get(orderId);
        if (order && order.status === 'PENDING') {
            order.status = 'CANCELLED';
            return true;
        }
        return false;
    }
    cancelTradeOrders(tradeId) {
        let count = 0;
        for (const order of this.orders.values()) {
            if (order.tradeId === tradeId && order.status === 'PENDING') {
                order.status = 'CANCELLED';
                count++;
            }
        }
        return count;
    }
    cancelOcoGroup(ocoGroupId, exceptOrderId) {
        let count = 0;
        for (const order of this.orders.values()) {
            if (order.ocoGroupId === ocoGroupId &&
                order.orderId !== exceptOrderId &&
                order.status === 'PENDING') {
                order.status = 'CANCELLED';
                count++;
            }
        }
        return count;
    }
    getOrder(orderId) {
        return this.orders.get(orderId);
    }
    getTradeOrders(tradeId) {
        return Array.from(this.orders.values()).filter((o) => o.tradeId === tradeId && o.status === 'PENDING');
    }
    getAllFills() {
        return [...this.fills];
    }
    getAllEvents() {
        return [...this.events];
    }
}
exports.ExecutionSimulator = ExecutionSimulator;
//# sourceMappingURL=execution-simulator.js.map