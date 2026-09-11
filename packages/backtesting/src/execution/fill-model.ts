import { FillModel, IFill, IOrder, OrderSide, SameCandleAmbiguityMode, IFeeConfig, ISlippageConfig, ISpreadConfig, ExecutionCostStressConfig } from './types';
import { ICandle } from '@quant/shared';
import { SlippageModel } from './slippage-model';
import { FeeModel } from './fee-model';
import { SpreadModel } from './spread-model';
import { OHLCPathCursor } from './ohlc-path-cursor';

export class FillModelEngine {
  /**
   * Authoritative deterministic timestamp extractor and validator for candles.
   * Accepts Date, numeric timestamps, and parseable date strings.
   * Throws an explicit Error for invalid, NaN, or non-finite values. Never uses Date.now().
   */
  static requireCandleTimestamp(candle: ICandle): number {
    if (!candle || candle.timestamp === undefined || candle.timestamp === null) {
      throw new Error('Invalid candle: missing timestamp');
    }

    let timeMs: number;
    if (candle.timestamp instanceof Date) {
      timeMs = candle.timestamp.getTime();
    } else if (typeof candle.timestamp === 'number') {
      timeMs = candle.timestamp;
    } else if (typeof candle.timestamp === 'string') {
      timeMs = new Date(candle.timestamp).getTime();
    } else {
      throw new Error(`Unsupported candle timestamp format: ${typeof candle.timestamp}`);
    }

    if (Number.isNaN(timeMs) || !Number.isFinite(timeMs)) {
      throw new Error(`Invalid non-finite candle timestamp value: ${candle.timestamp}`);
    }

    return timeMs;
  }

  /**
   * Validates lower timeframe sub-bars strictly against parent candle range and chronological ordering
   */
  static validateSubBars(
    parentCandle: ICandle,
    lowerTfCandles?: ICandle[],
    parentDurationMs: number = 60 * 60 * 1000,
    allowPartial: boolean = false,
  ): { isValid: boolean; reason?: string } {
    if (!lowerTfCandles || lowerTfCandles.length === 0) {
      return { isValid: false, reason: 'MISSING_LOWER_TF_DATA' };
    }

    const parentOpenTime = this.requireCandleTimestamp(parentCandle);
    const parentCloseTime = parentOpenTime + parentDurationMs;
    const firstTime = this.requireCandleTimestamp(lowerTfCandles[0]);

    // Check first bar starts at parent open time
    if (firstTime !== parentOpenTime && !allowPartial) {
      return { isValid: false, reason: 'SUBBAR_START_TIME_MISMATCH' };
    }

    let prevTime = -1;
    for (const sub of lowerTfCandles) {
      const subTime = this.requireCandleTimestamp(sub);

      // Check sub-bar belongs to current parent candle start boundary
      if (subTime < parentOpenTime) {
        return { isValid: false, reason: 'SUBBAR_OUT_OF_BOUNDS_PAST' };
      }

      // Check sub-bar does not exceed parent candle end boundary
      if (subTime >= parentCloseTime) {
        return { isValid: false, reason: 'SUBBAR_OUT_OF_BOUNDS_FUTURE' };
      }

      // Check duplicate timestamps
      if (prevTime >= 0 && subTime === prevTime) {
        return { isValid: false, reason: 'SUBBAR_DUPLICATE_TIMESTAMP' };
      }

      // Check strict ascending chronological order
      if (prevTime >= 0 && subTime < prevTime) {
        return { isValid: false, reason: 'SUBBARS_OUT_OF_ORDER' };
      }

      // Check sub-bar interval regularity for 15m M1 series (must be exactly 60,000ms apart)
      if (
        prevTime >= 0 &&
        parentDurationMs === 15 * 60 * 1000 &&
        lowerTfCandles.length === 15 &&
        !allowPartial &&
        subTime - prevTime !== 60000
      ) {
        return { isValid: false, reason: 'SUBBAR_INTERVAL_MISMATCH' };
      }

      prevTime = subTime;
    }

    // P1-E: Strict 15 M1 bar count validation for 15m parent candles
    if (parentDurationMs === 15 * 60 * 1000 && !allowPartial) {
      if (lowerTfCandles.length !== 15) {
        return { isValid: false, reason: 'SUBBAR_COUNT_MISMATCH_EXPECTED_15' };
      }
    }

    // Check lower-TF completeness & coverage
    const lastTime = this.requireCandleTimestamp(lowerTfCandles[lowerTfCandles.length - 1]);

    const subStepMs =
      lowerTfCandles.length >= 2
        ? this.requireCandleTimestamp(lowerTfCandles[1]) - firstTime
        : 60 * 1000;

    // Check start boundary coverage
    if (firstTime - parentOpenTime >= Math.max(subStepMs, 60000)) {
      return { isValid: false, reason: 'SUBBAR_COVERAGE_INCOMPLETE' };
    }

    // Check end boundary coverage if parent duration spans multiple sub-bars
    if (
      parentDurationMs > Math.max(subStepMs, 60000) &&
      parentCloseTime - (lastTime + subStepMs) > Math.max(subStepMs, 60000)
    ) {
      return { isValid: false, reason: 'SUBBAR_COVERAGE_INCOMPLETE' };
    }

    // Check internal sub-bar gaps
    let prevSubTime = firstTime;
    for (let i = 1; i < lowerTfCandles.length; i++) {
      const currTime = this.requireCandleTimestamp(lowerTfCandles[i]);

      if (currTime - prevSubTime > Math.max(subStepMs * 1.5, 90000)) {
        return { isValid: false, reason: 'SUBBAR_COVERAGE_INCOMPLETE' };
      }
      prevSubTime = currTime;
    }

    return { isValid: true };
  }

