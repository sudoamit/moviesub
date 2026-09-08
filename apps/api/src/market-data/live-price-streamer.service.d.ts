import { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { RedisService } from '../common/redis/redis.service';
interface IAssetTicker {
    symbol: string;
    price: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
    prevClose: number;
    tickSize: number;
    volatility: number;
    candleStartTime: number;
}
export declare class LivePriceStreamerService implements OnModuleInit, OnModuleDestroy {
    private readonly redis;
    private readonly logger;
    private timer;
    private tickers;
    constructor(redis: RedisService);
    onModuleInit(): void;
    startStreaming(): void;
    private generateTicks;
    getTicker(symbol: string): IAssetTicker | undefined;
    getAllTickers(): IAssetTicker[];
    onModuleDestroy(): void;
}
export {};
