import { createHash } from 'crypto';
import { ICandle } from '@quant/shared';
import { CandidateMarketDataset } from './types';

export interface IValidateMarketDatasetOptions {
  maxAllowedGapCount?: number;
  expectedIntervalMs?: number;
}

export class MarketDatasetValidator {
  /**
   * Resolves expected timeframe interval in milliseconds.
   */
  public static resolveTimeframeIntervalMs(timeframe: string): number {
    const tf = timeframe.toLowerCase().trim();
    if (tf === '1m') return 60 * 1000;
    if (tf === '3m') return 3 * 60 * 1000;
    if (tf === '5m') return 5 * 60 * 1000;
    if (tf === '15m') return 15 * 60 * 1000;
    if (tf === '30m') return 30 * 60 * 1000;
    if (tf === '1h' || tf === '60m') return 60 * 60 * 1000;
    if (tf === '4h') return 4 * 60 * 60 * 1000;
    if (tf === '1d' || tf === '24h') return 24 * 60 * 60 * 1000;
    return 15 * 60 * 1000; // Default 15m
  }

  /**
   * Strictly validates and constructs a continuous CandidateMarketDataset.
   * Fails closed on:
   * - Empty or missing candle array (< 2 candles)
   * - Non-increasing or duplicate timestamps
   * - Invalid OHLC prices (high < low, negative prices)
   * - Unexplained gaps
   */
  public static validateAndCreateDataset(
    candles: ICandle[],
    timeframe = '15m',
    higherTimeframeCandles?: Record<string, ICandle[]>,
    options?: IValidateMarketDatasetOptions,
  ): CandidateMarketDataset {
    if (!candles || candles.length === 0) {
      throw new Error('INSUFFICIENT_CONTINUOUS_MARKET_DATA: Candle array is empty');
    }

    const expectedIntervalMs =
      options?.expectedIntervalMs || this.resolveTimeframeIntervalMs(timeframe);
    const maxAllowedGapCount = options?.maxAllowedGapCount ?? 0;

    let gapCount = 0;
    const normalizedCandles: ICandle[] = [];

    for (let i = 0; i < candles.length; i++) {
      const c = candles[i];
      const rawTs = c.timestamp instanceof Date ? c.timestamp.getTime() : new Date(c.timestamp).getTime();

      if (isNaN(rawTs)) {
        throw new Error(`INVALID_MARKET_DATA: Invalid timestamp at index ${i}`);
      }

      // OHLC Sanity checks
      if (
        c.open <= 0 ||
        c.high <= 0 ||
        c.low <= 0 ||
        c.close <= 0 ||
        c.high < c.low ||
        c.high < c.open ||
        c.high < c.close ||
        c.low > c.open ||
        c.low > c.close
      ) {
        throw new Error(
          `INVALID_MARKET_DATA_OHLC: Inconsistent OHLC values at index ${i}: O=${c.open}, H=${c.high}, L=${c.low}, C=${c.close}`,
        );
      }

      if (i > 0) {
        const prevTs = normalizedCandles[i - 1].timestamp instanceof Date
          ? (normalizedCandles[i - 1].timestamp as Date).getTime()
          : new Date(normalizedCandles[i - 1].timestamp).getTime();

        if (rawTs === prevTs) {
          throw new Error(`INVALID_MARKET_DATA_DUPLICATE_TIMESTAMP: Duplicate timestamp ${rawTs} at index ${i}`);
        }

        if (rawTs < prevTs) {
          throw new Error(
            `INVALID_MARKET_DATA_OUT_OF_ORDER: Timestamp ${rawTs} is earlier than previous timestamp ${prevTs} at index ${i}`,
          );
        }

        const delta = rawTs - prevTs;
        if (delta !== expectedIntervalMs) {
          gapCount++;
          if (gapCount > maxAllowedGapCount && delta > expectedIntervalMs * 3) {
            throw new Error(
              `INVALID_MARKET_DATA_GAP: Detected unexplained gap of ${delta}ms (expected ${expectedIntervalMs}ms) at index ${i}`,
            );
          }
        }
      }

      normalizedCandles.push({
        ...c,
        timestamp: c.timestamp instanceof Date ? c.timestamp : new Date(rawTs),
        open: Number(c.open),
        high: Number(c.high),
        low: Number(c.low),
        close: Number(c.close),
        volume: Number(c.volume || 0),
      });
    }

    // Validate higher timeframe candles if provided
    const validatedHtf: Record<string, ICandle[]> = {};
    if (higherTimeframeCandles) {
      for (const [htfName, htfCandles] of Object.entries(higherTimeframeCandles)) {
        if (htfCandles && htfCandles.length > 0) {
          const htfTfMs = this.resolveTimeframeIntervalMs(htfName);
          const normHtf: ICandle[] = [];
          for (let k = 0; k < htfCandles.length; k++) {
            const hc = htfCandles[k];
            const hts = hc.timestamp instanceof Date ? hc.timestamp.getTime() : new Date(hc.timestamp).getTime();
            if (k > 0) {
              const prevHts = normHtf[k - 1].timestamp instanceof Date
                ? (normHtf[k - 1].timestamp as Date).getTime()
                : new Date(normHtf[k - 1].timestamp).getTime();
              if (hts <= prevHts) {
                throw new Error(
                  `INVALID_HTF_MARKET_DATA: Out-of-order or duplicate HTF timestamp at index ${k} for ${htfName}`,
                );
              }
            }
            normHtf.push({
              ...hc,
              timestamp: hc.timestamp instanceof Date ? hc.timestamp : new Date(hts),
              open: Number(hc.open),
              high: Number(hc.high),
              low: Number(hc.low),
              close: Number(hc.close),
              volume: Number(hc.volume || 0),
            });
          }
          validatedHtf[htfName] = normHtf;
        }
      }
    }

    const startTimestamp = normalizedCandles[0].timestamp instanceof Date
      ? normalizedCandles[0].timestamp.getTime()
      : new Date(normalizedCandles[0].timestamp).getTime();
    const endTimestamp = normalizedCandles[normalizedCandles.length - 1].timestamp instanceof Date
      ? normalizedCandles[normalizedCandles.length - 1].timestamp.getTime()
      : new Date(normalizedCandles[normalizedCandles.length - 1].timestamp).getTime();

    // Canonical dataset hash computation
    const hashPayload = JSON.stringify({
      timeframe,
      candleCount: normalizedCandles.length,
      startTimestamp,
      endTimestamp,
      firstCandle: [
        normalizedCandles[0].open,
        normalizedCandles[0].high,
        normalizedCandles[0].low,
        normalizedCandles[0].close,
      ],
      lastCandle: [
        normalizedCandles[normalizedCandles.length - 1].open,
        normalizedCandles[normalizedCandles.length - 1].high,
        normalizedCandles[normalizedCandles.length - 1].low,
        normalizedCandles[normalizedCandles.length - 1].close,
      ],
    });
    const datasetHash = createHash('sha256').update(hashPayload).digest('hex');

    return {
      executionCandles: normalizedCandles,
      higherTimeframeCandles: Object.keys(validatedHtf).length > 0 ? validatedHtf : undefined,
      startTimestamp,
      endTimestamp,
      timeframe,
      datasetHash,
    };
  }
}
