import { Direction, IFairValueGap, ICandle } from '@quant/shared';
import { calculateATR } from '@quant/indicators';

export interface IFVGEngineOptions {
  minGapAtrMultiplier?: number;
}

export class FVGEngine {
  /**
   * Detects 3-candle Fair Value Gaps (imbalances) and tracks mitigation/fill percentage
   */
  static detectFVGs(
    candles: ICandle[],
    options: IFVGEngineOptions = {},
  ): { allFVGs: IFairValueGap[]; activeFVGs: IFairValueGap[] } {
    if (!candles || candles.length < 3) {
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
          timestamp: c3.timestamp,
          isFilled: false,
          fillPercentage: 0,
          isInvalidated: false,
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
          timestamp: c3.timestamp,
          isFilled: false,
          fillPercentage: 0,
          isInvalidated: false,
        });
      }
    }

    // 2. Track subsequent price action, mitigation, and fill percentage
    for (const fvg of fvgs) {
      const gapHeight = fvg.upperBound - fvg.lowerBound;
      if (gapHeight <= 0) continue;

      for (let k = fvg.candleIndex + 1; k < candles.length; k++) {
        const c = candles[k];

        if (fvg.direction === Direction.BULLISH) {
          // Price moves down into Bullish FVG
          if (c.low < fvg.upperBound) {
            const fillDepth = fvg.upperBound - Math.max(fvg.lowerBound, c.low);
            const currentFill = Math.min(100, (fillDepth / gapHeight) * 100);
            fvg.fillPercentage = Math.max(fvg.fillPercentage, currentFill);

            if (c.low <= fvg.lowerBound) {
              fvg.isFilled = true;
            }
          }
          // Invalidation: candle closes below the FVG lower bound
          if (c.close < fvg.lowerBound) {
            fvg.isInvalidated = true;
            break;
          }
        } else {
          // Price moves up into Bearish FVG
          if (c.high > fvg.lowerBound) {
            const fillDepth = Math.min(fvg.upperBound, c.high) - fvg.lowerBound;
            const currentFill = Math.min(100, (fillDepth / gapHeight) * 100);
            fvg.fillPercentage = Math.max(fvg.fillPercentage, currentFill);

            if (c.high >= fvg.upperBound) {
              fvg.isFilled = true;
            }
          }
          // Invalidation: candle closes above the FVG upper bound
          if (c.close > fvg.upperBound) {
            fvg.isInvalidated = true;
            break;
          }
        }
      }
    }

    const activeFVGs = fvgs.filter((f) => !f.isFilled && !f.isInvalidated);
    return { allFVGs: fvgs, activeFVGs };
  }
}
