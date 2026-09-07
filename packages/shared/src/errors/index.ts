export class MarketDataUnavailableError extends Error {
  public readonly symbol: string;
  public readonly reason: string;
  public readonly sourceTimestamp?: Date;

  constructor(symbol: string, reason = 'Real-time market data is unavailable for execution', sourceTimestamp?: Date) {
    super(`[MARKET_DATA_UNAVAILABLE] Symbol '${symbol}': ${reason}`);
    this.name = 'MarketDataUnavailableError';
    this.symbol = symbol;
    this.reason = reason;
    this.sourceTimestamp = sourceTimestamp;
  }
}

export class StaleMarketDataError extends Error {
  public readonly symbol: string;
  public readonly ageSeconds: number;
  public readonly maxAllowedSeconds: number;
  public readonly sourceTimestamp: Date;

  constructor(symbol: string, ageSeconds: number, maxAllowedSeconds: number, sourceTimestamp: Date) {
    super(
      `[STALE_MARKET_DATA] Market data for '${symbol}' is ${ageSeconds.toFixed(2)}s old (exceeds threshold of ${maxAllowedSeconds}s). Source time: ${sourceTimestamp.toISOString()}`,
    );
    this.name = 'StaleMarketDataError';
    this.symbol = symbol;
    this.ageSeconds = ageSeconds;
    this.maxAllowedSeconds = maxAllowedSeconds;
    this.sourceTimestamp = sourceTimestamp;
  }
}
