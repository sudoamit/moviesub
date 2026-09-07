import { Direction, IFairValueGap, ICandle } from '@quant/shared';
import { calculateATR } from '@quant/indicators';
import { CandleNormalizer } from './candle-normalizer';

export interface IFVGEngineOptions {
  minGapAtrMultiplier?: number;
  asOfTimestamp?: Date;
}

export class FVGEngine {
  /**
   * Detects 3-candle Fair Value Gaps (imbalances) and tracks point-in-time mitigation/fill percentage.
   * State is evaluated strictly chronologically up to asOfTimestamp without look-ahead bias.
   */
  static detectFVGs(
    rawCandles: ICandle[],
    options: IFVGEngineOptions = {},
  ): { allFVGs: IFairValueGap[]; activeFVGs: IFairValueGap[] } {
    if (!rawCandles || rawCandles.length < 3) {
      return { allFVGs: [], activeFVGs: [] };
    }

    let candles = CandleNormalizer.normalize(rawCandles);
    if (options.asOfTimestamp) {
      const asOfTime = options.asOfTimestamp.getTime();
      candles = candles.filter((c) => new Date(c.timestamp).getTime() <= asOfTime);
    }

    if (candles.length < 3) {
      return { allFVGs: [], activeFVGs: [] };
    }

    const minGapMult = options.minGapAtrMultiplier ?? 0.2;
    const atr = calculateATR(candles, 14);
    const fvgs: IFairValueGap[] = [];

    // 1. Identify 3-candle gaps
    for (let i = 2; i < candles.length; i++) {
      const c1 = candles[i - 2];
      const c3 = candles[i];
      const candleAtr = atr[i] || Math.max(1, c3.high - c3.low);
      const minGap = candleAtr * minGapMult;

      // Bullish FVG: Candle 3 low > Candle 1 high
      if (c3.low > c1.high && c3.low - c1.high >= minGap) {
        fvgs.push({
          id: `fvg-bull-${i}`,
          direction: Direction.BULLISH,
          upperBound: c3.low,
          lowerBound: c1.high,
          candleIndex: i,
          timestamp: new Date(c3.timestamp),
          createdAt: new Date(c3.timestamp),
          confirmedAt: new Date(c3.timestamp),
          isFilled: false,
          fillPercentage: 0,
          isInvalidated: false,
          status: 'ACTIVE',
        });
      }

      // Bearish FVG: Candle 3 high < Candle 1 low
      if (c3.high < c1.low && c1.low - c3.high >= minGap) {
        fvgs.push({
          id: `fvg-bear-${i}`,
          direction: Direction.BEARISH,
          upperBound: c1.low,
          lowerBound: c3.high,
          candleIndex: i,
          timestamp: new Date(c3.timestamp),
          createdAt: new Date(c3.timestamp),
          confirmedAt: new Date(c3.timestamp),
          isFilled: false,
          fillPercentage: 0,
          isInvalidated: false,
          status: 'ACTIVE',
        });
      }
    }

    // 2. Track subsequent price action, mitigation, and fill percentage incrementally
    for (const fvg of fvgs) {
      const gapHeight = fvg.upperBound - fvg.lowerBound;
      if (gapHeight <= 0) continue;

      for (let k = fvg.candleIndex + 1; k < candles.length; k++) {
        const c = candles[k];
        const cTime = new Date(c.timestamp);

        if (fvg.direction === Direction.BULLISH) {
          // Price moves down into Bullish FVG
          if (c.low < fvg.upperBound) {
            const fillDepth = fvg.upperBound - Math.max(fvg.lowerBound, c.low);
            const currentFill = Math.min(100, (fillDepth / gapHeight) * 100);
            fvg.fillPercentage = Math.max(fvg.fillPercentage, currentFill);

            if (fvg.fillPercentage > 0 && !fvg.isFilled && !fvg.isInvalidated) {
              fvg.status = 'PARTIALLY_FILLED';
            }

            if (c.low <= fvg.lowerBound) {
              fvg.isFilled = true;
              fvg.status = 'FILLED';
              fvg.filledAtIndex = k;
              fvg.filledAtTimestamp = cTime;
            }
          }
          // Invalidation: candle closes below the FVG lower bound
          if (c.close < fvg.lowerBound) {
            fvg.isInvalidated = true;
            fvg.status = 'INVALIDATED';
            fvg.invalidatedAtIndex = k;
            fvg.invalidatedAtTimestamp = cTime;
            break;
          }
        } else {
          // Price moves up into Bearish FVG
          if (c.high > fvg.lowerBound) {
            const fillDepth = Math.min(fvg.upperBound, c.high) - fvg.lowerBound;
            const currentFill = Math.min(100, (fillDepth / gapHeight) * 100);
            fvg.fillPercentage = Math.max(fvg.fillPercentage, currentFill);

            if (fvg.fillPercentage > 0 && !fvg.isFilled && !fvg.isInvalidated) {
              fvg.status = 'PARTIALLY_FILLED';
            }

            if (c.high >= fvg.upperBound) {
              fvg.isFilled = true;
              fvg.status = 'FILLED';
              fvg.filledAtIndex = k;
              fvg.filledAtTimestamp = cTime;
            }
          }
          // Invalidation: candle closes above the FVG upper bound
          if (c.close > fvg.upperBound) {
            fvg.isInvalidated = true;
            fvg.status = 'INVALIDATED';
            fvg.invalidatedAtIndex = k;
            fvg.invalidatedAtTimestamp = cTime;
            break;
          }
        }
      }
    }

    const activeFVGs = fvgs.filter((f) => !f.isFilled && !f.isInvalidated);
    return { allFVGs: fvgs, activeFVGs };
  }
}
