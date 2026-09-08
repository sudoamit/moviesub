import { ExecutionPriceSource, TradingMode } from '../enums';
import { ICandle } from '../interfaces';
export interface ExecutionPriceResult {
    price: number;
    marketPrice: number;
    requestedPrice?: number;
    source: ExecutionPriceSource;
    sourceTimestamp: Date;
    fillTimestamp: Date;
    latencyMs: number;
    ageSeconds: number;
    slippageBps?: number;
    slippageAmount?: number;
}
export interface ResolveExecutionPriceOptions {
    symbol: string;
    tradingMode?: TradingMode;
    maxMarketDataAgeSeconds?: number;
    maxSlippageBps?: number;
    liveTick?: {
        price: number;
        timestamp: Date;
    } | null;
    getLatestCandle?: () => Promise<ICandle | null> | ICandle | null;
    direction?: 'BUY' | 'SELL' | 'BULLISH' | 'BEARISH';
    simulateSlippage?: boolean;
}
export interface ValidatedLiveTickerResult {
    price: number;
    timestamp: Date;
    ageSeconds: number;
}
export declare class ExecutionPriceResolver {
    static readonly DEFAULT_MAX_DATA_AGE_SECONDS = 5;
    static readonly DEFAULT_MAX_SLIPPAGE_BPS = 50;
    /**
     * Safely parses and validates live ticker data from Redis / streamer.
     * Enforces price > 0, valid timestamp, and data freshness <= maxAgeSeconds.
     * Returns null if missing, malformed, or stale (fail-closed).
     */
    static validateLiveTicker(tickerData: any, maxAgeSeconds?: number): ValidatedLiveTickerResult | null;
    /**
     * Resolves execution price from authoritative market data sources according to trading mode.
     * - LIVE / PAPER: Strictly requires fresh live tick (LIVE_TICK). Never falls back to candles.
     * - BACKTEST: Allows historical candle close with BACKTEST_CANDLE tag.
     * Fails closed by throwing MarketDataUnavailableError or StaleMarketDataError if no fresh price exists.
     */
    static resolveExecutionPrice(options: ResolveExecutionPriceOptions): Promise<ExecutionPriceResult>;
    /**
     * Calculates realistic market slippage in basis points (bps) within maxSlippageBps.
     * BUY orders slip upwards (+), SELL orders slip downwards (-).
     */
    static calculateSlippage(basePrice: number, direction: 'BUY' | 'SELL' | 'BULLISH' | 'BEARISH', maxSlippageBps?: number, fixedSlippageBps?: number): {
        fillPrice: number;
        slippageBps: number;
        slippageAmount: number;
    };
}
