import { Direction, IBreakOfStructure, ICandle, IFairValueGap, IOrderBlock } from '@quant/shared';
import { calculateATR } from '@quant/indicators';
import { CandleNormalizer } from './candle-normalizer';
import { DisplacementEngine } from './displacement';

export interface IOrderBlockOptions {
  displacementThresholdAtr?: number;
  asOfTimestamp?: Date;
  timeframe?: string;
  minDisplacementScore?: number;
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

    const { closedCandles: candles } = CandleNormalizer.partitionCandles(rawCandles, {
      asOfTimestamp: options.asOfTimestamp,
      timeframe: options.timeframe,
    });

    if (candles.length < 4) {
      return { allOrderBlocks: [], activeOrderBlocks: [] };
    }

    const displacementThreshold = options.displacementThresholdAtr ?? 1.2;
    const minDisplacementScore = options.minDisplacementScore ?? 0.5;
    const atr = calculateATR(candles, 14);
    const orderBlocks: IOrderBlock[] = [];

    // 1. Identify Order Block candidates and require confirmation window (i + 1 to i + 3)
    for (let i = 0; i <= candles.length - 4; i++) {
      const candle = candles[i];
      const candleAtr = atr[i] || Math.max(1, candle.high - candle.low);
      const isBearishCandle = candle.close < candle.open;
      const isBullishCandle = candle.close > candle.open;

      // Point-in-time average volume over prior 20 closed candles
      const priorVolumes = candles
        .slice(Math.max(0, i - 20), i)
        .map((c) => Number(c.volume || 0))
        .filter((v) => v > 0);
      const avgVolume =
        priorVolumes.length > 0
          ? priorVolumes.reduce((a, b) => a + b, 0) / priorVolumes.length
          : undefined;

      // Check subsequent 3 candles for rapid expansion (displacement)
      const next1 = candles[i + 1];
      const next2 = candles[i + 2];
      const next3 = candles[i + 3];

      // 1. Bullish Order Block candidate: Bearish candle followed by rapid upward impulse
      if (isBearishCandle) {
        const maxUpMove = Math.max(next1.high, next2.high, next3.high) - candle.low;
        const hasAtrDisplacement = maxUpMove >= candleAtr * displacementThreshold;

        // Check displacement engine score on next candles
        const dScore1 = DisplacementEngine.evaluateDisplacement(next1, candleAtr, avgVolume);
        const dScore2 = DisplacementEngine.evaluateDisplacement(next2, candleAtr, avgVolume);
        const dScore3 = DisplacementEngine.evaluateDisplacement(next3, candleAtr, avgVolume);
        const hasEngineDisplacement =
          (dScore1.score >= minDisplacementScore && dScore1.direction === Direction.BULLISH) ||
          (dScore2.score >= minDisplacementScore && dScore2.direction === Direction.BULLISH) ||
          (dScore3.score >= minDisplacementScore && dScore3.direction === Direction.BULLISH);

        // Check if a BOS or FVG was created in this subsequent confirmation window
        const createdBOS = bosList.some(
          (b) =>
            b.direction === Direction.BULLISH && b.candleIndex >= i + 1 && b.candleIndex <= i + 3,
        );
        const createdFVG = fvgList.some(
          (f) =>
            f.direction === Direction.BULLISH && f.candleIndex >= i + 1 && f.candleIndex <= i + 3,
        );

        if ((hasAtrDisplacement || hasEngineDisplacement) && (createdBOS || createdFVG || maxUpMove >= candleAtr * 1.5)) {
          const confirmedAtIndex = i + 3;
          const confirmedTime = new Date(next3.timestamp);
          orderBlocks.push({
            id: `ob-bull-${i}`,
            direction: Direction.BULLISH,
            high: candle.high,
            low: candle.low,
            candleIndex: i,
            timestamp: new Date(candle.timestamp),
            createdAt: new Date(candle.timestamp),
            confirmedAtIndex,
            confirmedAtTimestamp: confirmedTime,
            confirmedAt: confirmedTime,
            availableAtIndex: confirmedAtIndex,
            availableAtTimestamp: confirmedTime,
            availableAt: confirmedTime,
            isMitigated: false,
            isInvalidated: false,
            status: 'ACTIVE',
            mitigationDepthPercentage: 0,
            strength: createdBOS ? 2.0 : 1.5,
          });
        }
      }

      // 2. Bearish Order Block candidate: Bullish candle followed by rapid downward impulse
      if (isBullishCandle) {
        const maxDownMove = candle.high - Math.min(next1.low, next2.low, next3.low);
        const hasAtrDisplacement = maxDownMove >= candleAtr * displacementThreshold;

        const dScore1 = DisplacementEngine.evaluateDisplacement(next1, candleAtr, avgVolume);
        const dScore2 = DisplacementEngine.evaluateDisplacement(next2, candleAtr, avgVolume);
        const dScore3 = DisplacementEngine.evaluateDisplacement(next3, candleAtr, avgVolume);
        const hasEngineDisplacement =
          (dScore1.score >= minDisplacementScore && dScore1.direction === Direction.BEARISH) ||
          (dScore2.score >= minDisplacementScore && dScore2.direction === Direction.BEARISH) ||
          (dScore3.score >= minDisplacementScore && dScore3.direction === Direction.BEARISH);

        const createdBOS = bosList.some(
          (b) =>
            b.direction === Direction.BEARISH && b.candleIndex >= i + 1 && b.candleIndex <= i + 3,
        );
        const createdFVG = fvgList.some(
          (f) =>
            f.direction === Direction.BEARISH && f.candleIndex >= i + 1 && f.candleIndex <= i + 3,
        );

        if ((hasAtrDisplacement || hasEngineDisplacement) && (createdBOS || createdFVG || maxDownMove >= candleAtr * 1.5)) {
          const confirmedAtIndex = i + 3;
          const confirmedTime = new Date(next3.timestamp);
          orderBlocks.push({
            id: `ob-bear-${i}`,
            direction: Direction.BEARISH,
            high: candle.high,
            low: candle.low,
            candleIndex: i,
            timestamp: new Date(candle.timestamp),
            createdAt: new Date(candle.timestamp),
            confirmedAtIndex,
            confirmedAtTimestamp: confirmedTime,
            confirmedAt: confirmedTime,
            availableAtIndex: confirmedAtIndex,
            availableAtTimestamp: confirmedTime,
            availableAt: confirmedTime,
            isMitigated: false,
            isInvalidated: false,
            status: 'ACTIVE',
            mitigationDepthPercentage: 0,
            strength: createdBOS ? 2.0 : 1.5,
          });
        }
      }
    }

