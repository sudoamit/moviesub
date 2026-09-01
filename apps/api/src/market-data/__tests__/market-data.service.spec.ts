import { Test, TestingModule } from '@nestjs/testing';
import { MarketDataService } from '../market-data.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RedisService } from '../../common/redis/redis.service';
import { ICandle, Timeframe } from '@quant/shared';

describe('MarketDataService', () => {
  let service: MarketDataService;
  let prismaService: any;
  let redisService: any;

  const mockInstrument = {
    id: 'inst-nifty',
    symbol: 'NIFTY',
  };

  beforeEach(async () => {
    prismaService = {
      instrument: {
        findUnique: jest.fn().mockImplementation(({ where }) => {
          if (where.symbol === 'NIFTY') return Promise.resolve(mockInstrument);
          return Promise.resolve(null);
        }),
      },
      candle: {
        upsert: jest.fn().mockResolvedValue({ id: 'c-1' }),
      },
    };

    redisService = {
      set: jest.fn().mockResolvedValue('OK'),
      get: jest.fn().mockResolvedValue(null),
      getClient: jest.fn().mockReturnValue({
        status: 'ready',
        publish: jest.fn().mockResolvedValue(1),
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MarketDataService,
        { provide: PrismaService, useValue: prismaService },
        { provide: RedisService, useValue: redisService },
      ],
    }).compile();

    service = module.get<MarketDataService>(MarketDataService);
  });

  it('should validate and ingest raw candles into database and Redis', async () => {
    const rawCandles: ICandle[] = [
      {
        timestamp: new Date('2026-08-28T09:15:00Z'),
        open: 24800,
        high: 24850,
        low: 24780,
        close: 24820,
        volume: 10000,
      },
      {
        timestamp: new Date('2026-08-28T09:30:00Z'),
        open: 24820,
        high: 24870,
        low: 24810,
        close: 24860,
        volume: 12000,
      },
    ];

    const result = await service.ingestCandles('NIFTY', Timeframe.M15, rawCandles);

    expect(result.validIngested).toBe(2);
    expect(result.invalidCount).toBe(0);
    expect(prismaService.candle.upsert).toHaveBeenCalledTimes(2);
    expect(redisService.set).toHaveBeenCalledTimes(2); // Latest key + buffer key
  });

  it('should throw NotFoundException when instrument does not exist', async () => {
    await expect(service.ingestCandles('UNKNOWN', Timeframe.M15, [])).rejects.toThrow(
      "Instrument with symbol 'UNKNOWN' not found",
    );
  });
});