  /**
   * Authoritative Segment-Aware Intra-Segment Conflict Resolver
   * For orders triggered within the SAME path segment (segStart -> segEnd), computes distance along vector:
   * distance = Math.abs(triggerPrice - segStart)
   * The order with the smallest distance was encountered FIRST along the segment vector!
   * Ambiguity policies (CONSERVATIVE / OPTIMISTIC) act ONLY as tie-breakers when distances are identical.
   */
  static resolveSegmentConflict(
    triggered: { order: IOrder; fill: IFill }[],
    segStart: number,
    segEnd: number,
    ambiguityMode: SameCandleAmbiguityMode = SameCandleAmbiguityMode.OHLC_PATH,
  ): { winningFill?: IFill; winningOrder?: IOrder; reason?: string } {
    if (triggered.length === 0) return {};
    if (triggered.length === 1) return { winningFill: triggered[0].fill, winningOrder: triggered[0].order };

    // Calculate distance along segment vector (segStart -> segEnd) for each triggered order
    const withDistance = triggered.map((item) => {
      const trigPrice =
        item.order.orderType === 'STOP' && item.order.stopPrice !== undefined
          ? item.order.stopPrice
          : item.order.price ?? segStart;
      const dist = Math.abs(trigPrice - segStart);
      return { item, dist };
    });

    // Sort ascending by distance along segment vector
    withDistance.sort((a, b) => a.dist - b.dist);

    const minDist = withDistance[0].dist;
    // Find all candidates that share the minimum distance (within small numerical tolerance)
    const minCandidates = withDistance.filter((x) => Math.abs(x.dist - minDist) < 1e-6).map((x) => x.item);

    if (minCandidates.length === 1) {
      return { winningFill: minCandidates[0].fill, winningOrder: minCandidates[0].order, reason: 'SEGMENT_VECTOR_DISTANCE_ORDERED' };
    }

    // Tie-breaker when multiple orders share the EXACT same distance along the segment:
    if (ambiguityMode === SameCandleAmbiguityMode.CONSERVATIVE) {
      const stopTrigger = minCandidates.find((t) => t.order.orderType === 'STOP');
      if (stopTrigger) {
        return { winningFill: stopTrigger.fill, winningOrder: stopTrigger.order, reason: 'CONSERVATIVE_STOP_FIRST' };
      }
    }

    if (ambiguityMode === SameCandleAmbiguityMode.OPTIMISTIC) {
      const limitTrigger = minCandidates.find((t) => t.order.orderType === 'LIMIT');
      if (limitTrigger) {
        return { winningFill: limitTrigger.fill, winningOrder: limitTrigger.order, reason: 'OPTIMISTIC_TARGET_FIRST' };
      }
    }

    return { winningFill: minCandidates[0].fill, winningOrder: minCandidates[0].order, reason: 'SEGMENT_VECTOR_DISTANCE_ORDERED' };
  }