    // 2. Track mitigation and invalidation incrementally over subsequent candles starting after confirmation window
    for (const ob of orderBlocks) {
      const obHeight = Math.max(0.0001, ob.high - ob.low);

      for (let k = ob.candleIndex + 4; k < candles.length; k++) {
        const c = candles[k];
        const cTime = new Date(c.timestamp);

        if (ob.direction === Direction.BULLISH) {
          // Invalidated if price closes below OB low
          if (c.close < ob.low) {
            ob.isInvalidated = true;
            ob.status = 'INVALIDATED';
            ob.invalidatedAtIndex = k;
            ob.invalidatedAtTimestamp = cTime;
            ob.invalidatedAt = cTime;
            ob.mitigationDepthPercentage = 100;
            break;
          }

          // Mitigation tracking
          if (c.low <= ob.high) {
            const penetration = Math.max(0, ob.high - c.low);
            const depthPct = Math.min(100, Math.round((penetration / obHeight) * 100));
            if (depthPct > (ob.mitigationDepthPercentage || 0)) {
              ob.mitigationDepthPercentage = depthPct;
            }

            if (!ob.isMitigated) {
              ob.isMitigated = true;
              ob.mitigatedAtIndex = k;
              ob.mitigatedAtTimestamp = cTime;
              ob.mitigatedAt = cTime;
            }

            if (depthPct >= 100) {
              ob.status = 'FULLY_MITIGATED';
            } else if (depthPct >= 50) {
              ob.status = 'PARTIALLY_MITIGATED';
            } else {
              ob.status = 'TOUCHED';
            }
          }
        } else {
          // Bearish OB: Invalidated if price closes above OB high
          if (c.close > ob.high) {
            ob.isInvalidated = true;
            ob.status = 'INVALIDATED';
            ob.invalidatedAtIndex = k;
            ob.invalidatedAtTimestamp = cTime;
            ob.invalidatedAt = cTime;
            ob.mitigationDepthPercentage = 100;
            break;
          }

          // Mitigation tracking
          if (c.high >= ob.low) {
            const penetration = Math.max(0, c.high - ob.low);
            const depthPct = Math.min(100, Math.round((penetration / obHeight) * 100));
            if (depthPct > (ob.mitigationDepthPercentage || 0)) {
              ob.mitigationDepthPercentage = depthPct;
            }

            if (!ob.isMitigated) {
              ob.isMitigated = true;
              ob.mitigatedAtIndex = k;
              ob.mitigatedAtTimestamp = cTime;
              ob.mitigatedAt = cTime;
            }

            if (depthPct >= 100) {
              ob.status = 'FULLY_MITIGATED';
            } else if (depthPct >= 50) {
              ob.status = 'PARTIALLY_MITIGATED';
            } else {
              ob.status = 'TOUCHED';
            }
          }
        }
      }
    }

    const activeOrderBlocks = orderBlocks.filter((ob) => !ob.isMitigated && !ob.isInvalidated);
    return { allOrderBlocks: orderBlocks, activeOrderBlocks };
  }
}

