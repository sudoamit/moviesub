import { FillModel, IOrder, IFill, OrderSide } from './types';
import { ICandle } from '@quant/shared';
import { SlippageModel } from './slippage-model';
import { FeeModel } from './fee-model';
import { SpreadModel } from './spread-model';

export class FillModelEngine {
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
      return { isFilled: false };
    }

    const candleTime = currentCandle.timestamp instanceof Date
      ? currentCandle.timestamp.getTime()
      : typeof currentCandle.timestamp === 'number'
        ? currentCandle.timestamp
        : Date.now();

    // 1. Lower Timeframe Resolution (1m sub-bars)
    if (model === FillModel.LOWER_TIMEFRAME && lowerTfCandles && lowerTfCandles.length > 0) {
      for (const m1 of lowerTfCandles) {
        const res = this.evaluateFill(order, m1, undefined, FillModel.OHLC_PATH);
        if (res.isFilled) return res;
      }
      return { isFilled: false };
    }

    // 2. Next Bar Market Model
    if (model === FillModel.NEXT_BAR_MARKET) {
      if (!nextCandle) return { isFilled: false };
      const rawPrice = nextCandle.open;
      const slip = SlippageModel.calculateSlippage(rawPrice, order.quantity, order.side, 'MARKET', nextCandle);
      const halfSpread = SpreadModel.getHalfSpread(slip.executedPrice, order.symbol);
      const finalPrice = order.side === 'BUY' ? slip.executedPrice + halfSpread : slip.executedPrice - halfSpread;
      const fee = FeeModel.calculateFees(order.symbol, finalPrice, order.quantity, order.side, false);

      const fillTime = nextCandle.timestamp instanceof Date ? nextCandle.timestamp.getTime() : candleTime;
      const fill: IFill = {
        fillId: `fill_${order.orderId}_${fillTime}`,
        orderId: order.orderId,
        tradeId: order.tradeId,
        symbol: order.symbol,
        side: order.side,
        price: Number(finalPrice.toFixed(4)),
        quantity: order.quantity,
        fee,
        slippage: slip.slippageAmount,
        timestamp: fillTime,
        isPartial: false,
      };
      return { isFilled: true, fill };
    }

    // 3. Limit Order Models
    if (order.orderType === 'LIMIT' && order.price !== undefined) {
      const targetPrice = order.price;
      const isTouch =
        order.side === 'BUY'
          ? currentCandle.low <= targetPrice
          : currentCandle.high >= targetPrice;

      if (!isTouch) {
        return { isFilled: false };
      }

      const rawPrice = targetPrice;
      const slip =
        model === FillModel.LIMIT_WITH_SLIPPAGE
          ? SlippageModel.calculateSlippage(rawPrice, order.quantity, order.side, 'LIMIT', currentCandle)
          : { executedPrice: rawPrice, slippageAmount: 0 };

      const fee = FeeModel.calculateFees(order.symbol, slip.executedPrice, order.quantity, order.side, true);

      const fill: IFill = {
        fillId: `fill_${order.orderId}_${candleTime}`,
        orderId: order.orderId,
        tradeId: order.tradeId,
        symbol: order.symbol,
        side: order.side,
        price: Number(slip.executedPrice.toFixed(4)),
        quantity: order.quantity,
        fee,
        slippage: slip.slippageAmount,
        timestamp: candleTime,
        isPartial: false,
      };
      return { isFilled: true, fill };
    }

    // 4. Default OHLC Path Market/Stop Order Model
    if (order.orderType === 'MARKET') {
      const rawPrice = currentCandle.open;
      const slip = SlippageModel.calculateSlippage(rawPrice, order.quantity, order.side, 'MARKET', currentCandle);
      const halfSpread = SpreadModel.getHalfSpread(slip.executedPrice, order.symbol);
      const finalPrice = order.side === 'BUY' ? slip.executedPrice + halfSpread : slip.executedPrice - halfSpread;
      const fee = FeeModel.calculateFees(order.symbol, finalPrice, order.quantity, order.side, false);

      const fill: IFill = {
        fillId: `fill_${order.orderId}_${candleTime}`,
        orderId: order.orderId,
        tradeId: order.tradeId,
        symbol: order.symbol,
        side: order.side,
        price: Number(finalPrice.toFixed(4)),
        quantity: order.quantity,
        fee,
        slippage: slip.slippageAmount,
        timestamp: candleTime,
        isPartial: false,
      };
      return { isFilled: true, fill };
    }

    return { isFilled: false };
  }
}
