import { ICandle, DataProvenance } from '../interfaces';
import { ChartCandle } from './chart-snapshot.interface';

/**
 * Type-safe adapter converting ChartCandle[] to ICandle[] for SMC analysis engines.
 * Ensures timestamps are guaranteed Date objects and avoids unsafe `as any` casts.
 */
export function chartCandlesToICandles(closedCandles: ChartCandle[]): ICandle[] {
  if (!Array.isArray(closedCandles)) return [];
  return closedCandles.map((c) => ({
    timestamp: c.timestamp instanceof Date ? c.timestamp : new Date(c.timestamp),
    open: Number(c.open),
    high: Number(c.high),
    low: Number(c.low),
    close: Number(c.close),
    volume: Number(c.volume),
    isClosed: true,
    provenance: (c.provenance as DataProvenance) || 'LIVE',
  }));
}
