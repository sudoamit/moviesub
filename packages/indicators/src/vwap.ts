import { ICandle } from '@quant/shared';

/**
 * Calculates Volume Weighted Average Price (VWAP)
 */
export function calculateVWAP(candles: ICandle[]): (number | null)[] {
  if (!candles || candles.length === 0) {
    return [];
  }

  const result: (number | null)[] = new Array(candles.length);
  let cumTypicalVolume = 0;
  let cumVolume = 0;

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const typicalPrice = (c.high + c.low + c.close) / 3;
    const vol = c.volume;

    cumTypicalVolume += typicalPrice * vol;
    cumVolume += vol;

    if (cumVolume === 0) {
      result[i] = typicalPrice;
    } else {
      result[i] = cumTypicalVolume / cumVolume;
    }
  }

  return result;
}
