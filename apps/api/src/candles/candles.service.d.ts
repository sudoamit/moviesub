import { PrismaService } from '../common/prisma/prisma.service';
import { RedisService } from '../common/redis/redis.service';
import { MarketDataService } from '../market-data/market-data.service';
import { ICandle, Timeframe } from '@quant/shared';
import { GetCandlesDto, IngestCandlesDto } from './dto/get-candles.dto';
export interface ICandlesResponse {
    symbol: string;
    timeframe: string;
    count: number;
    candles: ICandle[];
}
export interface IChartDataResponse {
    instrument: {
        symbol: string;
        name: string;
        currency: string;
        tickSize: number;
    };
    timeframe: string;
    candles: Array<{
        time: number;
        open: number;
        high: number;
        low: number;
        close: number;
        volume: number;
    }>;
    indicators: {
        ema20: Array<{
            time: number;
            value: number;
        }>;
        ema50: Array<{
            time: number;
            value: number;
        }>;
        ema200: Array<{
            time: number;
            value: number;
        }>;
        sma20: Array<{
            time: number;
            value: number;
        }>;
        vwap: Array<{
            time: number;
            value: number;
        }>;
        rsi14: Array<{
            time: number;
            value: number;
        }>;
        atr14: Array<{
            time: number;
            value: number;
        }>;
        bollinger: Array<{
            time: number;
            upper: number;
            middle: number;
            lower: number;
        }>;
    };
    structures: {
        swings: any[];
        bos: any[];
        choch: any[];
        marketRegime: any;
        dealingRange: any;
    };
    liquidity: {
        pools: any[];
        sweeps: any[];
    };
    fvgs: any[];
    orderBlocks: any[];
    activeSignal: any | null;
}
export declare class CandlesService {
    private readonly prisma;
    private readonly redis;
    private readonly marketDataService;
    private readonly logger;
    private candleCache;
    constructor(prisma: PrismaService, redis: RedisService, marketDataService: MarketDataService);
    /**
     * Fetches real live exchange candlestick history (Yahoo Finance for NSE, Binance for Crypto)
     */
    private fetchRealExchangeCandles;
    getCandles(query: GetCandlesDto): Promise<ICandlesResponse>;
    getChartData(symbol: string, timeframe?: Timeframe, limit?: number): Promise<IChartDataResponse>;
    getLatestCandle(symbol: string, timeframe: Timeframe | string): Promise<ICandle>;
    ingestCandles(dto: IngestCandlesDto): Promise<import("../market-data/market-data.service").IIngestionSummary>;
}
