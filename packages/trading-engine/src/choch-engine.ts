import { Direction, ICandle, IChangeOfCharacter, ISwingPoint, StructureType } from '@quant/shared';

export class CHOCHEngine {
  /**
   * Detects market structure trend reversals (Change of Character)
   */
  static detectCHOCH(candles: ICandle[], swings: ISwingPoint[]): IChangeOfCharacter[] {
    if (!candles || candles.length === 0 || !swings || swings.length < 3) {
      return [];
    }

    const chochEvents: IChangeOfCharacter[] = [];
    let currentTrend: Direction = Direction.NEUTRAL;

    // Track most recent structural pivots
    let lastLH: ISwingPoint | null = null;
    let lastHL: ISwingPoint | null = null;

    for (const swing of swings) {
      if (swing.type === StructureType.LOWER_HIGH) {
        lastLH = swing;
      } else if (swing.type === StructureType.HIGHER_LOW) {
        lastHL = swing;
      }
    }

    // Determine initial trend orientation from early swings
    for (let s = 1; s < Math.min(swings.length, 5); s++) {
      if (swings[s].type === StructureType.HIGHER_HIGH || swings[s].type === StructureType.HIGHER_LOW) {
        currentTrend = Direction.BULLISH;
      } else if (swings[s].type === StructureType.LOWER_LOW || swings[s].type === StructureType.LOWER_HIGH) {
        currentTrend = Direction.BEARISH;
      }
    }

    for (let i = 0; i < candles.length; i++) {
      const candle = candles[i];

      // Update current recent swings up to index i
      const confirmedSwings = swings.filter((s) => s.confirmedAtIndex <= i);
      const recentLH = confirmedSwings
        .filter((s) => s.type === StructureType.LOWER_HIGH || s.type === StructureType.SWING_HIGH)
        .slice(-1)[0];
      const recentHL = confirmedSwings
        .filter((s) => s.type === StructureType.HIGHER_LOW || s.type === StructureType.SWING_LOW)
        .slice(-1)[0];

      // 1. Bullish CHoCH: In a Bearish trend, price closes above recent Lower High
      if (currentTrend === Direction.BEARISH && recentLH && candle.close > recentLH.price) {
        chochEvents.push({
          direction: Direction.BULLISH,
          previousTrend: Direction.BEARISH,
          brokenLevel: recentLH.price,
          candleIndex: i,
          timestamp: candle.timestamp,
          strength: 1.5,
        });
        currentTrend = Direction.BULLISH;
      }

      // 2. Bearish CHoCH: In a Bullish trend, price closes below recent Higher Low
      if (currentTrend === Direction.BULLISH && recentHL && candle.close < recentHL.price) {
        chochEvents.push({
          direction: Direction.BEARISH,
          previousTrend: Direction.BULLISH,
          brokenLevel: recentHL.price,
          candleIndex: i,
          timestamp: candle.timestamp,
          strength: 1.5,
        });
        currentTrend = Direction.BEARISH;
      }
    }

    return chochEvents;
  }
}
