import {
  BOSConfirmationType,
  Direction,
  ICandle,
  IChangeOfCharacter,
  ISwingPoint,
  StructureType,
} from '@quant/shared';
import { calculateATR } from '@quant/indicators';
import { DisplacementEngine } from './displacement';

export interface ICHOCHEngineOptions {
  confirmationType?: BOSConfirmationType;
  displacementThresholdAtr?: number;
  minDisplacementScore?: number;
  asOfTimestamp?: Date;
  timeframe?: string;
}

export class CHOCHEngine {
  /**
   * Detects market structure trend reversals (Change of Character) with strictly zero look-ahead bias.
   * A CHOCH occurs when price breaks the structural pivot of an opposing established trend:
   * - Bullish CHOCH: In a Bearish trend, price breaks above the protected Lower High (or recent confirmed Lower High).
   * - Bearish CHOCH: In a Bullish trend, price breaks below the protected Higher Low (or recent confirmed Higher Low).
   */
  static detectCHOCH(
    candles: ICandle[],
    swings: ISwingPoint[],
    options: ICHOCHEngineOptions = {},
  ): IChangeOfCharacter[] {
    if (!candles || candles.length === 0 || !swings || swings.length < 2) {
      return [];
    }

    const confType = options.confirmationType ?? BOSConfirmationType.CANDLE_CLOSE;
    const displacementThreshold = options.displacementThresholdAtr ?? 1.0;
    const atr = calculateATR(candles, 14);
    const chochEvents: IChangeOfCharacter[] = [];
    let currentTrend: Direction = Direction.NEUTRAL;

    // Track active unbroken swing levels
    const brokenSwingIndices = new Set<number>();

    for (let i = 0; i < candles.length; i++) {
      const candle = candles[i];
      const candleAtr = atr[i] || Math.max(1, candle.high - candle.low);

      // Point-in-time average volume over prior 20 closed candles
      const priorVolumes = candles
        .slice(Math.max(0, i - 20), i)
        .map((c) => Number(c.volume || 0))
        .filter((v) => v > 0);
      const avgVolume =
        priorVolumes.length > 0
          ? priorVolumes.reduce((a, b) => a + b, 0) / priorVolumes.length
          : undefined;

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

      // Valid Lower Highs in a Bearish trend: strictly LOWER_HIGH or explicitly protected structural high
      const validLowerHighs = visibleSwings.filter(
        (s) =>
          (s.type === StructureType.LOWER_HIGH || (s.isProtected && s.type === StructureType.SWING_HIGH)) &&
          !brokenSwingIndices.has(s.index),
      );

      // Valid Higher Lows in a Bullish trend: strictly HIGHER_LOW or explicitly protected structural low
      const validHigherLows = visibleSwings.filter(
        (s) =>
          (s.type === StructureType.HIGHER_LOW || (s.isProtected && s.type === StructureType.SWING_LOW)) &&
          !brokenSwingIndices.has(s.index),
      );

      // Target the active protected pivot (preferring isProtected, then validated structural LH/HL)
      const protectedLH = validLowerHighs.filter((h) => h.isProtected).pop() || validLowerHighs[validLowerHighs.length - 1];
      const protectedHL = validHigherLows.filter((l) => l.isProtected).pop() || validHigherLows[validHigherLows.length - 1];

      // 1. Bullish CHOCH: In a Bearish trend, price breaks above protected Lower High
      if (currentTrend === Direction.BEARISH && protectedLH && i > protectedLH.confirmedAtIndex) {
        const dispMetrics = DisplacementEngine.calculate(
          candle,
          Direction.BULLISH,
          candleAtr,
          protectedLH.price,
          avgVolume,
          { threshold: displacementThreshold },
        );

        let isBroken = false;
        if (confType === BOSConfirmationType.WICK_BREAK) {
          isBroken = candle.high > protectedLH.price;
        } else if (confType === BOSConfirmationType.CANDLE_CLOSE) {
          isBroken = candle.close > protectedLH.price;
        } else {
          // CANDLE_CLOSE_AND_DISPLACEMENT: Strictly requires close beyond pivot AND multi-factor displacement
          isBroken = candle.close > protectedLH.price && dispMetrics.isDisplacement;
        }

        if (isBroken) {
          chochEvents.push({
            direction: Direction.BULLISH,
            previousTrend: Direction.BEARISH,
            brokenLevel: protectedLH.price,
            brokenSwingPoint: protectedLH,
            candleIndex: i,
            timestamp: candle.timestamp,
            strength: dispMetrics.isDisplacement ? 2.0 : 1.5,
            confirmationType: confType,
            displacementScore: dispMetrics.compositeScore,
          });
          brokenSwingIndices.add(protectedLH.index);
          currentTrend = Direction.BULLISH; // Trend flips to Bullish
        }
      }

      // 2. Bearish CHOCH: In a Bullish trend, price breaks below protected Higher Low
      if (currentTrend === Direction.BULLISH && protectedHL && i > protectedHL.confirmedAtIndex) {
        const dispMetrics = DisplacementEngine.calculate(
          candle,
          Direction.BEARISH,
          candleAtr,
          protectedHL.price,
          avgVolume,
          { threshold: displacementThreshold },
        );

        let isBroken = false;
        if (confType === BOSConfirmationType.WICK_BREAK) {
          isBroken = candle.low < protectedHL.price;
        } else if (confType === BOSConfirmationType.CANDLE_CLOSE) {
          isBroken = candle.close < protectedHL.price;
        } else {
          // CANDLE_CLOSE_AND_DISPLACEMENT: Strictly requires close beyond pivot AND multi-factor displacement
          isBroken = candle.close < protectedHL.price && dispMetrics.isDisplacement;
        }

        if (isBroken) {
          chochEvents.push({
            direction: Direction.BEARISH,
            previousTrend: Direction.BULLISH,
            brokenLevel: protectedHL.price,
            brokenSwingPoint: protectedHL,
            candleIndex: i,
            timestamp: candle.timestamp,
            strength: dispMetrics.isDisplacement ? 2.0 : 1.5,
            confirmationType: confType,
            displacementScore: dispMetrics.compositeScore,
          });
          brokenSwingIndices.add(protectedHL.index);
          currentTrend = Direction.BEARISH; // Trend flips to Bearish
        }
      }
    }

    return chochEvents;
  }
}

