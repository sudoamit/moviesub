"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const testing_1 = require("@nestjs/testing");
const market_data_service_1 = require("../market-data.service");
const prisma_service_1 = require("../../common/prisma/prisma.service");
const redis_service_1 = require("../../common/redis/redis.service");
const shared_1 = require("@quant/shared");
describe('MarketDataService', () => {
    let service;
    let prismaService;
    let redisService;
    const mockInstrument = {
        id: 'inst-nifty',
        symbol: 'NIFTY',
    };
    beforeEach(async () => {
        prismaService = {
            instrument: {
                findUnique: jest.fn().mockImplementation(({ where }) => {
                    if (where.symbol === 'NIFTY')
                        return Promise.resolve(mockInstrument);
                    return Promise.resolve(null);
                }),
            },
            candle: {
                upsert: jest.fn().mockResolvedValue({ id: 'c-1' }),
                createMany: jest.fn().mockResolvedValue({ count: 1 }),
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
        const module = await testing_1.Test.createTestingModule({
            providers: [
                market_data_service_1.MarketDataService,
                { provide: prisma_service_1.PrismaService, useValue: prismaService },
                { provide: redis_service_1.RedisService, useValue: redisService },
            ],
        }).compile();
        service = module.get(market_data_service_1.MarketDataService);
    });
    it('should validate and ingest raw candles into database and Redis', async () => {
        const rawCandles = [
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
        const result = await service.ingestCandles('NIFTY', shared_1.Timeframe.M15, rawCandles);
        expect(result.validIngested).toBe(2);
        expect(result.invalidCount).toBe(0);
        expect(prismaService.candle.createMany).toHaveBeenCalledTimes(1);
        expect(prismaService.candle.upsert).toHaveBeenCalledTimes(1);
        expect(redisService.set).toHaveBeenCalledTimes(2); // Latest key + buffer key
    });
    it('should throw NotFoundException when instrument does not exist', async () => {
        await expect(service.ingestCandles('UNKNOWN', shared_1.Timeframe.M15, [])).rejects.toThrow("Instrument with symbol 'UNKNOWN' not found");
    });
});
//# sourceMappingURL=market-data.service.spec.js.map