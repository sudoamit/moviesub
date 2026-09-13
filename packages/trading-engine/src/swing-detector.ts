import { Direction, ICandle, ISwingPoint, StructureType } from '@quant/shared';
import { calculateATR } from '@quant/indicators';

export interface ISwingDetectorOptions {
  leftBars?: number;
  rightBars?: number;
  minDistanceAtrMultiplier?: number;
  asOfTimestamp?: Date;
  timeframe?: string;
}

export class SwingDetector {
  /**
   * Detects and classifies structural swings with strictly zero look-ahead bias
   * using a true market-structure state machine for protected pivots and external/internal structure.
   * A swing at index i is ONLY confirmed at index i + rightBars.
   */
  static detectSwings(candles: ICandle[], options: ISwingDetectorOptions = {}): ISwingPoint[] {
    const leftBars = options.leftBars ?? 3;
    const rightBars = options.rightBars ?? 3;
    const minDistanceMult = options.minDistanceAtrMultiplier ?? 0.5;

    if (!candles || candles.length < leftBars + rightBars + 1) {
      return [];
    }

    const atr = calculateATR(candles, 14);
    const candidateSwings: ISwingPoint[] = [];

    // Up to candle length - rightBars can be confirmed
    const maxEvalIndex = candles.length - rightBars;

    for (let i = leftBars; i < maxEvalIndex; i++) {
      const currentHigh = candles[i].high;
      const currentLow = candles[i].low;
      const currentAtr = atr[i] || currentHigh - currentLow;
      const minDistance = currentAtr * minDistanceMult;
      const externalDistance = currentAtr * (minDistanceMult * 1.8);

      // 1. Swing High evaluation
      let isSwingHigh = true;
      for (let l = 1; l <= leftBars; l++) {
        if (candles[i - l].high > currentHigh) {
          isSwingHigh = false;
          break;
        }
      }
      if (isSwingHigh) {
        for (let r = 1; r <= rightBars; r++) {
          if (candles[i + r].high >= currentHigh) {
            isSwingHigh = false;
            break;
          }
        }
      }

      if (isSwingHigh) {
        const confirmedAtIndex = i + rightBars;
        candidateSwings.push({
          index: i,
          type: StructureType.SWING_HIGH,
          price: currentHigh,
          timestamp: candles[i].timestamp,
          confirmedAtIndex,
          confirmedAtTimestamp: candles[confirmedAtIndex].timestamp,
          isProtected: false,
          isExternal: true,
        });
      }

      // 2. Swing Low evaluation
      let isSwingLow = true;
      for (let l = 1; l <= leftBars; l++) {
        if (candles[i - l].low < currentLow) {
          isSwingLow = false;
          break;
        }
      }
      if (isSwingLow) {
        for (let r = 1; r <= rightBars; r++) {
          if (candles[i + r].low <= currentLow) {
            isSwingLow = false;
            break;
          }
        }
      }

      if (isSwingLow) {
        const confirmedAtIndex = i + rightBars;
        candidateSwings.push({
          index: i,
          type: StructureType.SWING_LOW,
          price: currentLow,
          timestamp: candles[i].timestamp,
          confirmedAtIndex,
          confirmedAtTimestamp: candles[confirmedAtIndex].timestamp,
          isProtected: false,
          isExternal: true,
        });
      }
    }

    // Sort confirmed chronologically by confirmation index
    candidateSwings.sort((a, b) => a.confirmedAtIndex - b.confirmedAtIndex || a.index - b.index);

    // 3. True Market Structure State Machine for HH/LH/HL/LL, External/Internal, and Protected Pivots
    let currentTrend: Direction = Direction.NEUTRAL;
    let lastMajorHigh: ISwingPoint | null = null;
    let lastMajorLow: ISwingPoint | null = null;
    let activeProtectedHigh: ISwingPoint | null = null;
    let activeProtectedLow: ISwingPoint | null = null;

    const classifiedSwings: ISwingPoint[] = [];

    for (const s of candidateSwings) {
      const isHigh = s.type === StructureType.SWING_HIGH;
      const currentAtr = atr[s.index] || 1.0;
      const minDistance = currentAtr * minDistanceMult;
      const externalDistance = currentAtr * (minDistanceMult * 1.8);

      if (isHigh) {
        // Distance check from last major low
        if (lastMajorLow && Math.abs(s.price - lastMajorLow.price) < minDistance) {
          continue; // Sub-noise swing
        }

        let type = StructureType.SWING_HIGH;
        const isExternal = !lastMajorLow || Math.abs(s.price - lastMajorLow.price) >= externalDistance;

        if (lastMajorHigh) {
          if (s.price > lastMajorHigh.price) {
            type = StructureType.HIGHER_HIGH;
            currentTrend = Direction.BULLISH;

            // In a Bullish expansion, the originating swing low that led to this Higher High becomes protected
            if (lastMajorLow) {
              lastMajorLow.isProtected = true;
              lastMajorLow.isExternal = true;
              activeProtectedLow = lastMajorLow;
            }
          } else {
            type = StructureType.LOWER_HIGH;
            if (currentTrend === Direction.BEARISH) {
              // In an established Bearish trend, the Lower High is the protected structural high
              s.isProtected = true;
              activeProtectedHigh = s;
            }
          }
        }

        s.type = type;
        s.isExternal = isExternal;
        if (activeProtectedHigh && activeProtectedHigh.index === s.index) {
          s.isProtected = true;
        }

        classifiedSwings.push(s);
        lastMajorHigh = s;
      } else {
        // Swing Low
        if (lastMajorHigh && Math.abs(s.price - lastMajorHigh.price) < minDistance) {
          continue;
        }

        let type = StructureType.SWING_LOW;
        const isExternal = !lastMajorHigh || Math.abs(s.price - lastMajorHigh.price) >= externalDistance;

        if (lastMajorLow) {
          if (s.price < lastMajorLow.price) {
            type = StructureType.LOWER_LOW;
            currentTrend = Direction.BEARISH;

            // In a Bearish expansion, the originating swing high that led to this Lower Low becomes protected
            if (lastMajorHigh) {
              lastMajorHigh.isProtected = true;
              lastMajorHigh.isExternal = true;
              activeProtectedHigh = lastMajorHigh;
            }
          } else {
            type = StructureType.HIGHER_LOW;
            if (currentTrend === Direction.BULLISH) {
              // In an established Bullish trend, the Higher Low is the protected structural low
              s.isProtected = true;
              activeProtectedLow = s;
            }
          }
        }

        s.type = type;
        s.isExternal = isExternal;
        if (activeProtectedLow && activeProtectedLow.index === s.index) {
          s.isProtected = true;
        }

        classifiedSwings.push(s);
        lastMajorLow = s;
      }
    }

    return classifiedSwings;
  }
}
