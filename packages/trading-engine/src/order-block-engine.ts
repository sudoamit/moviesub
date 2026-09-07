import { Direction, IBreakOfStructure, ICandle, IFairValueGap, IOrderBlock } from '@quant/shared';
import { calculateATR } from '@quant/indicators';
import { CandleNormalizer } from './candle-normalizer';

export interface IOrderBlockOptions {
  displacementThresholdAtr?: number;
  asOfTimestamp?: Date;
}

export class OrderBlockEngine {
  /**
   * Identifies institutional Order Blocks preceding structure breaks and displacement legs
   * with strictly zero look-ahead bias and explicit point-in-time lifecycles.
   */
  static detectOrderBlocks(
    rawCandles: ICandle[],
    bosList: IBreakOfStructure[] = [],
    fvgList: IFairValueGap[] = [],
    options: IOrderBlockOptions = {},
  ): { allOrderBlocks: IOrderBlock[]; activeOrderBlocks: IOrderBlock[] } {
    if (!rawCandles || rawCandles.length < 4) {
      return { allOrderBlocks: [], activeOrderBlocks: [] };
    }

    let candles = CandleNormalizer.normalize(rawCandles);
    if (options.asOfTimestamp) {
      candles = CandleNormalizer.getClosedCandlesAsOf(candles, undefined, options.asOfTimestamp);
    }

    if (candles.length < 4) {
      return { allOrderBlocks: [], activeOrderBlocks: [] };
    }

    const displacementThreshold = options.displacementThresholdAtr ?? 1.2;
    const atr = calculateATR(candles, 14);
    const orderBlocks: IOrderBlock[] = [];

    // 1. Identify Order Block candidates and require confirmation window (i + 3)
    for (let i = 0; i <= candles.length - 4; i++) {
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

        // Check if a BOS or FVG was created in this subsequent confirmation window
        const createdBOS = bosList.some(
          (b) =>
            b.direction === Direction.BULLISH && b.candleIndex >= i + 1 && b.candleIndex <= i + 3,
        );
        const createdFVG = fvgList.some(
          (f) =>
            f.direction === Direction.BULLISH && f.candleIndex >= i + 1 && f.candleIndex <= i + 3,
        );

        if (hasDisplacement && (createdBOS || createdFVG || maxUpMove >= candleAtr * 1.5)) {
          const confirmedAtIndex = i + 3;
          orderBlocks.push({
            id: `ob-bull-${i}`,
            direction: Direction.BULLISH,
            high: candle.high,
            low: candle.low,
            candleIndex: i,
            timestamp: new Date(candle.timestamp),
            createdAt: new Date(candle.timestamp),
            confirmedAtIndex,
            confirmedAtTimestamp: new Date(next3.timestamp),
            isMitigated: false,
            isInvalidated: false,
            status: 'ACTIVE',
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
          const confirmedAtIndex = i + 3;
          orderBlocks.push({
            id: `ob-bear-${i}`,
            direction: Direction.BEARISH,
            high: candle.high,
            low: candle.low,
            candleIndex: i,
            timestamp: new Date(candle.timestamp),
            createdAt: new Date(candle.timestamp),
            confirmedAtIndex,
            confirmedAtTimestamp: new Date(next3.timestamp),
            isMitigated: false,
            isInvalidated: false,
            status: 'ACTIVE',
            strength: createdBOS ? 2.0 : 1.5,
          });
        }
      }
    }

    // 2. Track mitigation and invalidation incrementally over subsequent candles starting after confirmation window
    for (const ob of orderBlocks) {
      for (let k = ob.candleIndex + 4; k < candles.length; k++) {
        const c = candles[k];
        const cTime = new Date(c.timestamp);

        if (ob.direction === Direction.BULLISH) {
          // Bullish OB mitigated when price enters the OB zone
          if (c.low <= ob.high && !ob.isMitigated) {
            ob.isMitigated = true;
            ob.status = 'MITIGATED';
            ob.mitigatedAtIndex = k;
            ob.mitigatedAtTimestamp = cTime;
          }
          // Invalidated if price closes below OB low
          if (c.close < ob.low) {
            ob.isInvalidated = true;
            ob.status = 'INVALIDATED';
            ob.invalidatedAtIndex = k;
            ob.invalidatedAtTimestamp = cTime;
            break;
          }
        } else {
          // Bearish OB mitigated when price enters the OB zone
          if (c.high >= ob.low && !ob.isMitigated) {
            ob.isMitigated = true;
            ob.status = 'MITIGATED';
            ob.mitigatedAtIndex = k;
            ob.mitigatedAtTimestamp = cTime;
          }
          // Invalidated if price closes above OB high
          if (c.close > ob.high) {
            ob.isInvalidated = true;
            ob.status = 'INVALIDATED';
            ob.invalidatedAtIndex = k;
            ob.invalidatedAtTimestamp = cTime;
            break;
          }
        }
      }
    }

    const activeOrderBlocks = orderBlocks.filter((ob) => !ob.isMitigated && !ob.isInvalidated);
    return { allOrderBlocks: orderBlocks, activeOrderBlocks };
  }
}
