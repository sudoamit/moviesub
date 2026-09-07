import { calculateEMA } from './ema';

export interface IMACDResult {
  macd: (number | null)[];
  signal: (number | null)[];
  histogram: (number | null)[];
}

/**
 * Calculates MACD (Moving Average Convergence Divergence)
 */
export function calculateMACD(
  prices: number[],
  fastPeriod = 12,
  slowPeriod = 26,
  signalPeriod = 9,
): IMACDResult {
  const len = prices.length;
  if (!prices || len === 0) {
    return { macd: [], signal: [], histogram: [] };
  }

  const fastEMA = calculateEMA(prices, fastPeriod);
  const slowEMA = calculateEMA(prices, slowPeriod);

  const macdLine: (number | null)[] = new Array(len).fill(null);
  const validMacdValues: number[] = [];
  const validMacdIndices: number[] = [];

  for (let i = 0; i < len; i++) {
    const fast = fastEMA[i];
    const slow = slowEMA[i];
    if (fast !== null && slow !== null) {
      const val = fast - slow;
      macdLine[i] = val;
      validMacdValues.push(val);
      validMacdIndices.push(i);
    }
  }

  const signalEMA = calculateEMA(validMacdValues, signalPeriod);
  const signalLine: (number | null)[] = new Array(len).fill(null);
  const histogram: (number | null)[] = new Array(len).fill(null);

  for (let k = 0; k < validMacdValues.length; k++) {
    const origIdx = validMacdIndices[k];
    const sig = signalEMA[k];
    signalLine[origIdx] = sig;
    if (sig !== null && macdLine[origIdx] !== null) {
      histogram[origIdx] = macdLine[origIdx]! - sig;
    }
  }

  return { macd: macdLine, signal: signalLine, histogram };
}
