import { FillModel, IFill, IOrder, OrderSide, SameCandleAmbiguityMode } from './types';
import { ICandle } from '@quant/shared';
import { SlippageModel } from './slippage-model';
import { FeeModel } from './fee-model';
import { SpreadModel } from './spread-model';
import { OHLCPathCursor } from './ohlc-path-cursor';

export class FillModelEngine {
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

    const parentOpenTime =
      parentCandle.timestamp instanceof Date
        ? parentCandle.timestamp.getTime()
        : new Date(parentCandle.timestamp).getTime();

    const parentCloseTime = parentOpenTime + parentDurationMs;

    const firstTime =
      lowerTfCandles[0].timestamp instanceof Date
        ? lowerTfCandles[0].timestamp.getTime()
        : new Date(lowerTfCandles[0].timestamp).getTime();

    // Check first bar starts at parent open time
    if (firstTime !== parentOpenTime && !allowPartial) {
      return { isValid: false, reason: 'SUBBAR_START_TIME_MISMATCH' };
    }

    let prevTime = -1;
    for (const sub of lowerTfCandles) {
      const subTime =
        sub.timestamp instanceof Date
          ? sub.timestamp.getTime()
          : new Date(sub.timestamp).getTime();

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
    const lastTime =
      lowerTfCandles[lowerTfCandles.length - 1].timestamp instanceof Date
        ? lowerTfCandles[lowerTfCandles.length - 1].timestamp.getTime()
        : new Date(lowerTfCandles[lowerTfCandles.length - 1].timestamp).getTime();

    const subStepMs =
      lowerTfCandles.length >= 2
        ? (lowerTfCandles[1].timestamp instanceof Date
            ? lowerTfCandles[1].timestamp.getTime()
            : new Date(lowerTfCandles[1].timestamp).getTime()) - firstTime
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
      const currTime =
        lowerTfCandles[i].timestamp instanceof Date
          ? lowerTfCandles[i].timestamp.getTime()
          : new Date(lowerTfCandles[i].timestamp).getTime();

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
   * Authoritative centralized Same-Candle Ambiguity Conflict Resolver
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
    // Evaluate fills for all orders against candle
    const triggered: { order: IOrder; fill: IFill }[] = [];

    for (const order of orders) {
      const res = this.evaluateFill(order, currentCandle, nextCandle, model, lowerTfCandles, parentDurationMs);
      if (res.isFilled && res.fill) {
        triggered.push({ order, fill: res.fill });
      }
    }

    if (triggered.length === 0) {
      return {};
    }

    if (triggered.length === 1) {
      return { winningFill: triggered[0].fill, winningOrder: triggered[0].order };
    }

    // Multiple orders triggered on same candle -> Resolve via Ambiguity Mode
    if (ambiguityMode === SameCandleAmbiguityMode.CONSERVATIVE) {
      const stopTrigger = triggered.find((t) => t.order.orderType === 'STOP');
      if (stopTrigger) {
        return { winningFill: stopTrigger.fill, winningOrder: stopTrigger.order, reason: 'CONSERVATIVE_STOP_FIRST' };
      }
      return { winningFill: triggered[0].fill, winningOrder: triggered[0].order };
    }

    if (ambiguityMode === SameCandleAmbiguityMode.OPTIMISTIC) {
      const limitTrigger = triggered.find((t) => t.order.orderType === 'LIMIT');
      if (limitTrigger) {
        return { winningFill: limitTrigger.fill, winningOrder: limitTrigger.order, reason: 'OPTIMISTIC_TARGET_FIRST' };
      }
      return { winningFill: triggered[0].fill, winningOrder: triggered[0].order };
    }

    if (ambiguityMode === SameCandleAmbiguityMode.OHLC_PATH) {
      const cursor = new OHLCPathCursor(currentCandle);
      const candleTime =
        currentCandle.timestamp instanceof Date
          ? currentCandle.timestamp.getTime()
          : new Date(currentCandle.timestamp).getTime();

      for (const seg of cursor.segments) {
        const segmentTriggered: { order: IOrder; fill: IFill }[] = [];
        for (const t of triggered) {
          const res = this.evaluateSegmentFill(
            t.order,
            seg.start,
            seg.end,
            candleTime,
            t.order.symbol,
          );
          if (res.isFilled && res.fill) {
            segmentTriggered.push({ order: t.order, fill: res.fill });
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

      return { winningFill: triggered[0].fill, winningOrder: triggered[0].order };
    }

    if (ambiguityMode === SameCandleAmbiguityMode.LOWER_TIMEFRAME) {
      const subValidation = this.validateSubBars(currentCandle, lowerTfCandles, parentDurationMs);
      if (!subValidation.isValid) {
        return { reason: subValidation.reason || 'MISSING_LOWER_TF_DATA' };
      }

      for (const m1 of lowerTfCandles!) {
        for (const t of triggered) {
          const res = this.evaluateFill(t.order, m1, undefined, FillModel.OHLC_PATH, undefined, parentDurationMs);
          if (res.isFilled && res.fill) {
            return { winningFill: res.fill, winningOrder: t.order, reason: 'LOWER_TIMEFRAME_SUBBAR_MATCH' };
          }
        }
      }
      return { reason: 'MISSING_LOWER_TF_DATA' };
    }

    return { winningFill: triggered[0].fill, winningOrder: triggered[0].order };
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
  ): { isFilled: boolean; fill?: IFill } {
    if (order.status !== 'PENDING') return { isFilled: false };

    const minPrice = Math.min(segStart, segEnd);
    const maxPrice = Math.max(segStart, segEnd);

    // 1. STOP Order
    if (order.orderType === 'STOP' && order.stopPrice !== undefined) {
      const stopPrice = order.stopPrice;
      const isTriggered =
        order.side === 'SELL' ? minPrice <= stopPrice : maxPrice >= stopPrice;

      if (!isTriggered) return { isFilled: false };

      let basePrice = stopPrice;
      if (order.side === 'SELL' && segStart <= stopPrice) {
        basePrice = segStart;
      } else if (order.side === 'BUY' && segStart >= stopPrice) {
        basePrice = segStart;
      }

      const fillQty = order.remainingQuantity > 0 ? order.remainingQuantity : order.quantity;
      const slip = SlippageModel.calculateSlippage(basePrice, fillQty, order.side, 'STOP');
      const halfSpread = SpreadModel.getHalfSpread(slip.executedPrice, symbol);
      const finalPrice = order.side === 'BUY' ? slip.executedPrice + halfSpread : slip.executedPrice - halfSpread;
      const fee = FeeModel.calculateFees(symbol, finalPrice, fillQty, order.side, true);

      const fill: IFill = {
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
        isPartial: false,
        exitTarget: order.exitTarget,
      };

      return { isFilled: true, fill };
    }

    // 2. LIMIT Order
    if (order.orderType === 'LIMIT' && order.price !== undefined) {
      const targetPrice = order.price;
      const isTouch =
        order.side === 'BUY' ? minPrice <= targetPrice : maxPrice >= targetPrice;

      if (!isTouch) return { isFilled: false };

      let rawPrice = targetPrice;
      if (order.side === 'SELL' && segStart >= targetPrice) {
        rawPrice = segStart;
      } else if (order.side === 'BUY' && segStart <= targetPrice) {
        rawPrice = segStart;
      }

      const fillQty = order.remainingQuantity > 0 ? order.remainingQuantity : order.quantity;
      const slip = SlippageModel.calculateSlippage(rawPrice, fillQty, order.side, 'LIMIT');
      const halfSpread = SpreadModel.getHalfSpread(slip.executedPrice, symbol);
      const finalPrice = order.side === 'BUY' ? slip.executedPrice + halfSpread : slip.executedPrice - halfSpread;
      const fee = FeeModel.calculateFees(symbol, finalPrice, fillQty, order.side, false);

      const fill: IFill = {
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
        isPartial: false,
        exitTarget: order.exitTarget,
      };

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
  ): { isFilled: boolean; fill?: IFill; reason?: string } {
    if (order.status === 'FILLED' || order.status === 'CANCELLED' || order.status === 'REJECTED') {
      return { isFilled: false, reason: `ORDER_${order.status}` };
    }

    const candleTime =
      currentCandle.timestamp instanceof Date
        ? currentCandle.timestamp.getTime()
        : typeof currentCandle.timestamp === 'number'
          ? currentCandle.timestamp
          : Date.now();

    // 1. Lower Timeframe Resolution (1m sub-bars) - FAIL CLOSED IF MISSING/INVALID
    if (
      model === FillModel.LOWER_TIMEFRAME ||
      (order.ambiguityMode === SameCandleAmbiguityMode.LOWER_TIMEFRAME && lowerTfCandles !== undefined)
    ) {
      const subValidation = this.validateSubBars(currentCandle, lowerTfCandles, parentDurationMs);
      if (!subValidation.isValid) {
        return { isFilled: false, reason: subValidation.reason || 'MISSING_LOWER_TF_DATA' };
      }
      for (const m1 of lowerTfCandles!) {
        const res = this.evaluateFill(order, m1, undefined, FillModel.OHLC_PATH, undefined, parentDurationMs);
        if (res.isFilled) return res;
      }
      return { isFilled: false };
    }

    // 2. STOP Orders (Stop Loss / Trailing Stop) with Gap-Through-Stop Execution
    if (order.orderType === 'STOP' && order.stopPrice !== undefined) {
      const stopPrice = order.stopPrice;
      const isTriggered =
        order.side === 'SELL'
          ? currentCandle.low <= stopPrice
          : currentCandle.high >= stopPrice;

      if (!isTriggered) {
        return { isFilled: false };
      }

      // Gap-through-stop pricing
      let basePrice = stopPrice;
      if (order.side === 'SELL' && currentCandle.open <= stopPrice) {
        basePrice = currentCandle.open; // Gap down open price
      } else if (order.side === 'BUY' && currentCandle.open >= stopPrice) {
        basePrice = currentCandle.open; // Gap up open price
      }

      const fillQty = order.remainingQuantity > 0 ? order.remainingQuantity : order.quantity;
      const slip = SlippageModel.calculateSlippage(
        basePrice,
        fillQty,
        order.side,
        'MARKET',
        currentCandle,
      );
      const halfSpread = SpreadModel.getHalfSpread(slip.executedPrice, order.symbol);
      const finalPrice =
        order.side === 'BUY' ? slip.executedPrice + halfSpread : slip.executedPrice - halfSpread;
      const fee = FeeModel.calculateFees(
        order.symbol,
        finalPrice,
        fillQty,
        order.side,
        false,
      );

      const fill: IFill = {
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
        isPartial: false,
        exitTarget: order.exitTarget,
      };
      return { isFilled: true, fill };
    }

    // 3. Limit Order Models with Gap-Through-TP Execution
    if (order.orderType === 'LIMIT' && order.price !== undefined) {
      const targetPrice = order.price;
      const isTouch =
        order.side === 'BUY' ? currentCandle.low <= targetPrice : currentCandle.high >= targetPrice;

      if (!isTouch) {
        return { isFilled: false };
      }

      // Gap-through-TP pricing
      let rawPrice = targetPrice;
      if (order.side === 'SELL' && currentCandle.open >= targetPrice) {
        rawPrice = currentCandle.open; // Gap up open price
      } else if (order.side === 'BUY' && currentCandle.open <= targetPrice) {
        rawPrice = currentCandle.open; // Gap down open price
      }

      const fillQty = order.remainingQuantity > 0 ? order.remainingQuantity : order.quantity;
      const slip =
        model === FillModel.LIMIT_WITH_SLIPPAGE
          ? SlippageModel.calculateSlippage(
              rawPrice,
              fillQty,
              order.side,
              'LIMIT',
              currentCandle,
            )
          : { executedPrice: rawPrice, slippageAmount: 0 };

      const fee = FeeModel.calculateFees(
        order.symbol,
        slip.executedPrice,
        fillQty,
        order.side,
        true,
      );

      const fill: IFill = {
        fillId: `fill_${order.orderId}_${candleTime}`,
        orderId: order.orderId,
        tradeId: order.tradeId,
        symbol: order.symbol,
        side: order.side,
        price: Number(slip.executedPrice.toFixed(4)),
        quantity: fillQty,
        fee,
        slippage: slip.slippageAmount,
        timestamp: candleTime,
        isPartial: false,
        exitTarget: order.exitTarget,
      };
      return { isFilled: true, fill };
    }

    // 4. Next Bar Market Model for MARKET Orders
    if (model === FillModel.NEXT_BAR_MARKET) {
      if (!nextCandle) return { isFilled: false, reason: 'AWAITING_NEXT_BAR' };
      const rawPrice = nextCandle.open;
      const fillQty = order.remainingQuantity > 0 ? order.remainingQuantity : order.quantity;
      const slip = SlippageModel.calculateSlippage(
        rawPrice,
        fillQty,
        order.side,
        'MARKET',
        nextCandle,
      );
      const halfSpread = SpreadModel.getHalfSpread(slip.executedPrice, order.symbol);
      const finalPrice =
        order.side === 'BUY' ? slip.executedPrice + halfSpread : slip.executedPrice - halfSpread;
      const fee = FeeModel.calculateFees(
        order.symbol,
        finalPrice,
        fillQty,
        order.side,
        false,
      );

      const fillTime =
        nextCandle.timestamp instanceof Date ? nextCandle.timestamp.getTime() : candleTime;
      const fill: IFill = {
        fillId: `fill_${order.orderId}_${fillTime}`,
        orderId: order.orderId,
        tradeId: order.tradeId,
        symbol: order.symbol,
        side: order.side,
        price: Number(finalPrice.toFixed(4)),
        quantity: fillQty,
        fee,
        slippage: slip.slippageAmount,
        timestamp: fillTime,
        isPartial: false,
        exitTarget: order.exitTarget,
      };
      return { isFilled: true, fill };
    }

    // 5. Default Market Order Model (Current Bar Open)
    if (order.orderType === 'MARKET') {
      const rawPrice = currentCandle.open;
      const fillQty = order.remainingQuantity > 0 ? order.remainingQuantity : order.quantity;
      const slip = SlippageModel.calculateSlippage(
        rawPrice,
        fillQty,
        order.side,
        'MARKET',
        currentCandle,
      );
      const halfSpread = SpreadModel.getHalfSpread(slip.executedPrice, order.symbol);
      const finalPrice =
        order.side === 'BUY' ? slip.executedPrice + halfSpread : slip.executedPrice - halfSpread;
      const fee = FeeModel.calculateFees(
        order.symbol,
        finalPrice,
        fillQty,
        order.side,
        false,
      );

      const fill: IFill = {
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
        isPartial: false,
        exitTarget: order.exitTarget,
      };
      return { isFilled: true, fill };
    }

    return { isFilled: false };
  }
}
