/**
 * Maps a MarketStreamContext ticker to the provider tick shape CanonicalCandleAggregator accepts.
 *
 * Stream tickers carry `marketEventTime`, but the aggregator requires `timestamp` (it never synthesizes
 * wall-clock time). Passing tickers through unmapped made the aggregator reject every live tick, so the
 * chart price stayed frozen at the initial REST fetch. Returns null for ticks that must not be applied.
 */
export function toAggregatorTick(
  symbol: string,
  ticker: any,
): { symbol: string; price: number; timestamp: string; providerId?: string; volume: undefined } | null {
  if (!ticker) return null;
  const eventTime = ticker.marketEventTime ?? ticker.timestamp;
  if (!eventTime || ticker.isFresh === false) return null;
  const price = Number(ticker.price);
  if (!Number.isFinite(price) || price <= 0) return null;
  return {
    symbol,
    price,
    timestamp: typeof eventTime === 'number' ? new Date(eventTime).toISOString() : String(eventTime),
    providerId: ticker.providerId,
    // The ticker's volume is a rolling 24h total, not per-tick volume: never add it to the candle.
    volume: undefined,
  };
}
