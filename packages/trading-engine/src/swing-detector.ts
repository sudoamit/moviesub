import { ICandle, ISwingPoint, StructureType } from '@quant/shared';
import { calculateATR } from '@quant/indicators';

export interface ISwingDetectorOptions {
  leftBars?: number;
  rightBars?: number;
  minDistanceAtrMultiplier?: number;
}

export class SwingDetector {
  /**
   * Detects and classifies structural swings with strictly zero look-ahead bias.
   * A swing at index i is ONLY confirmed at index i + rightBars.
   */
  static detectSwings(
    candles: ICandle[],
    options: ISwingDetectorOptions = {},
  ): ISwingPoint[] {
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

    // Up to candle length - rightBars can be confirmed
    const maxEvalIndex = candles.length - rightBars;

    for (let i = leftBars; i < maxEvalIndex; i++) {
      const currentHigh = candles[i].high;
      const currentLow = candles[i].low;
      const currentAtr = atr[i] || (currentHigh - currentLow);
      const minDistance = currentAtr * minDistanceMult;

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
          if (lastConfirmedHigh) {
            type = currentHigh > lastConfirmedHigh.price ? StructureType.HIGHER_HIGH : StructureType.LOWER_HIGH;
          }

          const confirmedAtIndex = i + rightBars;
          const swingPoint: ISwingPoint = {
            index: i,
            type,
            price: currentHigh,
            timestamp: candles[i].timestamp,
            confirmedAtIndex,
            confirmedAtTimestamp: candles[confirmedAtIndex].timestamp,
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
          if (lastConfirmedLow) {
            type = currentLow < lastConfirmedLow.price ? StructureType.LOWER_LOW : StructureType.HIGHER_LOW;
          }

          const confirmedAtIndex = i + rightBars;
          const swingPoint: ISwingPoint = {
            index: i,
            type,
            price: currentLow,
            timestamp: candles[i].timestamp,
            confirmedAtIndex,
            confirmedAtTimestamp: candles[confirmedAtIndex].timestamp,
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
