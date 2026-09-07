import { Direction, ICandle, IChangeOfCharacter, ISwingPoint, StructureType } from '@quant/shared';

export class CHOCHEngine {
  /**
   * Detects market structure trend reversals (Change of Character) with strictly zero look-ahead bias.
   * A CHOCH occurs when price breaks the structural pivot of an opposing established trend:
   * - Bullish CHOCH: In a Bearish trend, price breaks above the most recent confirmed Lower High (or Swing High).
   * - Bearish CHOCH: In a Bullish trend, price breaks below the most recent confirmed Higher Low (or Swing Low).
   */
  static detectCHOCH(candles: ICandle[], swings: ISwingPoint[]): IChangeOfCharacter[] {
    if (!candles || candles.length === 0 || !swings || swings.length < 2) {
      return [];
    }

    const chochEvents: IChangeOfCharacter[] = [];
    let currentTrend: Direction = Direction.NEUTRAL;

    // Track active unbroken swing levels
    const brokenSwingIndices = new Set<number>();

    for (let i = 0; i < candles.length; i++) {
      const candle = candles[i];

      // Swings confirmed at or before candle i
      const visibleSwings = swings.filter((s) => s.confirmedAtIndex <= i);
      if (visibleSwings.length < 2) continue;

      // Update structural trend dynamically from chronological swings if currently neutral
      if (currentTrend === Direction.NEUTRAL) {
        const lastSwing = visibleSwings[visibleSwings.length - 1];
        if (
          lastSwing.type === StructureType.HIGHER_HIGH ||
          lastSwing.type === StructureType.HIGHER_LOW
        ) {
          currentTrend = Direction.BULLISH;
        } else if (
          lastSwing.type === StructureType.LOWER_LOW ||
          lastSwing.type === StructureType.LOWER_HIGH
        ) {
          currentTrend = Direction.BEARISH;
        }
      }

      const recentHighs = visibleSwings.filter(
        (s) =>
          (s.type === StructureType.LOWER_HIGH || s.type === StructureType.SWING_HIGH) &&
          !brokenSwingIndices.has(s.index),
      );
      const recentLows = visibleSwings.filter(
        (s) =>
          (s.type === StructureType.HIGHER_LOW || s.type === StructureType.SWING_LOW) &&
          !brokenSwingIndices.has(s.index),
      );

      const recentLH = recentHighs[recentHighs.length - 1];
      const recentHL = recentLows[recentLows.length - 1];

      // 1. Bullish CHOCH: In a Bearish trend, price closes above recent Lower High
      if (currentTrend === Direction.BEARISH && recentLH && i > recentLH.confirmedAtIndex) {
        if (candle.close > recentLH.price) {
          chochEvents.push({
            direction: Direction.BULLISH,
            previousTrend: Direction.BEARISH,
            brokenLevel: recentLH.price,
            candleIndex: i,
            timestamp: candle.timestamp,
            strength: 1.5,
          });
          brokenSwingIndices.add(recentLH.index);
          currentTrend = Direction.BULLISH; // Trend flips to Bullish
        }
      }

      // 2. Bearish CHOCH: In a Bullish trend, price closes below recent Higher Low
      if (currentTrend === Direction.BULLISH && recentHL && i > recentHL.confirmedAtIndex) {
        if (candle.close < recentHL.price) {
          chochEvents.push({
            direction: Direction.BEARISH,
            previousTrend: Direction.BULLISH,
            brokenLevel: recentHL.price,
            candleIndex: i,
            timestamp: candle.timestamp,
            strength: 1.5,
          });
          brokenSwingIndices.add(recentHL.index);
          currentTrend = Direction.BEARISH; // Trend flips to Bearish
        }
      }
    }

    return chochEvents;
  }
}

