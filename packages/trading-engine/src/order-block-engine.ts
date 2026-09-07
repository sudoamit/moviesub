import { Direction, IBreakOfStructure, ICandle, IFairValueGap, IOrderBlock } from '@quant/shared';
import { calculateATR } from '@quant/indicators';

export interface IOrderBlockOptions {
  displacementThresholdAtr?: number;
}

export class OrderBlockEngine {
  /**
   * Identifies institutional Order Blocks preceding structure breaks and displacement legs
   */
  static detectOrderBlocks(
    candles: ICandle[],
    bosList: IBreakOfStructure[] = [],
    fvgList: IFairValueGap[] = [],
    options: IOrderBlockOptions = {},
  ): { allOrderBlocks: IOrderBlock[]; activeOrderBlocks: IOrderBlock[] } {
    if (!candles || candles.length < 5) {
      return { allOrderBlocks: [], activeOrderBlocks: [] };
    }

    const displacementThreshold = options.displacementThresholdAtr ?? 1.2;
    const atr = calculateATR(candles, 14);
    const orderBlocks: IOrderBlock[] = [];

    for (let i = 0; i < candles.length - 3; i++) {
      const candle = candles[i];
      const candleAtr = atr[i] || Math.max(1, candle.high - candle.low);
      const isBearishCandle = candle.close < candle.open;
      const isBullishCandle = candle.close > candle.open;

      // Check subsequent 3 candles for rapid expansion (displacement)
      const next1 = candles[i + 1];
      const next2 = candles[i + 2];
      const next3 = candles[i + 3];

      // 1. Bullish Order Block candidate: Bearish candle followed by rapid upward impulse
      if (isBearishCandle) {
        const maxUpMove = Math.max(next1.high, next2.high, next3.high) - candle.low;
        const hasDisplacement = maxUpMove >= candleAtr * displacementThreshold;

        // Check if a BOS or FVG was created in this subsequent window
        const createdBOS = bosList.some(
          (b) =>
            b.direction === Direction.BULLISH && b.candleIndex >= i + 1 && b.candleIndex <= i + 3,
        );
        const createdFVG = fvgList.some(
          (f) =>
            f.direction === Direction.BULLISH && f.candleIndex >= i + 1 && f.candleIndex <= i + 3,
        );

        if (hasDisplacement && (createdBOS || createdFVG || maxUpMove >= candleAtr * 1.5)) {
          orderBlocks.push({
            id: `ob-bull-${i}`,
            direction: Direction.BULLISH,
            high: candle.high,
            low: candle.low,
            candleIndex: i,
            timestamp: candle.timestamp,
            isMitigated: false,
            isInvalidated: false,
            strength: createdBOS ? 2.0 : 1.5,
          });
        }
      }

      // 2. Bearish Order Block candidate: Bullish candle followed by rapid downward impulse
      if (isBullishCandle) {
        const maxDownMove = candle.high - Math.min(next1.low, next2.low, next3.low);
        const hasDisplacement = maxDownMove >= candleAtr * displacementThreshold;

        const createdBOS = bosList.some(
          (b) =>
            b.direction === Direction.BEARISH && b.candleIndex >= i + 1 && b.candleIndex <= i + 3,
        );
        const createdFVG = fvgList.some(
          (f) =>
            f.direction === Direction.BEARISH && f.candleIndex >= i + 1 && f.candleIndex <= i + 3,
        );

        if (hasDisplacement && (createdBOS || createdFVG || maxDownMove >= candleAtr * 1.5)) {
          orderBlocks.push({
            id: `ob-bear-${i}`,
            direction: Direction.BEARISH,
            high: candle.high,
            low: candle.low,
            candleIndex: i,
            timestamp: candle.timestamp,
            isMitigated: false,
            isInvalidated: false,
            strength: createdBOS ? 2.0 : 1.5,
          });
        }
      }
    }

    // Track mitigation and invalidation over remaining candles
    for (const ob of orderBlocks) {
      for (let k = ob.candleIndex + 4; k < candles.length; k++) {
        const c = candles[k];

        if (ob.direction === Direction.BULLISH) {
          // Bullish OB mitigated when price enters the OB zone
          if (c.low <= ob.high && !ob.isMitigated) {
            ob.isMitigated = true;
            ob.mitigatedAtIndex = k;
          }
          // Invalidated if price closes below OB low
          if (c.close < ob.low) {
            ob.isInvalidated = true;
            break;
          }
        } else {
          // Bearish OB mitigated when price enters the OB zone
          if (c.high >= ob.low && !ob.isMitigated) {
            ob.isMitigated = true;
            ob.mitigatedAtIndex = k;
          }
          // Invalidated if price closes above OB high
          if (c.close > ob.high) {
            ob.isInvalidated = true;
            break;
          }
        }
      }
    }

    const activeOrderBlocks = orderBlocks.filter((ob) => !ob.isMitigated && !ob.isInvalidated);
    return { allOrderBlocks: orderBlocks, activeOrderBlocks };
  }
}