  /**
   * Thin compatibility wrapper for Same-Candle Ambiguity Conflict Resolution.
   * Delegates evaluation directly to OHLCPathCursor, evaluateSegmentFill, and resolveSegmentConflict.
   */
  static resolveSameCandleConflict(
    orders: IOrder[],
    currentCandle: ICandle,
    nextCandle?: ICandle,
    model: FillModel = FillModel.OHLC_PATH,
    ambiguityMode: SameCandleAmbiguityMode = SameCandleAmbiguityMode.CONSERVATIVE,
    lowerTfCandles?: ICandle[],
    parentDurationMs?: number,
  ): { winningFill?: IFill; winningOrder?: IOrder; reason?: string } {
    if (orders.length === 0) return {};

    if (model === FillModel.LOWER_TIMEFRAME) {
      return { reason: 'LOWER_TIMEFRAME_REQUIRES_EXECUTION_SIMULATOR' };
    }

    const candleTime = this.requireCandleTimestamp(currentCandle);

    const cursor = new OHLCPathCursor(currentCandle);
    for (const seg of cursor.segments) {
      const segmentTriggered: { order: IOrder; fill: IFill }[] = [];
      for (const order of orders) {
        const res = this.evaluateSegmentFill(
          order,
          seg.start,
          seg.end,
          candleTime,
          order.symbol,
          model,
        );
        if (res.isFilled && res.fill) {
          segmentTriggered.push({ order, fill: res.fill });
        }
      }

      if (segmentTriggered.length === 1) {
        return {
          winningFill: segmentTriggered[0].fill,
          winningOrder: segmentTriggered[0].order,
          reason: 'OHLC_PATH_SEGMENT_EXACT',
        };
      }

      if (segmentTriggered.length > 1) {
        const segRes = this.resolveSegmentConflict(
          segmentTriggered,
          seg.start,
          seg.end,
          ambiguityMode,
        );
        if (segRes.winningOrder && segRes.winningFill) {
          return {
            winningFill: segRes.winningFill,
            winningOrder: segRes.winningOrder,
            reason: segRes.reason || 'OHLC_PATH_SEGMENT_RESOLVED',
          };
        }
      }
    }

    return {};
  }

  /**
   * Helper to calculate gap-through base price for STOP orders
   */
  static calculateStopBasePrice(side: OrderSide, stopPrice: number, referencePrice: number): number {
    if (side === 'SELL' && referencePrice <= stopPrice) {
      return referencePrice; // Gap down open / start price
    } else if (side === 'BUY' && referencePrice >= stopPrice) {
      return referencePrice; // Gap up open / start price
    }
    return stopPrice;
  }

  /**
   * Helper to calculate gap-through base price for LIMIT orders
   */
  static calculateLimitBasePrice(side: OrderSide, targetPrice: number, referencePrice: number): number {
    if (side === 'SELL' && referencePrice >= targetPrice) {
      return referencePrice; // Gap up open / start price
    } else if (side === 'BUY' && referencePrice <= targetPrice) {
      return referencePrice; // Gap down open / start price
    }
    return targetPrice;
  }

