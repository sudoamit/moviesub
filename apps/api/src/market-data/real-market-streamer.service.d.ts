import { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { RedisService } from '../common/redis/redis.service';
interface ILiveRealTicker {
    symbol: string;
    price: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
    prevClose: number;
    changePercent: number;
    changeAmount: number;
    tickSize: number;
    volatility: number;
    lastUpdated: number;
}
export declare class RealMarketStreamerService implements OnModuleInit, OnModuleDestroy {
    private readonly redis;
    private readonly logger;
    private nseTimer;
    private binanceTimer;
    private microTickTimer;
    private tickers;
    constructor(redis: RedisService);
    onModuleInit(): void;
    startRealTimeFeeds(): void;
    private fetchRealBinancePrice;
    private fetchRealNSEQuotes;
    private broadcastTick;
    getTicker(symbol: string): ILiveRealTicker | undefined;
    /**
     * Retrieves live ticker with strict validation for trade execution:
     * 1. Price > 0
     * 2. Freshness check: age <= maxAgeSeconds (default 5s)
     * 3. Throws MarketDataUnavailableError or StaleMarketDataError on failure.
     */
    getValidatedTicker(symbol: string, maxAgeSeconds?: number): ILiveRealTicker;
    getAllTickers(): ILiveRealTicker[];
    onModuleDestroy(): void;
}
export {};
