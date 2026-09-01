/**
 * Calculates Simple Moving Average (SMA)
 * @param values Array of numbers (e.g. close prices)
 * @param period Lookback period
 */
export function calculateSMA(values: number[], period: number): (number | null)[] {
  if (period <= 0 || !values || values.length === 0) {
    return [];
  }

  const result: (number | null)[] = new Array(values.length).fill(null);
  let sum = 0;

  for (let i = 0; i < values.length; i++) {
    sum += values[i];

    if (i >= period) {
      sum -= values[i - period];
    }

    if (i >= period - 1) {
      result[i] = sum / period;
    }
  }

  return result;
}
