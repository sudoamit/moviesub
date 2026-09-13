import { ICandle, DataProvenance } from '../interfaces';
import { ChartCandle } from './chart-snapshot.interface';

/**
 * Type-safe adapter converting ChartCandle[] to ICandle[] for SMC analysis engines.
 * Validates that all OHLC and volume fields are finite numeric values and timestamps are valid.
 * Rejects any candle containing NaN, Infinity, non-finite values, or invalid timestamps.
 */
export function chartCandlesToICandles(closedCandles: ChartCandle[]): ICandle[] {
  if (!Array.isArray(closedCandles)) return [];
  const result: ICandle[] = [];

  for (const c of closedCandles) {
    if (!c || c.isClosed !== true) continue;

    const open = Number(c.open);
    const high = Number(c.high);
    const low = Number(c.low);
    const close = Number(c.close);
    const volume = Number(c.volume);

    if (
      !Number.isFinite(open) ||
      !Number.isFinite(high) ||
      !Number.isFinite(low) ||
      !Number.isFinite(close) ||
      !Number.isFinite(volume) ||
      open <= 0 ||
      high <= 0 ||
      low <= 0 ||
      close <= 0 ||
      volume < 0
    ) {
      continue; // Skip invalid or non-finite candle
    }

    const timeMs = new Date(c.timestamp).getTime();
    if (isNaN(timeMs)) {
      continue; // Skip candle with invalid timestamp
    }

    result.push({
      timestamp: c.timestamp instanceof Date ? c.timestamp : new Date(timeMs),
      open,
      high,
      low,
      close,
      volume,
      isClosed: true,
      provenance: (c.provenance as DataProvenance) || 'LIVE',
    });
  }

  return result;
}
