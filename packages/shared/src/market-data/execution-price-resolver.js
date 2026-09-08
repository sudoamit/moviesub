"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ExecutionPriceResolver = void 0;
const enums_1 = require("../enums");
const errors_1 = require("../errors");
class ExecutionPriceResolver {
    static DEFAULT_MAX_DATA_AGE_SECONDS = 5;
    static DEFAULT_MAX_SLIPPAGE_BPS = 50;
    /**
     * Safely parses and validates live ticker data from Redis / streamer.
     * Enforces price > 0, valid timestamp, and data freshness <= maxAgeSeconds.
     * Returns null if missing, malformed, or stale (fail-closed).
     */
    static validateLiveTicker(tickerData, maxAgeSeconds = this.DEFAULT_MAX_DATA_AGE_SECONDS) {
        if (!tickerData)
            return null;
        try {
            const parsed = typeof tickerData === 'string' ? JSON.parse(tickerData) : tickerData;
            const price = Number(parsed?.price);
            if (!Number.isFinite(price) || price <= 0)
                return null;
            const rawTimestamp = parsed.lastUpdated || parsed.timestamp;
            if (!rawTimestamp)
                return null;
            const tickTime = rawTimestamp instanceof Date
                ? rawTimestamp.getTime()
                : typeof rawTimestamp === 'number'
                    ? rawTimestamp
                    : new Date(rawTimestamp).getTime();
            if (!Number.isFinite(tickTime) || isNaN(tickTime))
                return null;
            const now = Date.now();
            // Reject ticks with timestamps in the future beyond 5s clock skew tolerance
            if (tickTime > now + 5000)
                return null;
            const ageSeconds = (now - tickTime) / 1000;
            if (ageSeconds < -5 || ageSeconds > maxAgeSeconds)
                return null;
            return {
                price,
                timestamp: new Date(tickTime),
                ageSeconds: Math.max(0, ageSeconds),
            };
        }
        catch {
            return null;
        }
    }
    /**
     * Resolves execution price from authoritative market data sources according to trading mode.
     * - LIVE / PAPER: Strictly requires fresh live tick (LIVE_TICK). Never falls back to candles.
     * - BACKTEST: Allows historical candle close with BACKTEST_CANDLE tag.
     * Fails closed by throwing MarketDataUnavailableError or StaleMarketDataError if no fresh price exists.
     */
    static async resolveExecutionPrice(options) {
        const { symbol, tradingMode = enums_1.TradingMode.PAPER, maxMarketDataAgeSeconds = this.DEFAULT_MAX_DATA_AGE_SECONDS, maxSlippageBps = this.DEFAULT_MAX_SLIPPAGE_BPS, liveTick, getLatestCandle, direction, simulateSlippage = false, } = options;
        const now = Date.now();
        // 1. Check BACKTEST Mode
        if (tradingMode === enums_1.TradingMode.BACKTEST) {
            if (liveTick && typeof liveTick.price === 'number' && Number.isFinite(liveTick.price) && liveTick.price > 0) {
                const tickTime = liveTick.timestamp instanceof Date ? liveTick.timestamp.getTime() : new Date(liveTick.timestamp).getTime();
                return {
                    price: liveTick.price,
                    marketPrice: liveTick.price,
                    source: enums_1.ExecutionPriceSource.BACKTEST_CANDLE,
                    sourceTimestamp: new Date(tickTime),
                    fillTimestamp: new Date(),
                    latencyMs: 0,
                    ageSeconds: 0,
                };
            }
            if (getLatestCandle) {
                const candle = await getLatestCandle();
                if (candle && typeof candle.close === 'number' && Number.isFinite(candle.close) && candle.close > 0) {
                    const candleTime = candle.timestamp instanceof Date ? candle.timestamp.getTime() : new Date(candle.timestamp).getTime();
                    return {
                        price: candle.close,
                        marketPrice: candle.close,
                        source: enums_1.ExecutionPriceSource.BACKTEST_CANDLE,
                        sourceTimestamp: new Date(candleTime),
                        fillTimestamp: new Date(),
                        latencyMs: 0,
                        ageSeconds: Math.max(0, (now - candleTime) / 1000),
                    };
                }
            }
            throw new errors_1.MarketDataUnavailableError(symbol, `No historical candle data found for symbol '${symbol}' in BACKTEST mode`);
        }
        // 2. LIVE / PAPER Mode: Strictly require validated fresh live tick (Zero candle fallback)
        if (!liveTick || typeof liveTick.price !== 'number' || !Number.isFinite(liveTick.price) || liveTick.price <= 0) {
            throw new errors_1.MarketDataUnavailableError(symbol, `No live tick available for symbol '${symbol}' in ${tradingMode} mode. Candle execution fallback is prohibited for live/paper trading.`);
        }
        const tickTime = liveTick.timestamp instanceof Date ? liveTick.timestamp.getTime() : new Date(liveTick.timestamp).getTime();
        if (!Number.isFinite(tickTime) || isNaN(tickTime)) {
            throw new errors_1.MarketDataUnavailableError(symbol, `Invalid live tick timestamp for symbol '${symbol}' in ${tradingMode} mode.`);
        }
        if (tickTime > now + 5000) {
            throw new errors_1.MarketDataUnavailableError(symbol, `Live tick timestamp for '${symbol}' is in the future beyond clock skew tolerance (5s).`);
        }
        const ageSeconds = (now - tickTime) / 1000;
        if (ageSeconds > maxMarketDataAgeSeconds) {
            throw new errors_1.StaleMarketDataError(symbol, ageSeconds, maxMarketDataAgeSeconds, new Date(tickTime));
        }
        const marketPrice = liveTick.price;
        let finalPrice = marketPrice;
        let slippageBps = 0;
        let slippageAmount = 0;
        if (simulateSlippage && direction) {
            const slip = this.calculateSlippage(marketPrice, direction, maxSlippageBps);
            finalPrice = slip.fillPrice;
            slippageBps = slip.slippageBps;
            slippageAmount = slip.slippageAmount;
        }
        return {
            price: finalPrice,
            marketPrice,
            source: enums_1.ExecutionPriceSource.LIVE_TICK,
            sourceTimestamp: new Date(tickTime),
            fillTimestamp: new Date(),
            latencyMs: Math.round(now - tickTime),
            ageSeconds: Math.max(0, ageSeconds),
            slippageBps,
            slippageAmount,
        };
    }
    /**
     * Calculates realistic market slippage in basis points (bps) within maxSlippageBps.
     * BUY orders slip upwards (+), SELL orders slip downwards (-).
     */
    static calculateSlippage(basePrice, direction, maxSlippageBps = this.DEFAULT_MAX_SLIPPAGE_BPS, fixedSlippageBps) {
        const isBuy = direction === 'BUY' || direction === 'BULLISH';
        const effectiveMaxBps = Math.max(0, maxSlippageBps);
        if (effectiveMaxBps === 0 || fixedSlippageBps === 0 || basePrice <= 0) {
            return {
                fillPrice: basePrice,
                slippageBps: 0,
                slippageAmount: 0,
            };
        }
        const simulatedBps = fixedSlippageBps !== undefined
            ? Math.min(Math.max(0, fixedSlippageBps), effectiveMaxBps)
            : Math.min(effectiveMaxBps, Math.max(1, Math.round(Math.random() * 8 + 2)));
        const slippageMultiplier = (simulatedBps / 10000);
        const slippageAmount = Number((basePrice * slippageMultiplier).toFixed(4));
        const fillPrice = isBuy
            ? Number((basePrice + slippageAmount).toFixed(4))
            : Number((basePrice - slippageAmount).toFixed(4));
        return {
            fillPrice,
            slippageBps: simulatedBps,
            slippageAmount,
        };
    }
}
exports.ExecutionPriceResolver = ExecutionPriceResolver;
//# sourceMappingURL=execution-price-resolver.js.map