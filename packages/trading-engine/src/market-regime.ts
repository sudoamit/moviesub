import {
  Direction,
  ICandle,
  IMarketRegime,
  ISwingPoint,
  MarketRegimeType,
  StructureType,
} from '@quant/shared';
import { calculateADX, calculateATR, calculateEMA } from '@quant/indicators';

export class MarketRegimeEngine {
  /**
   * Deterministically classifies the market regime using ADX, ATR, EMAs, and Price Structure.
   * NO LLM / AI hallucination used.
   */
  static classifyRegime(
    candles: ICandle[],
    swings: ISwingPoint[] = [],
  ): IMarketRegime {
    if (!candles || candles.length === 0) {
      return {
        regime: MarketRegimeType.RANGE,
        atr: 0,
        adx: 0,
        volatility: 0,
        timestamp: new Date(),
      };
    }

    const lastIdx = candles.length - 1;
    const lastCandle = candles[lastIdx];
    const closes = candles.map((c) => c.close);

    const atrSeries = calculateATR(candles, 14);
    const adxResult = calculateADX(candles, 14);
    const ema20Series = calculateEMA(closes, 20);
    const ema50Series = calculateEMA(closes, 50);
    const ema200Series = calculateEMA(closes, 200);

    const currentAtr = atrSeries[lastIdx] ?? (lastCandle.high - lastCandle.low);
    const currentAdx = adxResult.adx[lastIdx] ?? 15;
    const plusDI = adxResult.plusDI[lastIdx] ?? 20;
    const minusDI = adxResult.minusDI[lastIdx] ?? 20;

    const ema20 = ema20Series[lastIdx] ?? lastCandle.close;
    const ema50 = ema50Series[lastIdx] ?? lastCandle.close;
    const ema200 = ema200Series[lastIdx] ?? lastCandle.close;

    // Volatility measure: Normalized ATR % of price
    const atrPct = (currentAtr / Math.max(1, lastCandle.close)) * 100;
    const volatility = atrPct;

    // Historical ATR average comparison
    let atrSum = 0;
    let validAtrCount = 0;
    for (let k = Math.max(0, lastIdx - 50); k <= lastIdx; k++) {
      if (atrSeries[k] !== null) {
        atrSum += atrSeries[k]!;
        validAtrCount++;
      }
    }
    const avgAtr50 = validAtrCount > 0 ? atrSum / validAtrCount : currentAtr;
    const atrExpansionRatio = avgAtr50 > 0 ? currentAtr / avgAtr50 : 1.0;

    // Analyze recent structural swing bias
    const recentSwings = swings.slice(-4);
    const hasHH = recentSwings.some((s) => s.type === StructureType.HIGHER_HIGH);
    const hasHL = recentSwings.some((s) => s.type === StructureType.HIGHER_LOW);
    const hasLH = recentSwings.some((s) => s.type === StructureType.LOWER_HIGH);
    const hasLL = recentSwings.some((s) => s.type === StructureType.LOWER_LOW);

    let regime: MarketRegimeType = MarketRegimeType.RANGE;

    // Priority 1: High Volatility Shock (ATR expanding > 60% over 50-period average)
    if (atrExpansionRatio > 1.6) {
      regime = MarketRegimeType.HIGH_VOLATILITY;
    }
    // Priority 2: Strong Bullish Trend
    else if (
      currentAdx >= 22 &&
      plusDI > minusDI &&
      (lastCandle.close > ema50 || (hasHH && hasHL))
    ) {
      regime = MarketRegimeType.BULLISH_TREND;
    }
    // Priority 3: Strong Bearish Trend
    else if (
      currentAdx >= 22 &&
      minusDI > plusDI &&
      (lastCandle.close < ema50 || (hasLH && hasLL))
    ) {
      regime = MarketRegimeType.BEARISH_TREND;
    }
    // Priority 4: Low Volatility (ATR compressed < 65% of average)
    else if (atrExpansionRatio < 0.65 || currentAdx < 14) {
      regime = MarketRegimeType.LOW_VOLATILITY;
    }
    // Default: Range
    else {
      regime = MarketRegimeType.RANGE;
    }

    return {
      regime,
      atr: currentAtr,
      adx: currentAdx,
      volatility,
      timestamp: lastCandle.timestamp,
    };
  }
}