  /**
   * Single source of truth for fill construction, slippage, spread, and fee calculations.
   */
  static buildFill(
    order: IOrder,
    basePrice: number,
    candleTime: number,
    symbol: string,
    orderType: 'MARKET' | 'LIMIT' | 'STOP',
    currentCandle?: ICandle,
    model?: FillModel,
    slippageConfig?: ISlippageConfig,
    feeConfig?: IFeeConfig,
    spreadConfig?: ISpreadConfig,
    costStressConfig?: ExecutionCostStressConfig,
    partialFillRatio?: number,
  ): IFill {
    const rawQty = order.remainingQuantity > 0 ? order.remainingQuantity : order.quantity;
    let fillQty = rawQty;
    let isPartial = false;
    if (partialFillRatio !== undefined && partialFillRatio > 0 && partialFillRatio < 1) {
      fillQty = Math.min(rawQty, Number((rawQty * partialFillRatio).toFixed(8)));
      isPartial = fillQty < rawQty - 1e-6;
    }

    if (model === FillModel.LIMIT_TOUCH) {
      const fee = FeeModel.calculateFees(symbol, basePrice, fillQty, order.side, false, feeConfig, costStressConfig);
      return {
        fillId: `fill_${order.orderId}_${candleTime}`,
        orderId: order.orderId,
        tradeId: order.tradeId,
        symbol: order.symbol,
        side: order.side,
        price: Number(basePrice.toFixed(4)),
        quantity: fillQty,
        fee,
        slippage: 0,
        timestamp: candleTime,
        isPartial,
        exitTarget: order.exitTarget,
      };
    }
    const slip = SlippageModel.calculateSlippage(
      basePrice,
      fillQty,
      order.side,
      orderType,
      currentCandle,
      slippageConfig,
      costStressConfig,
    );
    const halfSpread = SpreadModel.getHalfSpread(slip.executedPrice, symbol, spreadConfig, costStressConfig);
    const finalPrice =
      order.side === 'BUY' ? slip.executedPrice + halfSpread : slip.executedPrice - halfSpread;
    const fee = FeeModel.calculateFees(
      symbol,
      finalPrice,
      fillQty,
      order.side,
      orderType === 'STOP',
      feeConfig,
      costStressConfig,
    );

    return {
      fillId: `fill_${order.orderId}_${candleTime}`,
      orderId: order.orderId,
      tradeId: order.tradeId,
      symbol: order.symbol,
      side: order.side,
      price: Number(finalPrice.toFixed(4)),
      quantity: fillQty,
      fee,
      slippage: slip.slippageAmount,
      timestamp: candleTime,
      isPartial,
      exitTarget: order.exitTarget,
    };
  }

  /**
   * Evaluates an order against a specific intra-candle segment (e.g. Open -> Low, Low -> High, High -> Close)
   */
  static evaluateSegmentFill(
    order: IOrder,
    segStart: number,
    segEnd: number,
    candleTime: number,
    symbol: string,
    model?: FillModel,
    slippageConfig?: ISlippageConfig,
    feeConfig?: IFeeConfig,
    spreadConfig?: ISpreadConfig,
    costStressConfig?: ExecutionCostStressConfig,
    partialFillRatio?: number,
  ): { isFilled: boolean; fill?: IFill; reason?: string } {
    if (order.status !== 'PENDING' && order.status !== 'PARTIALLY_FILLED') {
      return { isFilled: false, reason: `ORDER_${order.status}` };
    }

    const minPrice = Math.min(segStart, segEnd);
    const maxPrice = Math.max(segStart, segEnd);

    // 1. STOP Order
    if (order.orderType === 'STOP' && order.stopPrice !== undefined) {
      const stopPrice = order.stopPrice;
      const isTriggered =
        order.side === 'SELL' ? minPrice <= stopPrice : maxPrice >= stopPrice;

      if (!isTriggered) return { isFilled: false };

      const basePrice = this.calculateStopBasePrice(order.side, stopPrice, segStart);
      const fill = this.buildFill(order, basePrice, candleTime, symbol, 'STOP', undefined, model, slippageConfig, feeConfig, spreadConfig, costStressConfig, partialFillRatio);
      return { isFilled: true, fill };
    }

    // 2. LIMIT Order
    if (order.orderType === 'LIMIT' && order.price !== undefined) {
      const targetPrice = order.price;
      const isTouch =
        order.side === 'BUY' ? minPrice <= targetPrice : maxPrice >= targetPrice;

      if (!isTouch) return { isFilled: false };

      const rawPrice = this.calculateLimitBasePrice(order.side, targetPrice, segStart);
      const fill = this.buildFill(order, rawPrice, candleTime, symbol, 'LIMIT', undefined, model, slippageConfig, feeConfig, spreadConfig, costStressConfig, partialFillRatio);
      return { isFilled: true, fill };
    }

    // 3. MARKET Order
    if (order.orderType === 'MARKET') {
      const fill = this.buildFill(order, segStart, candleTime, symbol, 'MARKET', undefined, model, slippageConfig, feeConfig, spreadConfig, costStressConfig, partialFillRatio);
      return { isFilled: true, fill };
    }

    return { isFilled: false };
  }

