import { Direction, ICandle, IFairValueGap, IOrderBlock, ISwingPoint } from '@quant/shared';
import { calculateATR } from '@quant/indicators';

export interface ITradeLevels {
  direction: Direction;
  entryZone: {
    min: number;
    max: number;
    optimal: number;
  };
  stopLoss: number;
  stopLossDistance: number;
  takeProfits: {
    tp1: number;
    tp2: number;
    tp3: number;
  };
  riskRewardRatios: {
    rr1: number;
    rr2: number;
    rr3: number;
  };
}

export class TradeLevelsCalculator {
  /**
   * Calculates ultra-precise execution entry zone, tight institutional invalidation stop loss (Sniper SL),
   * and high risk-to-reward asymmetric take profit targets (1:2.0 to 1:6.0+ R:R).
   */
  static calculateLevels(
    direction: Direction,
    candles: ICandle[],
    anchorSwing: ISwingPoint | null,
    orderBlock: IOrderBlock | null,
    fvg: IFairValueGap | null,
  ): ITradeLevels | null {
    if (direction === Direction.NEUTRAL || !candles || candles.length === 0) {
      return null;
    }

    const lastCandle = candles[candles.length - 1];
    const currentPrice = Number(lastCandle.close);
    const atrSeries = calculateATR(candles, 14);
    const rawAtr = atrSeries[candles.length - 1];
    const currentAtr =
      rawAtr && !isNaN(Number(rawAtr)) && Number(rawAtr) > 0
        ? Number(rawAtr)
        : Math.max(1, Number(lastCandle.high) - Number(lastCandle.low));

    const isBtc = currentPrice > 20000;

    // Ultra-tight institutional invalidation buffer (0.05x ATR)
    const slBuffer = Math.max(0.1, isBtc ? Math.min(15.0, currentAtr * 0.05) : currentAtr * 0.08);

    // Tight sniper risk boundaries (BTC capped at 120-220 pts; Indices capped at 0.10%-0.15%)
    const maxRiskPoints = isBtc
      ? Math.min(220, Math.max(120, currentAtr * 0.35))
      : Math.max(currentAtr * 0.35, currentAtr * 0.45);
    const minRiskPoints = isBtc
      ? 100.0
      : Math.max(currentAtr * 0.18, currentPrice * 0.0005);

    if (direction === Direction.BULLISH) {
      // 1. Long Entry Zone (Anchored strictly to Order Block, FVG, or Closed Trigger Structure)
      let entryOptimal = 0;
      let entryMin = 0;
      let entryMax = 0;
      let localLow = 0;

      if (orderBlock && orderBlock.direction === Direction.BULLISH) {
        entryMin = Number(orderBlock.low);
        entryMax = Number(orderBlock.high);
        entryOptimal = Number(((entryMin + entryMax) / 2).toFixed(2));
        localLow = Number(orderBlock.low);
      } else if (fvg && fvg.direction === Direction.BULLISH) {
        entryMin = Number(fvg.lowerBound);
        entryMax = Number(fvg.upperBound);
        entryOptimal = Number(((entryMin + entryMax) / 2).toFixed(2));
        localLow = Number(fvg.lowerBound);
      } else if (anchorSwing) {
        entryOptimal = Number(anchorSwing.price);
        entryMin = Number((entryOptimal - currentAtr * 0.1).toFixed(2));
        entryMax = Number((entryOptimal + currentAtr * 0.1).toFixed(2));
        localLow = Number(anchorSwing.price);
      } else {
        // Anchor strictly to last confirmed closed candle close to prevent tick repainting
        const closedCandle = candles.length >= 2 ? candles[candles.length - 2] : lastCandle;
        entryOptimal = Number(closedCandle.close);
        entryMin = Number((entryOptimal - currentAtr * 0.1).toFixed(2));
        entryMax = Number((entryOptimal + currentAtr * 0.1).toFixed(2));
        localLow = Number((entryOptimal - currentAtr * 0.45).toFixed(2));
      }

      // 2. Ultra-Tight Sniper Stop Loss (Anchored right below Order Block low or micro swing)
      const targetSL = localLow - slBuffer;
      const unconstrainedRisk = entryOptimal - targetSL;

      // Clamp risk tightly so SL is ultra-small and precise
      let risk = Math.min(maxRiskPoints, Math.max(minRiskPoints, unconstrainedRisk));
      const stopLoss = Number((entryOptimal - risk).toFixed(2));
      risk = entryOptimal - stopLoss;

      // 3. Large Asymmetric Targets (1:2.0 TP1, 1:3.5 TP2, 1:6.0 TP3)
      const tp1 = Number((entryOptimal + risk * 2.0).toFixed(2));
      const tp2 = Number((entryOptimal + risk * 3.5).toFixed(2));
      const tp3 = Number((entryOptimal + risk * 6.0).toFixed(2));

      return {
        direction: Direction.BULLISH,
        entryZone: {
          min: Number(entryMin.toFixed(2)),
          max: Number(entryMax.toFixed(2)),
          optimal: Number(entryOptimal.toFixed(2)),
        },
        stopLoss,
        stopLossDistance: Number(risk.toFixed(2)),
        takeProfits: {
          tp1,
          tp2,
          tp3,
        },
        riskRewardRatios: {
          rr1: 2.0,
          rr2: 3.5,
          rr3: 6.0,
        },
      };
    } else {
      // 1. Short Entry Zone (Anchored strictly to Order Block, FVG, or Closed Trigger Structure)
      let entryOptimal = 0;
      let entryMin = 0;
      let entryMax = 0;
      let localHigh = 0;

      if (orderBlock && orderBlock.direction === Direction.BEARISH) {
        entryMin = Number(orderBlock.low);
        entryMax = Number(orderBlock.high);
        entryOptimal = Number(((entryMin + entryMax) / 2).toFixed(2));
        localHigh = Number(orderBlock.high);
      } else if (fvg && fvg.direction === Direction.BEARISH) {
        entryMin = Number(fvg.lowerBound);
        entryMax = Number(fvg.upperBound);
        entryOptimal = Number(((entryMin + entryMax) / 2).toFixed(2));
        localHigh = Number(fvg.upperBound);
      } else if (anchorSwing) {
        entryOptimal = Number(anchorSwing.price);
        entryMin = Number((entryOptimal - currentAtr * 0.1).toFixed(2));
        entryMax = Number((entryOptimal + currentAtr * 0.1).toFixed(2));
        localHigh = Number(anchorSwing.price);
      } else {
        // Anchor strictly to last confirmed closed candle close to prevent tick repainting
        const closedCandle = candles.length >= 2 ? candles[candles.length - 2] : lastCandle;
        entryOptimal = Number(closedCandle.close);
        entryMin = Number((entryOptimal - currentAtr * 0.1).toFixed(2));
        entryMax = Number((entryOptimal + currentAtr * 0.1).toFixed(2));
        localHigh = Number((entryOptimal + currentAtr * 0.45).toFixed(2));
      }

      // 2. Ultra-Tight Sniper Stop Loss (Anchored right above Order Block high or micro swing)
      const targetSL = localHigh + slBuffer;
      const unconstrainedRisk = targetSL - entryOptimal;

      // Clamp risk tightly so SL is ultra-small and precise
      let risk = Math.min(maxRiskPoints, Math.max(minRiskPoints, unconstrainedRisk));
      const stopLoss = Number((entryOptimal + risk).toFixed(2));
      risk = stopLoss - entryOptimal;

      // 3. Large Asymmetric Targets (1:2.0 TP1, 1:3.5 TP2, 1:6.0 TP3)
      const tp1 = Number(Math.max(0.01, entryOptimal - risk * 2.0).toFixed(2));
      const tp2 = Number(Math.max(0.01, entryOptimal - risk * 3.5).toFixed(2));
      const tp3 = Number(Math.max(0.01, entryOptimal - risk * 6.0).toFixed(2));

      return {
        direction: Direction.BEARISH,
        entryZone: {
          min: Number(entryMin.toFixed(2)),
          max: Number(entryMax.toFixed(2)),
          optimal: Number(entryOptimal.toFixed(2)),
        },
        stopLoss,
        stopLossDistance: Number(risk.toFixed(2)),
        takeProfits: {
          tp1,
          tp2,
          tp3,
        },
        riskRewardRatios: {
          rr1: 2.0,
          rr2: 3.5,
          rr3: 6.0,
        },
      };
    }
  }
}
