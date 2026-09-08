import { PrismaService } from '../common/prisma/prisma.service';
import { RedisService } from '../common/redis/redis.service';
import { ICandle, IMarketDataProvider, Timeframe } from '@quant/shared';
export interface IIngestionSummary {
    symbol: string;
    timeframe: string;
    totalReceived: number;
    validIngested: number;
    invalidCount: number;
    duplicateCount: number;
}
export declare class MarketDataService {
    private readonly prisma;
    private readonly redis;
    private readonly logger;
    private provider;
    constructor(prisma: PrismaService, redis: RedisService);
    setProvider(provider: IMarketDataProvider): void;
    getProvider(): IMarketDataProvider;
    /**
     * Ingests a series of candles for an instrument, validates, persists to Postgres, and caches in Redis
     */
    ingestCandles(symbol: string, timeframe: Timeframe | string, rawCandles: ICandle[]): Promise<IIngestionSummary>;
    backfillHistoricalCandles(symbol: string, timeframe: Timeframe | string, limit?: number): Promise<IIngestionSummary>;
}
