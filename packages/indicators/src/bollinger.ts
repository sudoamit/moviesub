import { ICandle } from '@quant/shared';
import { IBollingerBandsResult, extractPrices } from './types';
import { calculateSMA } from './sma';

/**
 * Calculates Bollinger Bands (Upper, Middle, Lower, Bandwidth, %B)
 */
export function calculateBollingerBands(
  data: ICandle[] | number[],
  period = 20,
  stdDevMultiplier = 2,
): IBollingerBandsResult {
  if (!data || data.length === 0 || period <= 0) {
    return { upper: [], middle: [], lower: [], bandwidth: [], percentB: [] };
  }

  const prices = typeof data[0] === 'number' ? (data as number[]) : extractPrices(data as ICandle[], 'close');
  const len = prices.length;

  const middle = calculateSMA(prices, period);
  const upper: (number | null)[] = new Array(len).fill(null);
  const lower: (number | null)[] = new Array(len).fill(null);
  const bandwidth: (number | null)[] = new Array(len).fill(null);
  const percentB: (number | null)[] = new Array(len).fill(null);

  for (let i = period - 1; i < len; i++) {
    const ma = middle[i]!;
    let varianceSum = 0;

    for (let j = i - period + 1; j <= i; j++) {
      const diff = prices[j] - ma;
      varianceSum += diff * diff;
    }

    const stdDev = Math.sqrt(varianceSum / period);
    const up = ma + stdDevMultiplier * stdDev;
    const low = ma - stdDevMultiplier * stdDev;

    upper[i] = up;
    lower[i] = low;

    if (ma !== 0) {
      bandwidth[i] = (up - low) / ma;
    }

    const width = up - low;
    if (width !== 0) {
      percentB[i] = (prices[i] - low) / width;
    } else {
      percentB[i] = 0.5;
    }
  }

  return { upper, middle, lower, bandwidth, percentB };
}
