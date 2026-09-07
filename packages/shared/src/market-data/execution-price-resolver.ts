import { ExecutionPriceSource } from '../enums';
import { ICandle } from '../interfaces';
import { MarketDataUnavailableError, StaleMarketDataError } from '../errors';

export interface ExecutionPriceResult {
  price: number;
  source: ExecutionPriceSource;
  sourceTimestamp: Date;
  latencyMs: number;
  ageSeconds: number;
}

export interface ResolveExecutionPriceOptions {
  symbol: string;
  maxMarketDataAgeSeconds?: number;
  liveTick?: { price: number; timestamp: Date } | null;
  getLatestCandle?: () => Promise<ICandle | null> | ICandle | null;
}

export class ExecutionPriceResolver {
  public static readonly DEFAULT_MAX_DATA_AGE_SECONDS = 5;

  /**
   * Resolves execution price from authoritative market data sources.
   * Priority:
   * 1. Fresh real-time tick (LIVE_TICK)
   * 2. Fresh latest candle close (LATEST_CANDLE)
   * Fails closed by throwing MarketDataUnavailableError or StaleMarketDataError if no fresh price exists.
   */
  public static async resolveExecutionPrice(
    options: ResolveExecutionPriceOptions,
  ): Promise<ExecutionPriceResult> {
    const {
      symbol,
      maxMarketDataAgeSeconds = this.DEFAULT_MAX_DATA_AGE_SECONDS,
      liveTick,
      getLatestCandle,
    } = options;

    const now = Date.now();

    // 1. Check Live Tick
    if (liveTick && typeof liveTick.price === 'number' && Number.isFinite(liveTick.price) && liveTick.price > 0) {
      const tickTime = liveTick.timestamp instanceof Date ? liveTick.timestamp.getTime() : new Date(liveTick.timestamp).getTime();
      const ageSeconds = Math.max(0, (now - tickTime) / 1000);

      if (ageSeconds <= maxMarketDataAgeSeconds) {
        return {
          price: liveTick.price,
          source: ExecutionPriceSource.LIVE_TICK,
          sourceTimestamp: new Date(tickTime),
          latencyMs: Math.round((now - tickTime)),
          ageSeconds,
        };
      }
    }

    // 2. Check Latest Candle if Live Tick was missing or stale
    if (getLatestCandle) {
      try {
        const candle = await getLatestCandle();
        if (candle && typeof candle.close === 'number' && Number.isFinite(candle.close) && candle.close > 0) {
          const candleTime = candle.timestamp instanceof Date ? candle.timestamp.getTime() : new Date(candle.timestamp).getTime();
          const ageSeconds = Math.max(0, (now - candleTime) / 1000);

          if (ageSeconds <= maxMarketDataAgeSeconds) {
            return {
              price: candle.close,
              source: ExecutionPriceSource.LATEST_CANDLE,
              sourceTimestamp: new Date(candleTime),
              latencyMs: Math.round((now - candleTime)),
              ageSeconds,
            };
          } else {
            // Candle exists but is stale
            throw new StaleMarketDataError(
              symbol,
              ageSeconds,
              maxMarketDataAgeSeconds,
              new Date(candleTime),
            );
          }
        }
      } catch (err) {
        if (err instanceof StaleMarketDataError || err instanceof MarketDataUnavailableError) {
          throw err;
        }
        throw new MarketDataUnavailableError(
          symbol,
          `Failed to retrieve latest candle: ${(err as Error).message}`,
        );
      }
    }

    // If live tick was supplied but stale, and candle was not provided/available
    if (liveTick && liveTick.timestamp) {
      const tickTime = liveTick.timestamp instanceof Date ? liveTick.timestamp.getTime() : new Date(liveTick.timestamp).getTime();
      const ageSeconds = Math.max(0, (now - tickTime) / 1000);
      throw new StaleMarketDataError(
        symbol,
        ageSeconds,
        maxMarketDataAgeSeconds,
        new Date(tickTime),
      );
    }

    // No market data available at all
    throw new MarketDataUnavailableError(
      symbol,
      `No live tick or recent candle data found for symbol '${symbol}'`,
    );
  }
}
