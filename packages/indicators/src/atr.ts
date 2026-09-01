import { ICandle } from '@quant/shared';

/**
 * Calculates True Range (TR) for each candle
 */
export function calculateTrueRange(candles: ICandle[]): number[] {
  if (!candles || candles.length === 0) return [];

  const tr: number[] = new Array(candles.length);
  tr[0] = candles[0].high - candles[0].low;

  for (let i = 1; i < candles.length; i++) {
    const high = candles[i].high;
    const low = candles[i].low;
    const prevClose = candles[i - 1].close;

    const hl = high - low;
    const hpc = Math.abs(high - prevClose);
    const lpc = Math.abs(low - prevClose);

    tr[i] = Math.max(hl, hpc, lpc);
  }

  return tr;
}

/**
 * Calculates Average True Range (ATR) using standard Wilder's smoothing
 */
export function calculateATR(candles: ICandle[], period = 14): (number | null)[] {
  if (!candles || candles.length === 0 || period <= 0) {
    return [];
  }

  const result: (number | null)[] = new Array(candles.length).fill(null);
  if (candles.length < period) {
    return result;
  }

  const tr = calculateTrueRange(candles);

  // Initial ATR seed: SMA of first 'period' TR values
  let sum = 0;
  for (let i = 0; i < period; i++) {
    sum += tr[i];
  }
  let prevAtr = sum / period;
  result[period - 1] = prevAtr;

  // Wilder's smoothing
  for (let i = period; i < candles.length; i++) {
    const currentAtr = (prevAtr * (period - 1) + tr[i]) / period;
    result[i] = currentAtr;
    prevAtr = currentAtr;
  }

  return result;
}
