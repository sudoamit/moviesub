import { ICandle } from '@quant/shared';
import { IIndicatorSummary, extractPrices } from './types';
import { calculateEMA } from './ema';
import { calculateSMA } from './sma';
import { calculateRSI } from './rsi';
import { calculateATR } from './atr';
import { calculateADX } from './adx';
import { calculateBollingerBands } from './bollinger';
import { calculateVWAP } from './vwap';

/**
 * Calculates a comprehensive snapshot of primary technical indicators for the latest candle
 */
export function calculateIndicatorSummary(candles: ICandle[]): IIndicatorSummary {
  if (!candles || candles.length === 0) {
    return {
      ema9: null,
      ema20: null,
      ema50: null,
      ema200: null,
      sma20: null,
      sma50: null,
      rsi14: null,
      atr14: null,
      adx14: null,
      plusDI: null,
      minusDI: null,
      bollingerUpper: null,
      bollingerMiddle: null,
      bollingerLower: null,
      vwap: null,
    };
  }

  const lastIdx = candles.length - 1;
  const closes = extractPrices(candles, 'close');

  const ema9 = calculateEMA(closes, 9);
  const ema20 = calculateEMA(closes, 20);
  const ema50 = calculateEMA(closes, 50);
  const ema200 = calculateEMA(closes, 200);

  const sma20 = calculateSMA(closes, 20);
  const sma50 = calculateSMA(closes, 50);

  const rsi14 = calculateRSI(candles, 14);
  const atr14 = calculateATR(candles, 14);
  const adx14 = calculateADX(candles, 14);
  const bb20 = calculateBollingerBands(candles, 20, 2);
  const vwap = calculateVWAP(candles);

  return {
    ema9: ema9[lastIdx] ?? null,
    ema20: ema20[lastIdx] ?? null,
    ema50: ema50[lastIdx] ?? null,
    ema200: ema200[lastIdx] ?? null,
    sma20: sma20[lastIdx] ?? null,
    sma50: sma50[lastIdx] ?? null,
    rsi14: rsi14[lastIdx] ?? null,
    atr14: atr14[lastIdx] ?? null,
    adx14: adx14.adx[lastIdx] ?? null,
    plusDI: adx14.plusDI[lastIdx] ?? null,
    minusDI: adx14.minusDI[lastIdx] ?? null,
    bollingerUpper: bb20.upper[lastIdx] ?? null,
    bollingerMiddle: bb20.middle[lastIdx] ?? null,
    bollingerLower: bb20.lower[lastIdx] ?? null,
    vwap: vwap[lastIdx] ?? null,
  };
}
