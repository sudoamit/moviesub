import { ICandle } from '@quant/shared';

export interface ICandleNormalizerOptions {
  enforceSorted?: boolean;
  deduplicate?: boolean;
  validateOHLC?: boolean;
}

export class CandleNormalizer {
  static getTimeframeDurationMs(tf: string | number): number {
    const value = String(tf).toLowerCase().trim();
    if (value === '1m') return 60 * 1000;
    if (value === '3m') return 3 * 60 * 1000;
    if (value === '5m') return 5 * 60 * 1000;
    if (value === '15m') return 15 * 60 * 1000;
    if (value === '30m') return 30 * 60 * 1000;
    if (value === '1h' || value === '60m') return 60 * 60 * 1000;
    if (value === '2h') return 2 * 60 * 60 * 1000;
    if (value === '4h') return 4 * 60 * 60 * 1000;
    if (value === '1d' || value === 'd') return 24 * 60 * 60 * 1000;
    if (value === '1w' || value === 'w') return 7 * 24 * 60 * 60 * 1000;

    const unit = value.slice(-1);
    const amount = parseInt(value.slice(0, -1), 10) || 1;
    if (unit === 'm') return amount * 60 * 1000;
    if (unit === 'h') return amount * 60 * 60 * 1000;
    if (unit === 'd') return amount * 24 * 60 * 60 * 1000;
    if (unit === 'w') return amount * 7 * 24 * 60 * 60 * 1000;
    return 15 * 60 * 1000;
  }

  static getCandleCloseTimestamp(candle: ICandle, timeframe?: string | number): Date {
    const openTime = candle.timestamp instanceof Date ? candle.timestamp.getTime() : new Date(candle.timestamp).getTime();
    const durationMs = timeframe
      ? CandleNormalizer.getTimeframeDurationMs(timeframe)
      : 15 * 60 * 1000;
    return new Date(openTime + durationMs);
  }

  /**
   * Partitions candle series into confirmed closed candles and forming candle.
   * Forming candle is strictly isolated from confirmed structural analysis.
   */
  static partitionCandles(
    candles: ICandle[],
    options: { asOfTimestamp?: Date; timeframe?: string | number } = {},
  ): { closedCandles: ICandle[]; formingCandle: ICandle | null } {
    const normalized = CandleNormalizer.normalize(candles);
    if (normalized.length === 0) {
      return { closedCandles: [], formingCandle: null };
    }

    let durationMs: number;
    if (options.timeframe) {
      durationMs = CandleNormalizer.getTimeframeDurationMs(options.timeframe);
    } else if (normalized.length >= 2) {
      const diffs: number[] = [];
      for (let i = 1; i < Math.min(normalized.length, 5); i++) {
        const d = normalized[i].timestamp.getTime() - normalized[i - 1].timestamp.getTime();
        if (d > 0) diffs.push(d);
      }
      durationMs = diffs.length > 0 ? Math.min(...diffs) : 15 * 60 * 1000;
    } else {
      durationMs = 15 * 60 * 1000;
    }

    const asOfTime = options.asOfTimestamp ? options.asOfTimestamp.getTime() : null;

    let formingCandle: ICandle | null = null;
    const closedCandles: ICandle[] = [];

    for (let i = 0; i < normalized.length; i++) {
      const c = normalized[i];
      const cTime = c.timestamp.getTime();
      const cClose = cTime + durationMs;

      if (asOfTime !== null) {
        if (cTime > asOfTime) {
          // Future candle starting after asOfTimestamp
          continue;
        }
        if (cClose > asOfTime) {
          // Candle was in-progress / forming at asOfTimestamp
          formingCandle = c;
          continue;
        }
        // Candle was fully closed at or before asOfTimestamp
        if (c.isClosed !== false) {
          closedCandles.push(c);
        } else {
          formingCandle = c;
        }
      } else {
        if (c.isClosed === false) {
          formingCandle = c;
        } else {
          closedCandles.push(c);
        }
      }
    }

    // If last candle in list without asOfTimestamp is unclosed
    if (asOfTime === null && normalized[normalized.length - 1].isClosed === false) {
      formingCandle = normalized[normalized.length - 1];
    }

    return { closedCandles, formingCandle };
  }

  static getClosedCandlesAsOf(
    candles: ICandle[],
    timeframe: string | number | undefined,
    asOfTimestamp: Date,
  ): ICandle[] {
    const { closedCandles } = CandleNormalizer.partitionCandles(candles, {
      asOfTimestamp,
      timeframe,
    });
    return closedCandles;
  }

  /**
   * Detects missing historical intervals and returns list of gaps.
   */
  static detectGaps(
    candles: ICandle[],
    timeframe: string | number = '15m',
  ): Array<{ expectedTime: Date; actualTime: Date; missingCount: number }> {
    const normalized = CandleNormalizer.normalize(candles);
    if (normalized.length < 2) return [];

    const durationMs = CandleNormalizer.getTimeframeDurationMs(timeframe);
    const gaps: Array<{ startIndex: number; endIndex: number; expectedTime: Date; actualTime: Date; missingCount: number }> = [];

    for (let i = 1; i < normalized.length; i++) {
      const prevTime = normalized[i - 1].timestamp.getTime();
      const currTime = normalized[i].timestamp.getTime();
      const diffMs = currTime - prevTime;

      if (diffMs > durationMs * 1.5) {
        const missingCount = Math.round(diffMs / durationMs) - 1;
        gaps.push({
          startIndex: i - 1,
          endIndex: i,
          expectedTime: new Date(prevTime + durationMs),
          actualTime: new Date(currTime),
          missingCount,
        });
      }
    }

    return gaps;
  }

  /**
   * Validates if candles strictly align to timeframe boundaries (e.g. 15m -> :00, :15, :30, :45).
   */
  static validateAlignment(
    candles: ICandle[],
    timeframe: string | number = '15m',
  ): { isAligned: boolean; misalignedCandles: ICandle[] } {
    const normalized = CandleNormalizer.normalize(candles);
    const durationMs = CandleNormalizer.getTimeframeDurationMs(timeframe);
    const misaligned: ICandle[] = [];

    for (const c of normalized) {
      const timeMs = c.timestamp.getTime();
      if (timeMs % durationMs !== 0) {
        misaligned.push(c);
      }
    }

    return {
      isAligned: misaligned.length === 0,
      misalignedCandles: misaligned,
    };
  }

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
