import { ICandle, ISwingPoint, StructureType } from '@quant/shared';
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
   * Detects and classifies structural swings with strictly zero look-ahead bias.
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
    const swings: ISwingPoint[] = [];

    let lastConfirmedHigh: ISwingPoint | null = null;
    let lastConfirmedLow: ISwingPoint | null = null;
    let protectedHigh: ISwingPoint | null = null;
    let protectedLow: ISwingPoint | null = null;

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
        // Enforce minimum distance filter from previous low if available
        if (!lastConfirmedLow || Math.abs(currentHigh - lastConfirmedLow.price) >= minDistance) {
          let type = StructureType.SWING_HIGH;
          const isExternal = !lastConfirmedLow || Math.abs(currentHigh - lastConfirmedLow.price) >= externalDistance;

          if (lastConfirmedHigh) {
            if (currentHigh > lastConfirmedHigh.price) {
              type = StructureType.HIGHER_HIGH;
              // Higher High confirms the preceding low as the new protected higher low
              if (lastConfirmedLow) {
                lastConfirmedLow.isProtected = true;
                protectedLow = lastConfirmedLow;
              }
            } else {
              type = StructureType.LOWER_HIGH;
              // In a bearish regime, Lower High is the protected structural high
              protectedHigh = {
                index: i,
                type,
                price: currentHigh,
                timestamp: candles[i].timestamp,
                confirmedAtIndex: i + rightBars,
                confirmedAtTimestamp: candles[i + rightBars].timestamp,
                isProtected: true,
                isExternal,
              };
            }
          }

          const confirmedAtIndex = i + rightBars;
          const swingPoint: ISwingPoint = {
            index: i,
            type,
            price: currentHigh,
            timestamp: candles[i].timestamp,
            confirmedAtIndex,
            confirmedAtTimestamp: candles[confirmedAtIndex].timestamp,
            isProtected: protectedHigh?.index === i,
            isExternal,
          };

          swings.push(swingPoint);
          lastConfirmedHigh = swingPoint;
        }
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
        if (!lastConfirmedHigh || Math.abs(currentLow - lastConfirmedHigh.price) >= minDistance) {
          let type = StructureType.SWING_LOW;
          const isExternal = !lastConfirmedHigh || Math.abs(currentLow - lastConfirmedHigh.price) >= externalDistance;

          if (lastConfirmedLow) {
            if (currentLow < lastConfirmedLow.price) {
              type = StructureType.LOWER_LOW;
              // Lower Low confirms the preceding high as the new protected lower high
              if (lastConfirmedHigh) {
                lastConfirmedHigh.isProtected = true;
                protectedHigh = lastConfirmedHigh;
              }
            } else {
              type = StructureType.HIGHER_LOW;
              // In a bullish regime, Higher Low is the protected structural low
              protectedLow = {
                index: i,
                type,
                price: currentLow,
                timestamp: candles[i].timestamp,
                confirmedAtIndex: i + rightBars,
                confirmedAtTimestamp: candles[i + rightBars].timestamp,
                isProtected: true,
                isExternal,
              };
            }
          }

          const confirmedAtIndex = i + rightBars;
          const swingPoint: ISwingPoint = {
            index: i,
            type,
            price: currentLow,
            timestamp: candles[i].timestamp,
            confirmedAtIndex,
            confirmedAtTimestamp: candles[confirmedAtIndex].timestamp,
            isProtected: protectedLow?.index === i,
            isExternal,
          };

          swings.push(swingPoint);
          lastConfirmedLow = swingPoint;
        }
      }
    }

    // Sort by confirmed index ascending
    return swings.sort((a, b) => a.confirmedAtIndex - b.confirmedAtIndex);
  }
}
