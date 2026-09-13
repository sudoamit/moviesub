import {
  BOSConfirmationType,
  Direction,
  IBreakOfStructure,
  ICandle,
  ISwingPoint,
  StructureType,
} from '@quant/shared';
import { calculateATR } from '@quant/indicators';
import { DisplacementEngine } from './displacement';

export interface IBOSEngineOptions {
  confirmationType?: BOSConfirmationType;
  displacementThresholdAtr?: number;
  minDisplacementScore?: number;
  asOfTimestamp?: Date;
  timeframe?: string;
}

export class BOSEngine {
  /**
   * Detects valid Bullish and Bearish Breaks of Structure (BOS).
   * Guarantees at most ONE Bullish BOS and/or ONE Bearish BOS per candle by targeting
   * the active structural pivot rather than emitting for all historical levels.
   */
  static detectBOS(
    candles: ICandle[],
    swings: ISwingPoint[],
    options: IBOSEngineOptions = {},
  ): IBreakOfStructure[] {
    if (!candles || candles.length === 0 || !swings || swings.length === 0) {
      return [];
    }

    const confType = options.confirmationType ?? BOSConfirmationType.CANDLE_CLOSE_AND_DISPLACEMENT;
    const displacementThreshold = options.displacementThresholdAtr ?? 1.0;
    const atr = calculateATR(candles, 14);
    const bosEvents: IBreakOfStructure[] = [];

    // Track active unbroken swing levels
    let activeHighs = swings.filter(
      (s) =>
        s.type === StructureType.SWING_HIGH ||
        s.type === StructureType.HIGHER_HIGH ||
        s.type === StructureType.LOWER_HIGH,
    );

    let activeLows = swings.filter(
      (s) =>
        s.type === StructureType.SWING_LOW ||
        s.type === StructureType.HIGHER_LOW ||
        s.type === StructureType.LOWER_LOW,
    );

    for (let i = 0; i < candles.length; i++) {
      const candle = candles[i];
      const candleAtr = atr[i] || Math.max(1, candle.high - candle.low);

      // Point-in-time average volume over prior 20 closed candles (strictly observable at bar i)
      const priorVolumes = candles
        .slice(Math.max(0, i - 20), i)
        .map((c) => Number(c.volume || 0))
        .filter((v) => v > 0);
      const avgVolume =
        priorVolumes.length > 0
          ? priorVolumes.reduce((a, b) => a + b, 0) / priorVolumes.length
          : undefined;

      // 1. Check for Bullish BOS (Targeting active protected structural high)
      const eligibleHighs = activeHighs.filter((h) => i > h.confirmedAtIndex);
      if (eligibleHighs.length > 0) {
        // Explicit structural-level selection: Target active protected structural pivot if present, else latest structural high
        const protectedHigh = eligibleHighs.filter((h) => h.isProtected === true).pop();
        const targetHigh = protectedHigh || eligibleHighs[eligibleHighs.length - 1];

        const dispMetrics = DisplacementEngine.calculate(
          candle,
          Direction.BULLISH,
          candleAtr,
          targetHigh.price,
          avgVolume,
          { threshold: displacementThreshold },
        );

        let isBroken = false;
        if (confType === BOSConfirmationType.WICK_BREAK) {
          isBroken = candle.high > targetHigh.price;
        } else if (confType === BOSConfirmationType.CANDLE_CLOSE) {
          isBroken = candle.close > targetHigh.price;
        } else {
          // CANDLE_CLOSE_AND_DISPLACEMENT: Strictly requires close beyond pivot AND confirmed multi-factor displacement
          isBroken = candle.close > targetHigh.price && dispMetrics.isDisplacement;
        }

        if (isBroken) {
          bosEvents.push({
            direction: Direction.BULLISH,
            brokenLevel: targetHigh.price,
            brokenSwingPoint: targetHigh,
            breakPrice: candle.close,
            candleIndex: i,
            timestamp: candle.timestamp,
            isConfirmed: true,
            displacementRatio: dispMetrics.rangeAtrRatio,
            displacementScore: dispMetrics.compositeScore,
            confirmationType: confType,
          });

          // Retire targetHigh and any active highs with price <= break price that were confirmed prior
          activeHighs = activeHighs.filter((h) => h.index !== targetHigh.index && (h.price > candle.close || h.confirmedAtIndex >= i));
        }
      }

      // 2. Check for Bearish BOS (Targeting active protected structural low)
      const eligibleLows = activeLows.filter((l) => i > l.confirmedAtIndex);
      if (eligibleLows.length > 0) {
        // Explicit structural-level selection: Target active protected structural pivot if present, else latest structural low
        const protectedLow = eligibleLows.filter((l) => l.isProtected === true).pop();
        const targetLow = protectedLow || eligibleLows[eligibleLows.length - 1];

        const dispMetrics = DisplacementEngine.calculate(
          candle,
          Direction.BEARISH,
          candleAtr,
          targetLow.price,
          avgVolume,
          { threshold: displacementThreshold },
        );

        let isBroken = false;
        if (confType === BOSConfirmationType.WICK_BREAK) {
          isBroken = candle.low < targetLow.price;
        } else if (confType === BOSConfirmationType.CANDLE_CLOSE) {
          isBroken = candle.close < targetLow.price;
        } else {
          // CANDLE_CLOSE_AND_DISPLACEMENT: Strictly requires close beyond pivot AND confirmed multi-factor displacement
          isBroken = candle.close < targetLow.price && dispMetrics.isDisplacement;
        }

        if (isBroken) {
          bosEvents.push({
            direction: Direction.BEARISH,
            brokenLevel: targetLow.price,
            brokenSwingPoint: targetLow,
            breakPrice: candle.close,
            candleIndex: i,
            timestamp: candle.timestamp,
            isConfirmed: true,
            displacementRatio: dispMetrics.rangeAtrRatio,
            displacementScore: dispMetrics.compositeScore,
            confirmationType: confType,
          });

          // Retire targetLow and any active lows with price >= break price that were confirmed prior
          activeLows = activeLows.filter((l) => l.index !== targetLow.index && (l.price < candle.close || l.confirmedAtIndex >= i));
        }
      }
    }

    return bosEvents;
  }
}
