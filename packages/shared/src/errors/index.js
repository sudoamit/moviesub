"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.StaleMarketDataError = exports.MarketDataUnavailableError = void 0;
class MarketDataUnavailableError extends Error {
    symbol;
    reason;
    sourceTimestamp;
    constructor(symbol, reason = 'Real-time market data is unavailable for execution', sourceTimestamp) {
        super(`[MARKET_DATA_UNAVAILABLE] Symbol '${symbol}': ${reason}`);
        this.name = 'MarketDataUnavailableError';
        this.symbol = symbol;
        this.reason = reason;
        this.sourceTimestamp = sourceTimestamp;
    }
}
exports.MarketDataUnavailableError = MarketDataUnavailableError;
class StaleMarketDataError extends Error {
    symbol;
    ageSeconds;
    maxAllowedSeconds;
    sourceTimestamp;
    constructor(symbol, ageSeconds, maxAllowedSeconds, sourceTimestamp) {
        super(`[STALE_MARKET_DATA] Market data for '${symbol}' is ${ageSeconds.toFixed(2)}s old (exceeds threshold of ${maxAllowedSeconds}s). Source time: ${sourceTimestamp.toISOString()}`);
        this.name = 'StaleMarketDataError';
        this.symbol = symbol;
        this.ageSeconds = ageSeconds;
        this.maxAllowedSeconds = maxAllowedSeconds;
        this.sourceTimestamp = sourceTimestamp;
    }
}
exports.StaleMarketDataError = StaleMarketDataError;
//# sourceMappingURL=index.js.map