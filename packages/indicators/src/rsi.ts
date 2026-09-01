import { ICandle } from '@quant/shared';
import { extractPrices } from './types';

/**
 * Calculates Relative Strength Index (RSI) using Wilder's smoothed averages
 */
export function calculateRSI(
  data: ICandle[] | number[],
  period = 14,
): (number | null)[] {
  if (!data || data.length === 0 || period <= 0) {
    return [];
  }

  const prices = typeof data[0] === 'number' ? (data as number[]) : extractPrices(data as ICandle[], 'close');
  const result: (number | null)[] = new Array(prices.length).fill(null);

  if (prices.length <= period) {
    return result;
  }

  const gains: number[] = [];
  const losses: number[] = [];

  for (let i = 1; i < prices.length; i++) {
    const change = prices[i] - prices[i - 1];
    gains.push(change > 0 ? change : 0);
    losses.push(change < 0 ? -change : 0);
  }

  // Initial averages over first 'period' changes
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 0; i < period; i++) {
    avgGain += gains[i];
    avgLoss += losses[i];
  }
  avgGain /= period;
  avgLoss /= period;

  if (avgLoss === 0) {
    result[period] = 100;
  } else {
    const rs = avgGain / avgLoss;
    result[period] = 100 - 100 / (1 + rs);
  }

  // Wilder's smoothing for subsequent bars
  for (let i = period; i < gains.length; i++) {
    avgGain = (avgGain * (period - 1) + gains[i]) / period;
    avgLoss = (avgLoss * (period - 1) + losses[i]) / period;

    if (avgLoss === 0) {
      result[i + 1] = 100;
    } else {
      const rs = avgGain / avgLoss;
      result[i + 1] = 100 - 100 / (1 + rs);
    }
  }

  return result;
}
