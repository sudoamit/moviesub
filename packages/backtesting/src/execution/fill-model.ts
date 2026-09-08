import { FillModel, IFill, IOrder, OrderSide, SameCandleAmbiguityMode } from './types';
import { ICandle } from '@quant/shared';
import { SlippageModel } from './slippage-model';
import { FeeModel } from './fee-model';
import { SpreadModel } from './spread-model';

export class FillModelEngine {
  /**
   * Validates lower timeframe sub-bars strictly against parent candle range and chronological ordering
   */
  static validateSubBars(
    parentCandle: ICandle,
    lowerTfCandles?: ICandle[],
    parentDurationMs: number = 60 * 60 * 1000,
  ): { isValid: boolean; reason?: string } {
    if (!lowerTfCandles || lowerTfCandles.length === 0) {
      return { isValid: false, reason: 'MISSING_LOWER_TF_DATA' };
    }

    const parentOpenTime =
      parentCandle.timestamp instanceof Date
        ? parentCandle.timestamp.getTime()
        : new Date(parentCandle.timestamp).getTime();

    const parentCloseTime = parentOpenTime + parentDurationMs;

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

      // Check strict ascending chronological order
      if (prevTime >= 0 && subTime <= prevTime) {
        return { isValid: false, reason: 'SUBBARS_OUT_OF_ORDER' };
      }
      prevTime = subTime;
    }

    return { isValid: true };
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
  ): { winningFill?: IFill; winningOrder?: IOrder; reason?: string } {
    // Evaluate fills for all orders against candle
    const triggered: { order: IOrder; fill: IFill }[] = [];

    for (const order of orders) {
      const res = this.evaluateFill(order, currentCandle, nextCandle, model, lowerTfCandles);
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
      const isBullish = currentCandle.close >= currentCandle.open;
      const isLong = triggered[0].order.side === 'SELL'; // Long position exit order side is SELL

      if (isBullish) {
        // Bullish candle path: Open -> Low -> High -> Close
        // Low touched first
        const stopTrigger = triggered.find((t) => t.order.orderType === 'STOP');
        const limitTrigger = triggered.find((t) => t.order.orderType === 'LIMIT');
        const winner = isLong ? (stopTrigger || limitTrigger) : (limitTrigger || stopTrigger);
        return { winningFill: winner?.fill, winningOrder: winner?.order, reason: 'OHLC_PATH_BULLISH' };
      } else {
        // Bearish candle path: Open -> High -> Low -> Close
        // High touched first
        const stopTrigger = triggered.find((t) => t.order.orderType === 'STOP');
        const limitTrigger = triggered.find((t) => t.order.orderType === 'LIMIT');
        const winner = isLong ? (limitTrigger || stopTrigger) : (stopTrigger || limitTrigger);
        return { winningFill: winner?.fill, winningOrder: winner?.order, reason: 'OHLC_PATH_BEARISH' };
      }
    }

    if (ambiguityMode === SameCandleAmbiguityMode.LOWER_TIMEFRAME) {
      const subValidation = this.validateSubBars(currentCandle, lowerTfCandles);
      if (!subValidation.isValid) {
        return { reason: subValidation.reason || 'MISSING_LOWER_TF_DATA' };
      }

      for (const m1 of lowerTfCandles!) {
        for (const t of triggered) {
          const res = this.evaluateFill(t.order, m1, undefined, FillModel.OHLC_PATH);
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
   * Evaluates order against current candle using configured FillModel
   */
  static evaluateFill(
    order: IOrder,
    currentCandle: ICandle,
    nextCandle?: ICandle,
    model: FillModel = FillModel.OHLC_PATH,
    lowerTfCandles?: ICandle[],
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
    if (model === FillModel.LOWER_TIMEFRAME || order.ambiguityMode === SameCandleAmbiguityMode.LOWER_TIMEFRAME) {
      const subValidation = this.validateSubBars(currentCandle, lowerTfCandles);
      if (!subValidation.isValid) {
        return { isFilled: false, reason: subValidation.reason || 'MISSING_LOWER_TF_DATA' };
      }
      for (const m1 of lowerTfCandles!) {
        const res = this.evaluateFill(order, m1, undefined, FillModel.OHLC_PATH);
        if (res.isFilled) return res;
      }
      return { isFilled: false };
    }

    // 2. Next Bar Market Model
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

    // 3. STOP Orders (Stop Loss / Trailing Stop) with Gap-Through-Stop Execution
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

    // 4. Limit Order Models with Gap-Through-TP Execution
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

    // 5. Default Market Order Model
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
