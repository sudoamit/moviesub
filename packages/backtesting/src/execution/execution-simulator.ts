import {
  FillModel,
  IFill,
  ILatencyConfig,
  IOrder,
  OrderSide,
  OrderType,
  SameCandleAmbiguityMode,
  IFeeConfig,
  ISlippageConfig,
  ISpreadConfig,
  ExecutionCostStressConfig,
  ExecutionModelConfig,
  IExecutionSimulatorCheckpoint,
  validateExecutionModelConfig,
  EXECUTION_PRECISION,
  ISubmitOrderParams,
} from './types';
import { ICandle, isLongPosition } from '@quant/shared';
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
  private slippageConfig?: ISlippageConfig;
  private feeConfig?: IFeeConfig;
  private spreadConfig?: ISpreadConfig;
  private costStressConfig?: ExecutionCostStressConfig;
  private partialFillRatio?: number;
  private orderCounter = 0;
  private fillCounter = 0;
  private eventCounter = 0;
  private runId: string;

  constructor(
    fillModel: FillModel = FillModel.OHLC_PATH,
    ambiguityMode: SameCandleAmbiguityMode = SameCandleAmbiguityMode.CONSERVATIVE,
    latencyConfig: ILatencyConfig = { submissionLatencyMs: 15, processingLatencyMs: 5 },
    runId = 'bt1',
    slippageConfig?: ISlippageConfig,
    feeConfig?: IFeeConfig,
    spreadConfig?: ISpreadConfig,
    costStressConfig?: ExecutionCostStressConfig,
    partialFillRatio?: number,
  ) {
    this.fillModel = fillModel;
    this.ambiguityMode = ambiguityMode;
    this.latencyConfig = latencyConfig;
    this.runId = runId;
    this.slippageConfig = slippageConfig;
    this.feeConfig = feeConfig;
    this.spreadConfig = spreadConfig;
    this.costStressConfig = costStressConfig;
    this.partialFillRatio = partialFillRatio;

    validateExecutionModelConfig(this.getExecutionModelConfig());
  }

  setPartialFillRatio(ratio?: number): void {
    if (ratio === undefined) {
      this.clearPartialFillRatio();
      return;
    }
    this.updateExecutionModel({ partialFillRatio: ratio });
  }

  clearPartialFillRatio(): void {
    const current = this.getExecutionModelConfig();
    const candidate: ExecutionModelConfig = {
      ...current,
      partialFillRatio: undefined,
    };
    validateExecutionModelConfig(candidate);
    this.partialFillRatio = undefined;
  }

  getPartialFillRatio(): number | undefined {
    return this.partialFillRatio;
  }

  getExecutionModelConfig(): ExecutionModelConfig {
    return {
      fillModel: this.fillModel,
      ambiguityMode: this.ambiguityMode,
      latencyConfig: { ...this.latencyConfig },
      slippageConfig: this.slippageConfig ? { ...this.slippageConfig } : undefined,
      feeConfig: this.feeConfig ? { ...this.feeConfig } : undefined,
      spreadConfig: this.spreadConfig ? { ...this.spreadConfig } : undefined,
      costStressConfig: this.costStressConfig
        ? {
            ...this.costStressConfig,
            feeConfig: this.costStressConfig.feeConfig ? { ...this.costStressConfig.feeConfig } : undefined,
            slippageConfig: this.costStressConfig.slippageConfig ? { ...this.costStressConfig.slippageConfig } : undefined,
            spreadConfig: this.costStressConfig.spreadConfig ? { ...this.costStressConfig.spreadConfig } : undefined,
          }
        : undefined,
      partialFillRatio: this.partialFillRatio,
    };
  }

  updateExecutionModel(patch: Partial<ExecutionModelConfig>): void {
    if (!patch || typeof patch !== 'object') {
      throw new Error('INVALID_EXECUTION_MODEL_CONFIG: Config must be an object');
    }

    // 1. Get current complete execution configuration
    const current = this.getExecutionModelConfig();

    // 2. Build candidate configuration
    const candidate: ExecutionModelConfig = {
      fillModel: patch.fillModel !== undefined ? patch.fillModel : current.fillModel,
      ambiguityMode: patch.ambiguityMode !== undefined ? patch.ambiguityMode : current.ambiguityMode,
      latencyConfig: patch.latencyConfig !== undefined ? { ...patch.latencyConfig } : { ...current.latencyConfig },
      slippageConfig: patch.slippageConfig !== undefined
        ? (patch.slippageConfig ? { ...patch.slippageConfig } : undefined)
        : (current.slippageConfig ? { ...current.slippageConfig } : undefined),
      feeConfig: patch.feeConfig !== undefined
        ? (patch.feeConfig ? { ...patch.feeConfig } : undefined)
        : (current.feeConfig ? { ...current.feeConfig } : undefined),
      spreadConfig: patch.spreadConfig !== undefined
        ? (patch.spreadConfig ? { ...patch.spreadConfig } : undefined)
        : (current.spreadConfig ? { ...current.spreadConfig } : undefined),
      costStressConfig: patch.costStressConfig !== undefined
        ? (patch.costStressConfig ? { ...patch.costStressConfig } : undefined)
        : (current.costStressConfig ? { ...current.costStressConfig } : undefined),
      partialFillRatio: 'partialFillRatio' in patch ? patch.partialFillRatio : current.partialFillRatio,
    };

    // 3. Validate COMPLETE candidate configuration
    validateExecutionModelConfig(candidate);

    // 4. Commit candidate configuration atomically
    this.fillModel = candidate.fillModel;
    this.ambiguityMode = candidate.ambiguityMode;
    this.latencyConfig = candidate.latencyConfig;
    this.slippageConfig = candidate.slippageConfig;
    this.feeConfig = candidate.feeConfig;
    this.spreadConfig = candidate.spreadConfig;
    this.costStressConfig = candidate.costStressConfig;
    this.partialFillRatio = candidate.partialFillRatio;
  }

  submitOrder(params: ISubmitOrderParams): IOrder {
    // 1. Quantity & timestamp validation
    if (typeof params.quantity !== 'number' || !Number.isFinite(params.quantity) || params.quantity <= 0) {
      throw new Error('INVALID_ORDER_QUANTITY: Quantity must be a positive finite number');
    }
    if (typeof params.timestamp !== 'number' || !Number.isFinite(params.timestamp) || params.timestamp <= 0) {
      throw new Error('INVALID_ORDER_TIMESTAMP: Timestamp must be a positive finite number');
    }

    // 2. Price / stopPrice / stopLoss validation
    if (params.price !== undefined && (typeof params.price !== 'number' || !Number.isFinite(params.price) || params.price <= 0)) {
      throw new Error('INVALID_ORDER_PRICE: Price must be a positive finite number');
    }
    if (params.stopPrice !== undefined && (typeof params.stopPrice !== 'number' || !Number.isFinite(params.stopPrice) || params.stopPrice <= 0)) {
      throw new Error('INVALID_ORDER_STOP_PRICE: Stop price must be a positive finite number');
    }
    if (params.stopLoss !== undefined && (typeof params.stopLoss !== 'number' || !Number.isFinite(params.stopLoss) || params.stopLoss <= 0)) {
      throw new Error('INVALID_ORDER_STOP_LOSS: Stop loss must be a positive finite number');
    }
    if (params.referencePrice !== undefined && (typeof params.referencePrice !== 'number' || !Number.isFinite(params.referencePrice) || params.referencePrice <= 0)) {
      throw new Error('INVALID_ORDER_REFERENCE_PRICE: Reference price must be a positive finite number');
    }

    if (params.orderType === 'LIMIT' && (params.price === undefined || params.price <= 0)) {
      throw new Error('INVALID_ORDER_PRICE: Limit orders require a positive price');
    }
    if (params.orderType === 'STOP' && (params.stopPrice === undefined || params.stopPrice <= 0)) {
      throw new Error('INVALID_ORDER_STOP_PRICE: Stop orders require a positive stopPrice');
    }
    if (params.orderType === 'STOP_LIMIT') {
      if (params.price === undefined || params.price <= 0) {
        throw new Error('INVALID_ORDER_PRICE: Stop-limit orders require a positive price');
      }
      if (params.stopPrice === undefined || params.stopPrice <= 0) {
        throw new Error('INVALID_ORDER_STOP_PRICE: Stop-limit orders require a positive stopPrice');
      }
    }

    // 3. Inverted TP/SL relative to reference price
    if (params.referencePrice !== undefined && Number.isFinite(params.referencePrice) && params.referencePrice > 0) {
      const ref = params.referencePrice;
      if (params.side === 'SELL') {
        if (params.exitTarget === 'SL' && params.stopPrice !== undefined && params.stopPrice >= ref) {
          throw new Error('INVALID_TP_SL_CONFIGURATION: Stop loss price for LONG position must be below entry reference price');
        }
        if (params.exitTarget?.startsWith('TP') && params.price !== undefined && params.price <= ref) {
          throw new Error('INVALID_TP_SL_CONFIGURATION: Take profit price for LONG position must be above entry reference price');
        }
      } else if (params.side === 'BUY') {
        if (params.exitTarget === 'SL' && params.stopPrice !== undefined && params.stopPrice <= ref) {
          throw new Error('INVALID_TP_SL_CONFIGURATION: Stop loss price for SHORT position must be above entry reference price');
        }
        if (params.exitTarget?.startsWith('TP') && params.price !== undefined && params.price >= ref) {
          throw new Error('INVALID_TP_SL_CONFIGURATION: Take profit price for SHORT position must be below entry reference price');
        }
      }
    }

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
          (existingOrder.status === 'PENDING' || existingOrder.status === 'PARTIALLY_FILLED')
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
      positionSide: params.positionSide,
      price: params.price,
      stopPrice: params.stopPrice,
      stopLoss: params.stopLoss,
      quantity: params.quantity,
      initialQuantity: params.quantity,
      filledQuantity: 0,
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

  /**
   * Calculates the authoritative arrival timestamp when an order completes both
   * submission and exchange processing latencies and is actively participating in matching.
   */
  getEffectiveArrivalTime(order: IOrder, latencyConfig: ILatencyConfig = this.latencyConfig): number {
    const baseSubmitted = order.submittedAt ?? (order.createdAt + latencyConfig.submissionLatencyMs);
    return baseSubmitted + (latencyConfig.processingLatencyMs || 0);
  }

  /**
   * Evaluates if an order arrived strictly before the bar opening timestamp.
   *
   * Temporal Non-Lookahead Invariant:
   *   effectiveArrivalTime < candleTime  => Eligible for execution on bar open print / initial segment
   *   effectiveArrivalTime >= candleTime => Not eligible for current bar open; evaluated on subsequent bar/candle
   */
  isOrderEligibleForBar(order: IOrder, candleTime: number, latencyConfig: ILatencyConfig = this.latencyConfig): boolean {
    return this.getEffectiveArrivalTime(order, latencyConfig) < candleTime;
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

    // Configuration snapshot for intra-candle consistency
    const configSnapshot = this.getExecutionModelConfig();

    // Group pending and partially filled orders by tradeId
    const pendingByTrade = new Map<string, IOrder[]>();
    for (const order of this.orders.values()) {
      if (order.status !== 'PENDING' && order.status !== 'PARTIALLY_FILLED') continue;
      const list = pendingByTrade.get(order.tradeId) || [];
      list.push(order);
      pendingByTrade.set(order.tradeId, list);
    }

    const candleTime =
      bar.timestamp instanceof Date ? bar.timestamp.getTime() : new Date(bar.timestamp).getTime();

    for (const [tradeId, tradeOrders] of pendingByTrade.entries()) {
      // P0/P1-1: OHLCPathCursor for progressive segment evaluation
      const cursor = new OHLCPathCursor(bar);
      const filledThisBar = new Set<string>();

      while (!cursor.isFinished) {
        const seg = cursor.currentSegment;
        if (!seg) break;

        let segHasTrigger = false;
        let currentSegStart = seg.start;
        let currentOrders = Array.from(this.orders.values()).filter(
          (o) => o.tradeId === tradeId && (o.status === 'PENDING' || o.status === 'PARTIALLY_FILLED') && !filledThisBar.has(o.orderId),
        );

        while (currentOrders.length > 0) {
          const triggered: { order: IOrder; fill: IFill }[] = [];
          for (const order of currentOrders) {
            if (order.status !== 'PENDING' && order.status !== 'PARTIALLY_FILLED') continue;

            let res: { isFilled: boolean; fill?: IFill };
            if ((configSnapshot.fillModel === FillModel.NEXT_BAR_MARKET || configSnapshot.fillModel === FillModel.NEXT_BAR_OPEN) && order.orderType === 'MARKET') {
              if (this.isOrderEligibleForBar(order, candleTime, configSnapshot.latencyConfig)) {
                res = FillModelEngine.evaluateFill(
                  order,
                  bar,
                  undefined,
                  FillModel.OHLC_PATH,
                  undefined,
                  undefined,
                  configSnapshot.slippageConfig,
                  configSnapshot.feeConfig,
                  configSnapshot.spreadConfig,
                  configSnapshot.costStressConfig,
                  configSnapshot.partialFillRatio,
                );
              } else {
                res = FillModelEngine.evaluateFill(
                  order,
                  bar,
                  nextCandle,
                  configSnapshot.fillModel,
                  undefined,
                  undefined,
                  configSnapshot.slippageConfig,
                  configSnapshot.feeConfig,
                  configSnapshot.spreadConfig,
                  configSnapshot.costStressConfig,
                  configSnapshot.partialFillRatio,
                );
              }
            } else {
              res = FillModelEngine.evaluateSegmentFill(
                order,
                currentSegStart,
                seg.end,
                candleTime,
                order.symbol,
                configSnapshot.fillModel,
                configSnapshot.slippageConfig,
                configSnapshot.feeConfig,
                configSnapshot.spreadConfig,
                configSnapshot.costStressConfig,
                configSnapshot.partialFillRatio,
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
              configSnapshot.ambiguityMode,
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

          // Pre-Execution Invariant Gates for Entry Orders
          if (order.exitTarget === 'ENTRY') {
            const isLong = order.positionSide ? isLongPosition(order.positionSide) : order.side === 'BUY';

            // 1. Protective Stop Invariant (gap/slippage through stop)
            if (
              order.stopLoss !== undefined &&
              (isLong ? fill.price <= order.stopLoss : fill.price >= order.stopLoss)
            ) {
              order.status = 'REJECTED';
              order.rejectionReason = `REJECTED_GAP_THROUGH_STOP: Candidate fill price ${fill.price} violates protective stop loss ${order.stopLoss}`;
              this.eventCounter++;
              const rejectEvent: IExecutionEvent = {
                eventId: `${this.runId}_evt_reject_${this.eventCounter}`,
                tradeId: order.tradeId,
                orderId: order.orderId,
                symbol: order.symbol,
                eventType: 'ORDER_REJECTED',
                timestamp: fill.timestamp,
                price: fill.price,
                quantity: fill.quantity,
                remainingQuantity: 0,
                fees: 0,
                slippage: 0,
                reason: order.rejectionReason,
                exitTarget: 'ENTRY',
                triggerPrice: order.stopPrice || order.price,
                executedPrice: fill.price,
                exitOrderCreatedAt: order.createdAt,
                exitOrderSubmittedAt: order.submittedAt,
                exitTriggerTimestamp: fill.timestamp,
                exitFillTimestamp: fill.timestamp,
                segmentIndex: cursor.segmentIndex,
                segmentType: seg.type,
              };
              this.events.push(rejectEvent);
              newEvents.push(rejectEvent);

              currentOrders = Array.from(this.orders.values()).filter(
                (o) => o.tradeId === tradeId && (o.status === 'PENDING' || o.status === 'PARTIALLY_FILLED') && !filledThisBar.has(o.orderId),
              );
              continue;
            }

            // 2. Pre-fill Non-Lookahead Risk Drift Gate (Directional Risk Deterioration)
            if (
              order.maxRiskDrift !== undefined &&
              order.referencePrice !== undefined &&
              order.stopLoss !== undefined
            ) {
              const initialRisk = isLong
                ? order.referencePrice - order.stopLoss
                : order.stopLoss - order.referencePrice;
              const actualRisk = isLong
                ? fill.price - order.stopLoss
                : order.stopLoss - fill.price;

              // Defense-in-depth: If actualRisk <= 0, candidate fill price penetrated protective stop
              if (actualRisk <= 0) {
                order.status = 'REJECTED';
                order.rejectionReason = `REJECTED_GAP_THROUGH_STOP: Candidate fill price ${fill.price} violates protective stop loss ${order.stopLoss}`;
                this.eventCounter++;
                const rejectEvent: IExecutionEvent = {
                  eventId: `${this.runId}_evt_reject_${this.eventCounter}`,
                  tradeId: order.tradeId,
                  orderId: order.orderId,
                  symbol: order.symbol,
                  eventType: 'ORDER_REJECTED',
                  timestamp: fill.timestamp,
                  price: fill.price,
                  quantity: fill.quantity,
                  remainingQuantity: 0,
                  fees: 0,
                  slippage: 0,
                  reason: order.rejectionReason,
                  exitTarget: 'ENTRY',
                  triggerPrice: order.stopPrice || order.price,
                  executedPrice: fill.price,
                  exitOrderCreatedAt: order.createdAt,
                  exitOrderSubmittedAt: order.submittedAt,
                  exitTriggerTimestamp: fill.timestamp,
                  exitFillTimestamp: fill.timestamp,
                  segmentIndex: cursor.segmentIndex,
                  segmentType: seg.type,
                };
                this.events.push(rejectEvent);
                newEvents.push(rejectEvent);

                currentOrders = Array.from(this.orders.values()).filter(
                  (o) => o.tradeId === tradeId && (o.status === 'PENDING' || o.status === 'PARTIALLY_FILLED') && !filledThisBar.has(o.orderId),
                );
                continue;
              }

              const riskDriftRatio = initialRisk > 0 ? (actualRisk - initialRisk) / initialRisk : 0;
              if (initialRisk > 0 && riskDriftRatio > order.maxRiskDrift) {
                order.status = 'REJECTED';
                order.rejectionReason = `REJECTED_EXCESSIVE_RISK_DRIFT: Directional risk drift ${(riskDriftRatio * 100).toFixed(1)}% exceeds max permitted ${(order.maxRiskDrift * 100).toFixed(1)}%`;
                this.eventCounter++;
                const rejectEvent: IExecutionEvent = {
                  eventId: `${this.runId}_evt_reject_${this.eventCounter}`,
                  tradeId: order.tradeId,
                  orderId: order.orderId,
                  symbol: order.symbol,
                  eventType: 'ORDER_REJECTED',
                  timestamp: fill.timestamp,
                  price: fill.price,
                  quantity: fill.quantity,
                  remainingQuantity: 0,
                  fees: 0,
                  slippage: 0,
                  reason: order.rejectionReason,
                  exitTarget: 'ENTRY',
                  triggerPrice: order.stopPrice || order.price,
                  executedPrice: fill.price,
                  exitOrderCreatedAt: order.createdAt,
                  exitOrderSubmittedAt: order.submittedAt,
                  exitTriggerTimestamp: fill.timestamp,
                  exitFillTimestamp: fill.timestamp,
                  segmentIndex: cursor.segmentIndex,
                  segmentType: seg.type,
                };
                this.events.push(rejectEvent);
                newEvents.push(rejectEvent);

                currentOrders = Array.from(this.orders.values()).filter(
                  (o) => o.tradeId === tradeId && (o.status === 'PENDING' || o.status === 'PARTIALLY_FILLED') && !filledThisBar.has(o.orderId),
                );
                continue;
              }
            }
          }

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

          filledThisBar.add(order.orderId);

          // 1. Strict finite & positive quantity validation
          if (!Number.isFinite(fill.quantity) || fill.quantity <= 0) {
            throw new Error(
              `INVALID_FILL_QUANTITY: Fill quantity must be a positive finite number, got ${fill.quantity}`,
            );
          }

          // 2. Strict finite & non-negative price, fee, slippage validation
          if (!Number.isFinite(fill.price) || fill.price <= 0) {
            throw new Error(
              `INVALID_FILL_PRICE: Fill price must be a positive finite number, got ${fill.price}`,
            );
          }
          if (!Number.isFinite(fill.fee) || fill.fee < 0) {
            throw new Error(
              `INVALID_FILL_FEE: Fill fee must be a non-negative finite number, got ${fill.fee}`,
            );
          }
          if (!Number.isFinite(fill.slippage) || fill.slippage < 0) {
            throw new Error(
              `INVALID_FILL_SLIPPAGE: Fill slippage must be a non-negative finite number, got ${fill.slippage}`,
            );
          }

          // 3. P0: Explicit protection against fill overshoot / overfill
          const remainingBefore = order.remainingQuantity;
          if (fill.quantity > remainingBefore + 1e-6) {
            throw new Error(
              `FILL_EXCEEDS_REMAINING_QUANTITY: Fill quantity (${fill.quantity}) exceeds order remaining quantity (${remainingBefore})`,
            );
          }

          const prevFilledQty = order.filledQuantity || 0;
          const newFilledQty = Number((prevFilledQty + fill.quantity).toFixed(8));
          const newRemainingQty = Number(Math.max(0, order.remainingQuantity - fill.quantity).toFixed(8));

          // Independent Invariant 1: previous remaining - fill quantity = new remaining
          const expectedRemainingFromPrev = Number((order.remainingQuantity - fill.quantity).toFixed(8));
          if (Math.abs(newRemainingQty - expectedRemainingFromPrev) > 1e-6) {
            throw new Error(
              `ORDER_REMAINING_INVARIANT_VIOLATION: newRemainingQty (${newRemainingQty}) != remainingQuantity (${order.remainingQuantity}) - fill.quantity (${fill.quantity})`,
            );
          }

          // Independent Invariant 2: total quantity balance (quantity = filledQuantity + remainingQuantity)
          const totalQuantityBalance = Number((order.quantity - (newFilledQty + newRemainingQty)).toFixed(8));
          if (Math.abs(totalQuantityBalance) > 1e-6) {
            throw new Error(
              `ORDER_QUANTITY_INVARIANT_VIOLATION: order.quantity (${order.quantity}) != filledQuantity (${newFilledQty}) + remainingQuantity (${newRemainingQty})`,
            );
          }

          const isComplete = newRemainingQty <= 1e-6;
          order.status = isComplete ? 'FILLED' : 'PARTIALLY_FILLED';

          // Explicit fill timestamps
          if (order.firstFilledAt === undefined) {
            order.firstFilledAt = fill.timestamp;
          }
          order.lastFilledAt = fill.timestamp;
          order.filledAt = fill.timestamp;
          if (isComplete) {
            order.completedAt = fill.timestamp;
          }

          // Cumulative VWAP fill price across all executions for this order
          const prevTotalCost = (order.avgFillPrice || 0) * prevFilledQty;
          const newTotalCost = prevTotalCost + (fill.price * fill.quantity);
          order.avgFillPrice = newFilledQty > 0 ? Number((newTotalCost / newFilledQty).toFixed(8)) : fill.price;

          // Cumulative fees and slippage across all fills for this order
          order.fees = Number(((order.fees || 0) + fill.fee).toFixed(8));
          order.slippage = Number(((order.slippage || 0) + fill.slippage).toFixed(8));

          order.filledQuantity = newFilledQty;
          order.remainingQuantity = newRemainingQty;

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
            remainingQuantity: newRemainingQty,
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
            // Protective stop triggered -> If fully filled, cancel all remaining orders for trade
            if (order.status === 'FILLED') {
              this.cancelTradeOrders(order.tradeId);
            }
            break;
          } else {
            // Target limit order triggered -> Update protective stop order quantity to remaining open position size
            const remainingOrders = Array.from(this.orders.values()).filter(
              (o) => o.tradeId === order.tradeId && (o.status === 'PENDING' || o.status === 'PARTIALLY_FILLED'),
            );
            if (remainingOrders.length === 0) break;

            const slOrder = remainingOrders.find((o) => o.orderType === 'STOP');
            if (slOrder) {
              const initialQty = slOrder.initialQuantity ?? slOrder.quantity;
              const totalExitFilledQty = this.fills
                .filter((f) => f.tradeId === order.tradeId && f.exitTarget !== 'ENTRY')
                .reduce((sum, f) => sum + f.quantity, 0);
              const remainingPosQty = Math.max(0, initialQty - totalExitFilledQty);

              if (remainingPosQty > 0) {
                slOrder.quantity = remainingPosQty;
                slOrder.remainingQuantity = remainingPosQty;

                if (order.exitTarget === 'TP1') {
                  const entryFill = this.fills.find(
                    (f) => f.tradeId === order.tradeId && f.exitTarget === 'ENTRY',
                  );
                  const bePrice =
                    entryFill?.price ?? (order.referencePrice ?? slOrder.price);
                  if (bePrice !== undefined) {
                    slOrder.stopPrice = bePrice;
                    slOrder.exitTarget = 'TRAILING_STOP';
                  }
                }
              } else {
                this.cancelTradeOrders(order.tradeId);
                break;
              }
            }
          }

          currentOrders = Array.from(this.orders.values()).filter(
            (o) => o.tradeId === tradeId && (o.status === 'PENDING' || o.status === 'PARTIALLY_FILLED') && !filledThisBar.has(o.orderId),
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
    if (order && (order.status === 'PENDING' || order.status === 'PARTIALLY_FILLED')) {
      order.status = 'CANCELLED';
      return true;
    }
    return false;
  }

  cancelTradeOrders(tradeId: string): number {
    let count = 0;
    for (const order of this.orders.values()) {
      if (order.tradeId === tradeId && (order.status === 'PENDING' || order.status === 'PARTIALLY_FILLED')) {
        order.status = 'CANCELLED';
        count++;
      }
    }
    return count;
  }

  updateStopPrice(tradeId: string, newStopPrice: number, exitTarget?: string): boolean {
    if (typeof newStopPrice !== 'number' || !Number.isFinite(newStopPrice) || newStopPrice <= 0) {
      throw new Error(`INVALID_ORDER_STOP_PRICE: Stop price must be a positive finite number, got ${newStopPrice}`);
    }
    let updated = false;
    for (const order of this.orders.values()) {
      if (
        order.tradeId === tradeId &&
        order.orderType === 'STOP' &&
        (order.status === 'PENDING' || order.status === 'PARTIALLY_FILLED')
      ) {
        order.stopPrice = newStopPrice;
        if (exitTarget) {
          order.exitTarget = exitTarget;
        }
        updated = true;
      }
    }
    return updated;
  }

  cancelOcoGroup(ocoGroupId: string, exceptOrderId?: string): number {
    let count = 0;
    for (const order of this.orders.values()) {
      if (
        order.ocoGroupId === ocoGroupId &&
        order.orderId !== exceptOrderId &&
        (order.status === 'PENDING' || order.status === 'PARTIALLY_FILLED')
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
      if (order.status === 'PENDING' || order.status === 'PARTIALLY_FILLED') {
        order.status = 'CANCELLED';
        count++;
      }
    }
    return count;
  }

  restoreOrder(order: IOrder): void {
    if (!order || !order.orderId) {
      throw new Error('CORRUPT_EXECUTION_ORDER: Missing order or orderId during state restoration');
    }
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
    if (!Array.isArray(orders)) {
      throw new Error('CORRUPT_EXECUTION_ORDERS: Invalid orders array during state restoration');
    }
    for (const ord of orders) {
      this.restoreOrder(ord);
    }
  }

  getOrder(orderId: string): IOrder | undefined {
    return this.orders.get(orderId);
  }

  getTradeOrders(tradeId: string): IOrder[] {
    return Array.from(this.orders.values()).filter(
      (o) => o.tradeId === tradeId && (o.status === 'PENDING' || o.status === 'PARTIALLY_FILLED'),
    );
  }

  restoreFill(fill: IFill): void {
    if (!fill || !fill.fillId) {
      throw new Error('CORRUPT_EXECUTION_FILL: Missing fill or fillId during state restoration');
    }
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
    if (!Array.isArray(fills)) {
      throw new Error('CORRUPT_EXECUTION_FILLS: Invalid fills array during state restoration');
    }
    for (const f of fills) {
      this.restoreFill(f);
    }
  }

  restoreEvent(event: IExecutionEvent): void {
    if (!event || !event.eventId) {
      throw new Error('CORRUPT_EXECUTION_EVENT: Missing event or eventId during state restoration');
    }
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
    if (!Array.isArray(events)) {
      throw new Error('CORRUPT_EXECUTION_EVENTS: Invalid events array during state restoration');
    }
    for (const ev of events) {
      this.restoreEvent(ev);
    }
  }

  getExecutionSequences(): { nextOrderSequence: number; nextFillSequence: number; nextEventSequence: number } {
    return {
      nextOrderSequence: this.orderCounter + 1,
      nextFillSequence: this.fillCounter + 1,
      nextEventSequence: this.eventCounter + 1,
    };
  }

  setExecutionSequences(sequences: {
    nextOrderSequence?: number;
    nextFillSequence?: number;
    nextEventSequence?: number;
    orderCounter?: number;
    fillCounter?: number;
    eventCounter?: number;
  }): void {
    if (!sequences || typeof sequences !== 'object') {
      throw new Error('CORRUPT_EXECUTION_SEQUENCE_STATE: Invalid sequences object');
    }

    // 1. Order sequence validation
    const hasNextOrd = typeof sequences.nextOrderSequence === 'number' && Number.isFinite(sequences.nextOrderSequence);
    const hasOrdCounter = typeof sequences.orderCounter === 'number' && Number.isFinite(sequences.orderCounter);
    if (hasNextOrd && hasOrdCounter) {
      if (sequences.nextOrderSequence !== sequences.orderCounter! + 1) {
        throw new Error(
          `CORRUPT_EXECUTION_SEQUENCE_STATE: Contradictory order sequence state (nextOrderSequence=${sequences.nextOrderSequence} != orderCounter=${sequences.orderCounter} + 1)`,
        );
      }
      this.orderCounter = sequences.orderCounter!;
    } else if (hasNextOrd) {
      this.orderCounter = Math.max(0, sequences.nextOrderSequence! - 1);
    } else if (hasOrdCounter) {
      this.orderCounter = sequences.orderCounter!;
    }

    // 2. Fill sequence validation
    const hasNextFill = typeof sequences.nextFillSequence === 'number' && Number.isFinite(sequences.nextFillSequence);
    const hasFillCounter = typeof sequences.fillCounter === 'number' && Number.isFinite(sequences.fillCounter);
    if (hasNextFill && hasFillCounter) {
      if (sequences.nextFillSequence !== sequences.fillCounter! + 1) {
        throw new Error(
          `CORRUPT_EXECUTION_SEQUENCE_STATE: Contradictory fill sequence state (nextFillSequence=${sequences.nextFillSequence} != fillCounter=${sequences.fillCounter} + 1)`,
        );
      }
      this.fillCounter = sequences.fillCounter!;
    } else if (hasNextFill) {
      this.fillCounter = Math.max(0, sequences.nextFillSequence! - 1);
    } else if (hasFillCounter) {
      this.fillCounter = sequences.fillCounter!;
    }

    // 3. Event sequence validation
    const hasNextEvt = typeof sequences.nextEventSequence === 'number' && Number.isFinite(sequences.nextEventSequence);
    const hasEvtCounter = typeof sequences.eventCounter === 'number' && Number.isFinite(sequences.eventCounter);
    if (hasNextEvt && hasEvtCounter) {
      if (sequences.nextEventSequence !== sequences.eventCounter! + 1) {
        throw new Error(
          `CORRUPT_EXECUTION_SEQUENCE_STATE: Contradictory event sequence state (nextEventSequence=${sequences.nextEventSequence} != eventCounter=${sequences.eventCounter} + 1)`,
        );
      }
      this.eventCounter = sequences.eventCounter!;
    } else if (hasNextEvt) {
      this.eventCounter = Math.max(0, sequences.nextEventSequence! - 1);
    } else if (hasEvtCounter) {
      this.eventCounter = sequences.eventCounter!;
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

  createCheckpoint(): IExecutionSimulatorCheckpoint {
    return {
      version: 1,
      runId: this.runId,
      orderCounter: this.orderCounter,
      fillCounter: this.fillCounter,
      eventCounter: this.eventCounter,
      executionConfig: this.getExecutionModelConfig(),
      orders: Array.from(this.orders.values()).map((o) => ({
        ...o,
        initialQuantity: o.initialQuantity ?? o.quantity,
      })),
      fills: this.fills.map((f) => ({ ...f })),
      events: this.events.map((e) => ({ ...e })),
    };
  }

  restoreCheckpoint(checkpoint: IExecutionSimulatorCheckpoint): void {
    if (!checkpoint || typeof checkpoint !== 'object') {
      throw new Error('CORRUPT_EXECUTION_CHECKPOINT: Checkpoint must be a valid object');
    }
    if (checkpoint.version !== 1) {
      throw new Error(`UNSUPPORTED_CHECKPOINT_VERSION: Expected version 1, got ${checkpoint.version}`);
    }
    if (typeof checkpoint.runId !== 'string' || checkpoint.runId.trim() === '') {
      throw new Error('CORRUPT_EXECUTION_CHECKPOINT: runId must be a non-empty string');
    }
    if (!Number.isInteger(checkpoint.orderCounter) || checkpoint.orderCounter < 0) {
      throw new Error('CORRUPT_EXECUTION_CHECKPOINT: orderCounter must be a non-negative integer');
    }
    if (!Number.isInteger(checkpoint.fillCounter) || checkpoint.fillCounter < 0) {
      throw new Error('CORRUPT_EXECUTION_CHECKPOINT: fillCounter must be a non-negative integer');
    }
    if (!Number.isInteger(checkpoint.eventCounter) || checkpoint.eventCounter < 0) {
      throw new Error('CORRUPT_EXECUTION_CHECKPOINT: eventCounter must be a non-negative integer');
    }
    if (!Array.isArray(checkpoint.orders)) {
      throw new Error('CORRUPT_EXECUTION_CHECKPOINT: orders must be an array');
    }
    if (!Array.isArray(checkpoint.fills)) {
      throw new Error('CORRUPT_EXECUTION_CHECKPOINT: fills must be an array');
    }
    if (!Array.isArray(checkpoint.events)) {
      throw new Error('CORRUPT_EXECUTION_CHECKPOINT: events must be an array');
    }

    // Step 1: Validate execution model configuration
    validateExecutionModelConfig(checkpoint.executionConfig);
    const cfg = checkpoint.executionConfig;
    const candidateConfig: ExecutionModelConfig = {
      fillModel: cfg.fillModel,
      ambiguityMode: cfg.ambiguityMode,
      latencyConfig: { ...cfg.latencyConfig },
      slippageConfig: cfg.slippageConfig ? { ...cfg.slippageConfig } : undefined,
      feeConfig: cfg.feeConfig ? { ...cfg.feeConfig } : undefined,
      spreadConfig: cfg.spreadConfig ? { ...cfg.spreadConfig } : undefined,
      costStressConfig: cfg.costStressConfig
        ? {
            ...cfg.costStressConfig,
            feeConfig: cfg.costStressConfig.feeConfig ? { ...cfg.costStressConfig.feeConfig } : undefined,
            slippageConfig: cfg.costStressConfig.slippageConfig ? { ...cfg.costStressConfig.slippageConfig } : undefined,
            spreadConfig: cfg.costStressConfig.spreadConfig ? { ...cfg.costStressConfig.spreadConfig } : undefined,
          }
        : undefined,
      partialFillRatio: cfg.partialFillRatio,
    };

    // Step 2: Validate orders and construct candidate orders map
    const candidateOrders = new Map<string, IOrder>();
    for (const ord of checkpoint.orders) {
      if (!ord || typeof ord !== 'object') {
        throw new Error('CORRUPT_EXECUTION_ORDER: Order must be an object');
      }
      if (typeof ord.orderId !== 'string' || ord.orderId.trim() === '') {
        throw new Error('CORRUPT_EXECUTION_ORDER: Invalid orderId');
      }
      if (candidateOrders.has(ord.orderId)) {
        throw new Error(`CORRUPT_EXECUTION_ORDER: Duplicate orderId "${ord.orderId}"`);
      }
      if (typeof ord.tradeId !== 'string' || ord.tradeId.trim() === '') {
        throw new Error('CORRUPT_EXECUTION_ORDER: Invalid tradeId');
      }
      if (typeof ord.symbol !== 'string' || ord.symbol.trim() === '') {
        throw new Error('CORRUPT_EXECUTION_ORDER: Invalid symbol');
      }
      if (ord.side !== 'BUY' && ord.side !== 'SELL') {
        throw new Error(`CORRUPT_EXECUTION_ORDER: Invalid side "${ord.side}"`);
      }
      if (!['MARKET', 'LIMIT', 'STOP', 'STOP_LIMIT'].includes(ord.orderType)) {
        throw new Error(`CORRUPT_EXECUTION_ORDER: Invalid orderType "${ord.orderType}"`);
      }
      if (!['PENDING', 'FILLED', 'PARTIALLY_FILLED', 'CANCELLED', 'REJECTED'].includes(ord.status)) {
        throw new Error(`CORRUPT_EXECUTION_ORDER: Invalid status "${ord.status}"`);
      }

      // Numerical validations
      if (typeof ord.quantity !== 'number' || !Number.isFinite(ord.quantity) || ord.quantity <= 0) {
        throw new Error(`CORRUPT_EXECUTION_ORDER: quantity must be a positive finite number, got ${ord.quantity}`);
      }
      const filledQty = ord.filledQuantity !== undefined ? ord.filledQuantity : 0;
      if (typeof filledQty !== 'number' || !Number.isFinite(filledQty) || filledQty < 0) {
        throw new Error(`CORRUPT_EXECUTION_ORDER: filledQuantity must be a non-negative finite number, got ${filledQty}`);
      }
      if (typeof ord.remainingQuantity !== 'number' || !Number.isFinite(ord.remainingQuantity) || ord.remainingQuantity < 0) {
        throw new Error(`CORRUPT_EXECUTION_ORDER: remainingQuantity must be a non-negative finite number, got ${ord.remainingQuantity}`);
      }

      // initialQuantity validation
      const initialQty = ord.initialQuantity !== undefined ? ord.initialQuantity : ord.quantity;
      if (typeof initialQty !== 'number' || !Number.isFinite(initialQty) || initialQty <= 0) {
        throw new Error(`CORRUPT_EXECUTION_ORDER: initialQuantity must be a positive finite number, got ${initialQty}`);
      }
      if (ord.quantity > initialQty + EXECUTION_PRECISION.quantityEpsilon) {
        throw new Error(
          `CORRUPT_EXECUTION_ORDER: quantity (${ord.quantity}) exceeds initialQuantity (${initialQty})`,
        );
      }
      if (filledQty > initialQty + EXECUTION_PRECISION.quantityEpsilon) {
        throw new Error(
          `CORRUPT_EXECUTION_ORDER: filledQuantity (${filledQty}) exceeds initialQuantity (${initialQty})`,
        );
      }
      if (ord.remainingQuantity > initialQty + EXECUTION_PRECISION.quantityEpsilon) {
        throw new Error(
          `CORRUPT_EXECUTION_ORDER: remainingQuantity (${ord.remainingQuantity}) exceeds initialQuantity (${initialQty})`,
        );
      }

      // Quantity invariants
      if (filledQty > ord.quantity + EXECUTION_PRECISION.quantityEpsilon) {
        throw new Error(
          `CORRUPT_EXECUTION_ORDER: filledQuantity (${filledQty}) exceeds total quantity (${ord.quantity})`,
        );
      }
      const balanceDiff = Math.abs(ord.quantity - (filledQty + ord.remainingQuantity));
      if (balanceDiff > EXECUTION_PRECISION.quantityEpsilon) {
        throw new Error(
          `CORRUPT_EXECUTION_ORDER: quantity balance invariant violated: ${ord.quantity} != ${filledQty} + ${ord.remainingQuantity}`,
        );
      }

      // Status consistency
      if (ord.status === 'FILLED' && ord.remainingQuantity > EXECUTION_PRECISION.quantityEpsilon) {
        throw new Error(
          `CORRUPT_EXECUTION_ORDER: Order with status FILLED cannot have remainingQuantity > 0, got ${ord.remainingQuantity}`,
        );
      }
      if (ord.status === 'PARTIALLY_FILLED' && (ord.remainingQuantity <= EXECUTION_PRECISION.quantityEpsilon || filledQty <= 0)) {
        throw new Error(
          `CORRUPT_EXECUTION_ORDER: Order with status PARTIALLY_FILLED must have remainingQuantity > 0 and filledQuantity > 0`,
        );
      }
      if (ord.status === 'PENDING' && filledQty > EXECUTION_PRECISION.quantityEpsilon) {
        throw new Error(
          `CORRUPT_EXECUTION_ORDER: Order with status PENDING cannot have filledQuantity > 0, got ${filledQty}`,
        );
      }

      // Timestamps and costs
      if (typeof ord.createdAt !== 'number' || !Number.isFinite(ord.createdAt) || ord.createdAt <= 0) {
        throw new Error(`CORRUPT_EXECUTION_ORDER: createdAt must be a positive finite timestamp, got ${ord.createdAt}`);
      }
      if (typeof ord.submittedAt !== 'number' || !Number.isFinite(ord.submittedAt) || ord.submittedAt <= 0) {
        throw new Error(`CORRUPT_EXECUTION_ORDER: submittedAt must be a positive finite timestamp, got ${ord.submittedAt}`);
      }
      if (typeof ord.fees !== 'number' || !Number.isFinite(ord.fees) || ord.fees < 0) {
        throw new Error(`CORRUPT_EXECUTION_ORDER: fees must be a non-negative finite number, got ${ord.fees}`);
      }
      if (typeof ord.slippage !== 'number' || !Number.isFinite(ord.slippage) || ord.slippage < 0) {
        throw new Error(`CORRUPT_EXECUTION_ORDER: slippage must be a non-negative finite number, got ${ord.slippage}`);
      }
      if (ord.avgFillPrice !== undefined && (!Number.isFinite(ord.avgFillPrice) || ord.avgFillPrice <= 0)) {
        throw new Error(`CORRUPT_EXECUTION_ORDER: avgFillPrice must be a positive finite number, got ${ord.avgFillPrice}`);
      }
      if (ord.price !== undefined && (!Number.isFinite(ord.price) || ord.price <= 0)) {
        throw new Error(`CORRUPT_EXECUTION_ORDER: price must be a positive finite number, got ${ord.price}`);
      }
      if (ord.stopPrice !== undefined && (!Number.isFinite(ord.stopPrice) || ord.stopPrice <= 0)) {
        throw new Error(`CORRUPT_EXECUTION_ORDER: stopPrice must be a positive finite number, got ${ord.stopPrice}`);
      }
      if (ord.stopLoss !== undefined && (!Number.isFinite(ord.stopLoss) || ord.stopLoss <= 0)) {
        throw new Error(`CORRUPT_EXECUTION_ORDER: stopLoss must be a positive finite number, got ${ord.stopLoss}`);
      }
      if (ord.positionSide !== undefined && (typeof ord.positionSide !== 'string' || ord.positionSide.trim() === '')) {
        throw new Error(`CORRUPT_EXECUTION_ORDER: positionSide must be a non-empty string, got ${ord.positionSide}`);
      }

      const candidateOrder: IOrder = {
        ...ord,
        initialQuantity: initialQty,
      };
      candidateOrders.set(candidateOrder.orderId, candidateOrder);
    }

    // Step 3: Validate fills and construct candidate fills array
    const candidateFills: IFill[] = [];
    const fillsByOrder = new Map<string, number>();
    const seenFillIds = new Set<string>();

    for (const f of checkpoint.fills) {
      if (!f || typeof f !== 'object') {
        throw new Error('CORRUPT_EXECUTION_FILL: Fill must be an object');
      }
      if (typeof f.fillId !== 'string' || f.fillId.trim() === '') {
        throw new Error('CORRUPT_EXECUTION_FILL: Invalid fillId');
      }
      if (seenFillIds.has(f.fillId)) {
        throw new Error(`CORRUPT_EXECUTION_FILL: Duplicate fillId "${f.fillId}"`);
      }
      seenFillIds.add(f.fillId);

      if (typeof f.orderId !== 'string' || f.orderId.trim() === '') {
        throw new Error('CORRUPT_EXECUTION_FILL: Invalid orderId');
      }
      if (typeof f.tradeId !== 'string' || f.tradeId.trim() === '') {
        throw new Error('CORRUPT_EXECUTION_FILL: Invalid tradeId');
      }
      if (typeof f.symbol !== 'string' || f.symbol.trim() === '') {
        throw new Error('CORRUPT_EXECUTION_FILL: Invalid symbol');
      }
      if (f.side !== 'BUY' && f.side !== 'SELL') {
        throw new Error(`CORRUPT_EXECUTION_FILL: Invalid side "${f.side}"`);
      }
      if (typeof f.price !== 'number' || !Number.isFinite(f.price) || f.price <= 0) {
        throw new Error(`CORRUPT_EXECUTION_FILL: price must be a positive finite number, got ${f.price}`);
      }
      if (typeof f.quantity !== 'number' || !Number.isFinite(f.quantity) || f.quantity <= 0) {
        throw new Error(`CORRUPT_EXECUTION_FILL: quantity must be a positive finite number, got ${f.quantity}`);
      }
      if (typeof f.fee !== 'number' || !Number.isFinite(f.fee) || f.fee < 0) {
        throw new Error(`CORRUPT_EXECUTION_FILL: fee must be a non-negative finite number, got ${f.fee}`);
      }
      if (typeof f.slippage !== 'number' || !Number.isFinite(f.slippage) || f.slippage < 0) {
        throw new Error(`CORRUPT_EXECUTION_FILL: slippage must be a non-negative finite number, got ${f.slippage}`);
      }
      if (typeof f.timestamp !== 'number' || !Number.isFinite(f.timestamp) || f.timestamp <= 0) {
        throw new Error(`CORRUPT_EXECUTION_FILL: timestamp must be a positive finite number, got ${f.timestamp}`);
      }

      // Check against candidate order
      const ord = candidateOrders.get(f.orderId);
      if (!ord) {
        throw new Error(`CORRUPT_EXECUTION_FILL: Fill references unknown orderId "${f.orderId}"`);
      }
      if (f.tradeId !== ord.tradeId) {
        throw new Error(`CORRUPT_EXECUTION_FILL: Fill tradeId "${f.tradeId}" does not match order tradeId "${ord.tradeId}"`);
      }

      const cumQty = (fillsByOrder.get(f.orderId) || 0) + f.quantity;
      if (cumQty > ord.quantity + EXECUTION_PRECISION.quantityEpsilon) {
        throw new Error(
          `CORRUPT_EXECUTION_FILL: Cumulative fill quantity (${cumQty}) exceeds order quantity (${ord.quantity})`,
        );
      }
      fillsByOrder.set(f.orderId, cumQty);

      candidateFills.push({ ...f });
    }

    // Step 4: Validate events and construct candidate events array
    const candidateEvents: IExecutionEvent[] = [];
    const seenEventIds = new Set<string>();

    for (const ev of checkpoint.events) {
      if (!ev || typeof ev !== 'object') {
        throw new Error('CORRUPT_EXECUTION_EVENT: Event must be an object');
      }
      if (typeof ev.eventId !== 'string' || ev.eventId.trim() === '') {
        throw new Error('CORRUPT_EXECUTION_EVENT: Invalid eventId');
      }
      if (seenEventIds.has(ev.eventId)) {
        throw new Error(`CORRUPT_EXECUTION_EVENT: Duplicate eventId "${ev.eventId}"`);
      }
      seenEventIds.add(ev.eventId);

      if (typeof ev.tradeId !== 'string' || ev.tradeId.trim() === '') {
        throw new Error('CORRUPT_EXECUTION_EVENT: Invalid tradeId');
      }
      if (typeof ev.orderId !== 'string' || ev.orderId.trim() === '') {
        throw new Error('CORRUPT_EXECUTION_EVENT: Invalid orderId');
      }
      if (typeof ev.timestamp !== 'number' || !Number.isFinite(ev.timestamp) || ev.timestamp <= 0) {
        throw new Error(`CORRUPT_EXECUTION_EVENT: timestamp must be a positive finite number, got ${ev.timestamp}`);
      }

      const ord = candidateOrders.get(ev.orderId);
      if (!ord) {
        throw new Error(`CORRUPT_EXECUTION_EVENT: Event references unknown orderId "${ev.orderId}"`);
      }
      if (ev.tradeId !== ord.tradeId) {
        throw new Error(`CORRUPT_EXECUTION_EVENT: Event tradeId "${ev.tradeId}" does not match order tradeId "${ord.tradeId}"`);
      }

      candidateEvents.push({ ...ev });
    }

    // Step 5: ATOMIC COMMIT — All validations passed, commit candidate state
    this.runId = checkpoint.runId;
    this.orderCounter = checkpoint.orderCounter;
    this.fillCounter = checkpoint.fillCounter;
    this.eventCounter = checkpoint.eventCounter;

    this.fillModel = candidateConfig.fillModel;
    this.ambiguityMode = candidateConfig.ambiguityMode;
    this.latencyConfig = candidateConfig.latencyConfig;
    this.slippageConfig = candidateConfig.slippageConfig;
    this.feeConfig = candidateConfig.feeConfig;
    this.spreadConfig = candidateConfig.spreadConfig;
    this.costStressConfig = candidateConfig.costStressConfig;
    this.partialFillRatio = candidateConfig.partialFillRatio;

    this.orders = candidateOrders;
    this.fills = candidateFills;
    this.events = candidateEvents;
  }

  static fromCheckpoint(checkpoint: IExecutionSimulatorCheckpoint): ExecutionSimulator {
    const sim = new ExecutionSimulator();
    sim.restoreCheckpoint(checkpoint);
    return sim;
  }
}
