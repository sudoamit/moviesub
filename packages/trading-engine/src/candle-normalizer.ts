import { ICandle } from '@quant/shared';

export interface ICandleNormalizerOptions {
  enforceSorted?: boolean;
  deduplicate?: boolean;
  validateOHLC?: boolean;
}

export class CandleNormalizer {
  /**
   * Validates single candle geometry and fields.
   */
  static validateCandle(c: ICandle): boolean {
    if (!c) return false;
    const dateObj = c.timestamp instanceof Date ? c.timestamp : new Date(c.timestamp);
    if (isNaN(dateObj.getTime())) return false;

    const open = Number(c.open);
    const high = Number(c.high);
    const low = Number(c.low);
    const close = Number(c.close);
    const volume = c.volume !== undefined ? Number(c.volume) : 0;

    if (
      isNaN(open) ||
      isNaN(high) ||
      isNaN(low) ||
      isNaN(close) ||
      isNaN(volume) ||
      open <= 0 ||
      high <= 0 ||
      low <= 0 ||
      close <= 0 ||
      volume < 0
    ) {
      return false;
    }

    if (
      high < low ||
      high < open ||
      high < close ||
      low > open ||
      low > close
    ) {
      return false;
    }

    return true;
  }

  /**
   * Validates, cleans, deduplicates, and sorts a candle array in strict chronological order.
   * Rejects malformed / NaN / negative / inconsistent candles.
   */
  static normalize(
    candles: ICandle[],
    options: ICandleNormalizerOptions = {},
  ): ICandle[] {
    if (!candles || candles.length === 0) {
      return [];
    }

    const enforceSorted = options.enforceSorted ?? true;
    const deduplicate = options.deduplicate ?? true;
    const validateOHLC = options.validateOHLC ?? true;

    // 1. Filter out completely invalid candle objects
    const validCandles: ICandle[] = [];

    for (let i = 0; i < candles.length; i++) {
      const c = candles[i];
      if (!c) continue;

      const dateObj = c.timestamp instanceof Date ? c.timestamp : new Date(c.timestamp);
      if (isNaN(dateObj.getTime())) {
        continue; // Invalid timestamp
      }

      const open = Number(c.open);
      const high = Number(c.high);
      const low = Number(c.low);
      const close = Number(c.close);
      const volume = c.volume !== undefined ? Number(c.volume) : 0;

      if (
        isNaN(open) ||
        isNaN(high) ||
        isNaN(low) ||
        isNaN(close) ||
        isNaN(volume) ||
        open <= 0 ||
        high <= 0 ||
        low <= 0 ||
        close <= 0 ||
        volume < 0
      ) {
        continue; // Reject non-positive or NaN prices/volumes
      }

      if (validateOHLC) {
        // Enforce strict high >= low, high >= open, high >= close, low <= open, low <= close
        if (
          high < low ||
          high < open ||
          high < close ||
          low > open ||
          low > close
        ) {
          continue; // Reject broken OHLC geometry
        }
      }

      validCandles.push({
        timestamp: dateObj,
        open,
        high,
        low,
        close,
        volume,
        isClosed: c.isClosed !== undefined ? Boolean(c.isClosed) : true,
      });
    }

    if (validCandles.length === 0) {
      return [];
    }

    // 2. Sort chronologically by timestamp ascending
    let sorted = validCandles;
    if (enforceSorted) {
      sorted = [...validCandles].sort(
        (a, b) => a.timestamp.getTime() - b.timestamp.getTime(),
      );
    }

    // 3. Deduplicate timestamps (keep the last occurrence if duplicates exist)
    if (deduplicate) {
      const deduped: ICandle[] = [];
      const seenTimestamps = new Map<number, number>();

      for (let i = 0; i < sorted.length; i++) {
        const t = sorted[i].timestamp.getTime();
        seenTimestamps.set(t, i);
      }

      for (let i = 0; i < sorted.length; i++) {
        const t = sorted[i].timestamp.getTime();
        if (seenTimestamps.get(t) === i) {
          deduped.push(sorted[i]);
        }
      }
      return deduped;
    }

    return sorted;
  }
}
