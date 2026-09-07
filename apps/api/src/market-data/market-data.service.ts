import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { RedisService } from '../common/redis/redis.service';
import {
  CandleValidator,
  ICandle,
  IMarketDataProvider,
  RealLiveMarketDataProvider,
  REDIS_KEYS,
  Timeframe,
  toPrismaTimeframe,
  WS_EVENTS,
} from '@quant/shared';
import { Decimal } from '@prisma/client/runtime/library';

export interface IIngestionSummary {
  symbol: string;
  timeframe: string;
  totalReceived: number;
  validIngested: number;
  invalidCount: number;
  duplicateCount: number;
}

@Injectable()
export class MarketDataService {
  private readonly logger = new Logger(MarketDataService.name);
  private provider: IMarketDataProvider;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {
    this.provider = new RealLiveMarketDataProvider();
  }

  setProvider(provider: IMarketDataProvider) {
    this.provider = provider;
  }

  getProvider(): IMarketDataProvider {
    return this.provider;
  }

  /**
   * Ingests a series of candles for an instrument, validates, persists to Postgres, and caches in Redis
   */
  async ingestCandles(
    symbol: string,
    timeframe: Timeframe | string,
    rawCandles: ICandle[],
  ): Promise<IIngestionSummary> {
    const sym = symbol.toUpperCase();
    const inst = await this.prisma.instrument.findUnique({
      where: { symbol: sym },
    });

    if (!inst) {
      throw new NotFoundException(`Instrument with symbol '${sym}' not found`);
    }

    const { validCandles, invalidCount, duplicateCount } =
      CandleValidator.normalizeAndCleanSeries(rawCandles);

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

    const tfEnum = toPrismaTimeframe(timeframe);

    // High-Throughput Batch Persistence to PostgreSQL
    const candleData = validCandles.map((c) => ({
      instrumentId: inst.id,
      timeframe: tfEnum,
      timestamp: c.timestamp,
      open: new Decimal(c.open),
      high: new Decimal(c.high),
      low: new Decimal(c.low),
      close: new Decimal(c.close),
      volume: new Decimal(c.volume),
      isClosed: c.isClosed ?? true,
    }));

    // Perform batch insert skipping duplicates
    if (this.prisma.candle?.createMany) {
      await this.prisma.candle.createMany({
        data: candleData,
        skipDuplicates: true,
      });
    } else {
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
            open: new Decimal(candle.open),
            high: new Decimal(candle.high),
            low: new Decimal(candle.low),
            close: new Decimal(candle.close),
            volume: new Decimal(candle.volume),
            isClosed: candle.isClosed ?? true,
          },
          create: {
            instrumentId: inst.id,
            timeframe: tfEnum,
            timestamp: candle.timestamp,
            open: new Decimal(candle.open),
            high: new Decimal(candle.high),
            low: new Decimal(candle.low),
            close: new Decimal(candle.close),
            volume: new Decimal(candle.volume),
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
          open: new Decimal(latest.open),
          high: new Decimal(latest.high),
          low: new Decimal(latest.low),
          close: new Decimal(latest.close),
          volume: new Decimal(latest.volume),
          isClosed: latest.isClosed ?? true,
        },
        create: {
          instrumentId: inst.id,
          timeframe: tfEnum,
          timestamp: latest.timestamp,
          open: new Decimal(latest.open),
          high: new Decimal(latest.high),
          low: new Decimal(latest.low),
          close: new Decimal(latest.close),
          volume: new Decimal(latest.volume),
          isClosed: latest.isClosed ?? true,
        },
      });
    }

    // Update Redis latest candle cache
    const latestCandle = validCandles[validCandles.length - 1];
    const latestKey = REDIS_KEYS.LATEST_CANDLE(sym, timeframe);
    await this.redis.set(latestKey, JSON.stringify(latestCandle), 86400);

    // Update Redis recent buffer
    const bufferKey = REDIS_KEYS.CANDLE_BUFFER(sym, timeframe);
    const existingBufferRaw = await this.redis.get(bufferKey);
    let existingBuffer: ICandle[] = [];
    if (existingBufferRaw) {
      try {
        existingBuffer = JSON.parse(existingBufferRaw);
      } catch (e) {
        existingBuffer = [];
      }
    }

    const mergedMap = new Map<number, ICandle>();
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
      await redisClient.publish(
        WS_EVENTS.CANDLE_UPDATED,
        JSON.stringify({
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
        }),
      );
    }

    this.logger.log(
      `Ingested ${validCandles.length} real market candles for ${sym} (${timeframe}). Invalid: ${invalidCount}, Duplicates: ${duplicateCount}`,
    );

    return {
      symbol: sym,
      timeframe,
      totalReceived: rawCandles.length,
      validIngested: validCandles.length,
      invalidCount,
      duplicateCount,
    };
  }

  async backfillHistoricalCandles(
    symbol: string,
    timeframe: Timeframe | string,
    limit = 200,
  ): Promise<IIngestionSummary> {
    const rawCandles = await this.provider.getHistoricalCandles(
      symbol,
      timeframe as Timeframe,
      limit,
    );
    return this.ingestCandles(symbol, timeframe, rawCandles);
  }
}
