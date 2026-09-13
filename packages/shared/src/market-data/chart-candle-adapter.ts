import { ICandle, DataProvenance } from '../interfaces';
import { ChartCandle } from './chart-snapshot.interface';

export class InvalidCandleSequenceError extends Error {
  constructor(reason: string) {
    super(`INVALID_CANDLE_SEQUENCE: ${reason}`);
    this.name = 'InvalidCandleSequenceError';
  }
}

export interface ICandleConversionResult {
  readonly candles: ICandle[];
  readonly isValid: boolean;
  readonly isDegraded: boolean;
  readonly degradationReason?: string;
  readonly invalidCandleCount: number;
}

/**
 * Type-safe adapter converting ChartCandle[] to ICandle[] for SMC analysis engines.
 * Validates that all OHLC and volume fields are finite numeric values and timestamps are strictly valid and sorted.
 * Surfaces explicit degradation when invalid or non-finite candles are encountered.
 */
export function chartCandlesToICandlesResult(closedCandles: ChartCandle[]): ICandleConversionResult {
  if (!Array.isArray(closedCandles)) {
    return {
      candles: [],
      isValid: false,
      isDegraded: true,
      degradationReason: 'closedCandles is not an array',
      invalidCandleCount: 1,
    };
  }

  const result: ICandle[] = [];
  let invalidCount = 0;
  let firstReason = '';
  let prevTime = -1;

  for (let i = 0; i < closedCandles.length; i++) {
    const c = closedCandles[i];
    if (!c || c.isClosed !== true) {
      invalidCount++;
      if (!firstReason) firstReason = `Candle at index ${i} is missing or isClosed !== true`;
      continue;
    }

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
      invalidCount++;
      if (!firstReason) firstReason = `Candle at index ${i} contains non-finite or non-positive OHLCV values`;
      continue;
    }

    const timeMs = new Date(c.timestamp).getTime();
    if (isNaN(timeMs)) {
      invalidCount++;
      if (!firstReason) firstReason = `Candle at index ${i} has invalid timestamp`;
      continue;
    }

    if (timeMs <= prevTime) {
      invalidCount++;
      if (!firstReason) firstReason = `Candle at index ${i} has non-chronological timestamp (${timeMs} <= ${prevTime})`;
      continue;
    }

    prevTime = timeMs;

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

  const isDegraded = invalidCount > 0;
  return {
    candles: result,
    isValid: !isDegraded,
    isDegraded,
    degradationReason: isDegraded ? firstReason : undefined,
    invalidCandleCount: invalidCount,
  };
}

/**
 * Adapter converting ChartCandle[] to ICandle[] for SMC analysis engines.
 * Fails closed by throwing an InvalidCandleSequenceError if invalid candles exist.
 */
export function chartCandlesToICandles(closedCandles: ChartCandle[]): ICandle[] {
  const conv = chartCandlesToICandlesResult(closedCandles);
  if (conv.isDegraded) {
    throw new InvalidCandleSequenceError(conv.degradationReason || 'Corrupted candle sequence detected');
  }
  return conv.candles;
}
