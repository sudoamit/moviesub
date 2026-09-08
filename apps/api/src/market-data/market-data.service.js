"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var MarketDataService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.MarketDataService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../common/prisma/prisma.service");
const redis_service_1 = require("../common/redis/redis.service");
const shared_1 = require("@quant/shared");
const library_1 = require("@prisma/client/runtime/library");
let MarketDataService = MarketDataService_1 = class MarketDataService {
    prisma;
    redis;
    logger = new common_1.Logger(MarketDataService_1.name);
    provider;
    constructor(prisma, redis) {
        this.prisma = prisma;
        this.redis = redis;
        this.provider = new shared_1.RealLiveMarketDataProvider();
    }
    setProvider(provider) {
        this.provider = provider;
    }
    getProvider() {
        return this.provider;
    }
    /**
     * Ingests a series of candles for an instrument, validates, persists to Postgres, and caches in Redis
     */
    async ingestCandles(symbol, timeframe, rawCandles) {
        const sym = symbol.toUpperCase();
        const inst = await this.prisma.instrument.findUnique({
            where: { symbol: sym },
        });
        if (!inst) {
            throw new common_1.NotFoundException(`Instrument with symbol '${sym}' not found`);
        }
        const { validCandles, invalidCount, duplicateCount } = shared_1.CandleValidator.normalizeAndCleanSeries(rawCandles);
        if (validCandles.length === 0) {
            return {
                symbol: sym,
                timeframe,
                totalReceived: rawCandles.length,
                validIngested: 0,
                invalidCount,
                duplicateCount,
            };
        }
        const tfEnum = (0, shared_1.toPrismaTimeframe)(timeframe);
        // High-Throughput Batch Persistence to PostgreSQL
        const candleData = validCandles.map((c) => ({
            instrumentId: inst.id,
            timeframe: tfEnum,
            timestamp: c.timestamp,
            open: new library_1.Decimal(c.open),
            high: new library_1.Decimal(c.high),
            low: new library_1.Decimal(c.low),
            close: new library_1.Decimal(c.close),
            volume: new library_1.Decimal(c.volume),
            isClosed: c.isClosed ?? true,
        }));
        // Perform batch insert skipping duplicates
        if (this.prisma.candle?.createMany) {
            await this.prisma.candle.createMany({
                data: candleData,
                skipDuplicates: true,
            });
        }
        else {
            for (const candle of validCandles) {
                await this.prisma.candle.upsert({
                    where: {
                        instrumentId_timeframe_timestamp: {
                            instrumentId: inst.id,
                            timeframe: tfEnum,
                            timestamp: candle.timestamp,
                        },
                    },
                    update: {
                        open: new library_1.Decimal(candle.open),
                        high: new library_1.Decimal(candle.high),
                        low: new library_1.Decimal(candle.low),
                        close: new library_1.Decimal(candle.close),
                        volume: new library_1.Decimal(candle.volume),
                        isClosed: candle.isClosed ?? true,
                    },
                    create: {
                        instrumentId: inst.id,
                        timeframe: tfEnum,
                        timestamp: candle.timestamp,
                        open: new library_1.Decimal(candle.open),
                        high: new library_1.Decimal(candle.high),
                        low: new library_1.Decimal(candle.low),
                        close: new library_1.Decimal(candle.close),
                        volume: new library_1.Decimal(candle.volume),
                        isClosed: candle.isClosed ?? true,
                    },
                });
            }
        }
        // Update the most recent candle in case of in-progress candle updates
        if (validCandles.length > 0) {
            const latest = validCandles[validCandles.length - 1];
            await this.prisma.candle.upsert({
                where: {
                    instrumentId_timeframe_timestamp: {
                        instrumentId: inst.id,
                        timeframe: tfEnum,
                        timestamp: latest.timestamp,
                    },
                },
                update: {
                    open: new library_1.Decimal(latest.open),
                    high: new library_1.Decimal(latest.high),
                    low: new library_1.Decimal(latest.low),
                    close: new library_1.Decimal(latest.close),
                    volume: new library_1.Decimal(latest.volume),
                    isClosed: latest.isClosed ?? true,
                },
                create: {
                    instrumentId: inst.id,
                    timeframe: tfEnum,
                    timestamp: latest.timestamp,
                    open: new library_1.Decimal(latest.open),
                    high: new library_1.Decimal(latest.high),
                    low: new library_1.Decimal(latest.low),
                    close: new library_1.Decimal(latest.close),
                    volume: new library_1.Decimal(latest.volume),
                    isClosed: latest.isClosed ?? true,
                },
            });
        }
        // Update Redis latest candle cache
        const latestCandle = validCandles[validCandles.length - 1];
        const latestKey = shared_1.REDIS_KEYS.LATEST_CANDLE(sym, timeframe);
        await this.redis.set(latestKey, JSON.stringify(latestCandle), 86400);
        // Update Redis recent buffer
        const bufferKey = shared_1.REDIS_KEYS.CANDLE_BUFFER(sym, timeframe);
        const existingBufferRaw = await this.redis.get(bufferKey);
        let existingBuffer = [];
        if (existingBufferRaw) {
            try {
                existingBuffer = JSON.parse(existingBufferRaw);
            }
            catch (e) {
                existingBuffer = [];
            }
        }
        const mergedMap = new Map();
        for (const c of existingBuffer) {
            mergedMap.set(new Date(c.timestamp).getTime(), c);
        }
        for (const c of validCandles) {
            mergedMap.set(c.timestamp.getTime(), c);
        }
        const sortedBuffer = Array.from(mergedMap.values())
            .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
            .slice(-500);
        await this.redis.set(bufferKey, JSON.stringify(sortedBuffer), 86400);
        // Publish Redis event
        const redisClient = this.redis.getClient();
        if (redisClient && redisClient.status === 'ready') {
            await redisClient.publish(shared_1.WS_EVENTS.CANDLE_UPDATED, JSON.stringify({
                symbol: sym,
                timeframe,
                candle: latestCandle,
                price: latestCandle.close,
                close: latestCandle.close,
                open: latestCandle.open,
                high: latestCandle.high,
                low: latestCandle.low,
                volume: latestCandle.volume,
                isRealMarket: true,
            }));
        }
        this.logger.log(`Ingested ${validCandles.length} real market candles for ${sym} (${timeframe}). Invalid: ${invalidCount}, Duplicates: ${duplicateCount}`);
        return {
            symbol: sym,
            timeframe,
            totalReceived: rawCandles.length,
            validIngested: validCandles.length,
            invalidCount,
            duplicateCount,
        };
    }
    async backfillHistoricalCandles(symbol, timeframe, limit = 200) {
        const rawCandles = await this.provider.getHistoricalCandles(symbol, timeframe, limit);
        return this.ingestCandles(symbol, timeframe, rawCandles);
    }
};
exports.MarketDataService = MarketDataService;
exports.MarketDataService = MarketDataService = MarketDataService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        redis_service_1.RedisService])
], MarketDataService);
//# sourceMappingURL=market-data.service.js.map