  /**
   * Evaluates order against current candle using configured FillModel
   */
  static evaluateFill(
    order: IOrder,
    currentCandle: ICandle,
    nextCandle?: ICandle,
    model: FillModel = FillModel.OHLC_PATH,
    lowerTfCandles?: ICandle[],
    parentDurationMs?: number,
    slippageConfig?: ISlippageConfig,
    feeConfig?: IFeeConfig,
    spreadConfig?: ISpreadConfig,
    costStressConfig?: ExecutionCostStressConfig,
    partialFillRatio?: number,
  ): { isFilled: boolean; fill?: IFill; reason?: string } {
    if (order.status === 'FILLED' || order.status === 'CANCELLED' || order.status === 'REJECTED') {
      return { isFilled: false, reason: `ORDER_${order.status}` };
    }

    // Lower-timeframe orchestration belongs exclusively to ExecutionSimulator.processCandle()
    if (model === FillModel.LOWER_TIMEFRAME) {
      const subValidation = this.validateSubBars(currentCandle, lowerTfCandles, parentDurationMs);
      if (!subValidation.isValid) {
        return { isFilled: false, reason: subValidation.reason || 'MISSING_LOWER_TF_DATA' };
      }
      return { isFilled: false, reason: 'LOWER_TIMEFRAME_REQUIRES_EXECUTION_SIMULATOR' };
    }

    const candleTime = this.requireCandleTimestamp(currentCandle);

    // 1. STOP Orders (Stop Loss / Trailing Stop) with Gap-Through-Stop Execution
    if (order.orderType === 'STOP' && order.stopPrice !== undefined) {
      const stopPrice = order.stopPrice;
      const isTriggered =
        order.side === 'SELL'
          ? currentCandle.low <= stopPrice
          : currentCandle.high >= stopPrice;

      if (!isTriggered) return { isFilled: false };

      const basePrice = this.calculateStopBasePrice(order.side, stopPrice, currentCandle.open);
      const fill = this.buildFill(order, basePrice, candleTime, order.symbol, 'STOP', currentCandle, model, slippageConfig, feeConfig, spreadConfig, costStressConfig, partialFillRatio);
      return { isFilled: true, fill };
    }

    // 2. Limit Order Models with Gap-Through-TP Execution
    if (order.orderType === 'LIMIT' && order.price !== undefined) {
      const targetPrice = order.price;
      const isTouch =
        order.side === 'BUY' ? currentCandle.low <= targetPrice : currentCandle.high >= targetPrice;

      if (!isTouch) return { isFilled: false };

      const rawPrice = this.calculateLimitBasePrice(order.side, targetPrice, currentCandle.open);
      const fill = this.buildFill(order, rawPrice, candleTime, order.symbol, 'LIMIT', currentCandle, model, slippageConfig, feeConfig, spreadConfig, costStressConfig, partialFillRatio);
      return { isFilled: true, fill };
    }

    // 3. Next Bar Market Model for MARKET Orders
    if (model === FillModel.NEXT_BAR_MARKET) {
      if (!nextCandle) return { isFilled: false, reason: 'AWAITING_NEXT_BAR' };
      const rawPrice = nextCandle.open;
      const fillTime = this.requireCandleTimestamp(nextCandle);
      const fill = this.buildFill(order, rawPrice, fillTime, order.symbol, 'MARKET', nextCandle, model, slippageConfig, feeConfig, spreadConfig, costStressConfig, partialFillRatio);
      return { isFilled: true, fill };
    }

    // 4. Default Market Order Model (Current Bar Open)
    if (order.orderType === 'MARKET') {
      const rawPrice = currentCandle.open;
      const fill = this.buildFill(order, rawPrice, candleTime, order.symbol, 'MARKET', currentCandle, model, slippageConfig, feeConfig, spreadConfig, costStressConfig, partialFillRatio);
      return { isFilled: true, fill };
    }

    return { isFilled: false };
  }
}
