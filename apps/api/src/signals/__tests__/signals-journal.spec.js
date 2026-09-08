"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const testing_1 = require("@nestjs/testing");
const signals_service_1 = require("../signals.service");
const prisma_service_1 = require("../../common/prisma/prisma.service");
const candles_service_1 = require("../../candles/candles.service");
const common_1 = require("@nestjs/common");
describe('SignalsService Journal Validation & Integrity', () => {
    let service;
    let mockPrisma;
    let mockCandlesService;
    beforeEach(async () => {
        mockPrisma = {
            instrument: {
                findUnique: jest.fn().mockResolvedValue({
                    id: 'inst-nifty',
                    symbol: 'NIFTY',
                    name: 'Nifty 50',
                    currency: 'INR',
                }),
            },
            signal: {
                findFirst: jest.fn().mockResolvedValue(null),
                findMany: jest.fn().mockResolvedValue([]),
                create: jest
                    .fn()
                    .mockImplementation((args) => Promise.resolve({ id: 'sig-rec-1', ...args.data })),
            },
        };
        mockCandlesService = {
            getCandles: jest.fn().mockResolvedValue({ candles: [] }),
        };
        const module = await testing_1.Test.createTestingModule({
            providers: [
                signals_service_1.SignalsService,
                { provide: prisma_service_1.PrismaService, useValue: mockPrisma },
                { provide: candles_service_1.CandlesService, useValue: mockCandlesService },
            ],
        }).compile();
        service = module.get(signals_service_1.SignalsService);
    });
    it('should record completed trade with valid immutable entry and exit data', async () => {
        const activatedAt = new Date('2026-09-03T09:30:00.000Z');
        const closedAt = new Date('2026-09-03T10:15:00.000Z');
        const result = await service.recordCompletedTrade({
            symbol: 'NIFTY',
            contractSymbol: 'NIFTY 24100 PE',
            instrumentType: 'OPTION',
            strike: 24100,
            optionType: 'PE',
            direction: 'BEARISH',
            state: 'TP2_HIT',
            entryPrice: 50.0,
            stopLoss: 30.0,
            target1: 80.0,
            target2: 110.0,
            exitPrice: 110.0,
            pnlAmount: 3900.0,
            pnlRMultiple: 3.0,
            exitReason: 'Target 2 Hit',
            activatedAt,
            closedAt,
        });
        expect(result).toBeDefined();
        expect(mockPrisma.signal.create).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({
                entryPrice: 50.0,
                exitPrice: 110.0,
                pnlAmount: 3900.0,
                pnlRMultiple: 3.0,
                activatedAt,
                closedAt,
            }),
        }));
    });
    it('should reject trade recording if entryPrice is non-positive or invalid', async () => {
        await expect(service.recordCompletedTrade({
            symbol: 'NIFTY',
            direction: 'BULLISH',
            state: 'TP1_HIT',
            entryPrice: 0,
            stopLoss: 24000,
            target1: 24200,
            target2: 24300,
            exitPrice: 24200,
            pnlAmount: 1000,
            pnlRMultiple: 1.5,
            exitReason: 'TP1',
            activatedAt: new Date(),
            closedAt: new Date(),
        })).rejects.toThrow(common_1.BadRequestException);
    });
    it('should reject trade recording if exitPrice is non-positive or invalid', async () => {
        await expect(service.recordCompletedTrade({
            symbol: 'NIFTY',
            direction: 'BULLISH',
            state: 'TP1_HIT',
            entryPrice: 24100,
            stopLoss: 24000,
            target1: 24200,
            target2: 24300,
            exitPrice: -50,
            pnlAmount: -1000,
            pnlRMultiple: -1.0,
            exitReason: 'Invalid',
            activatedAt: new Date(),
            closedAt: new Date(),
        })).rejects.toThrow(common_1.BadRequestException);
    });
    it('should reject trade recording if closedAt timestamp is before activatedAt', async () => {
        const activatedAt = new Date('2026-09-03T10:00:00.000Z');
        const closedAt = new Date('2026-09-03T09:00:00.000Z'); // earlier than activatedAt
        await expect(service.recordCompletedTrade({
            symbol: 'NIFTY',
            direction: 'BULLISH',
            state: 'TP1_HIT',
            entryPrice: 24100,
            stopLoss: 24000,
            target1: 24200,
            target2: 24300,
            exitPrice: 24200,
            pnlAmount: 1000,
            pnlRMultiple: 1.5,
            exitReason: 'TP1',
            activatedAt,
            closedAt,
        })).rejects.toThrow(common_1.BadRequestException);
    });
    it('should deduplicate existing identical trade records', async () => {
        const activatedAt = new Date('2026-09-03T09:30:00.000Z');
        const closedAt = new Date('2026-09-03T10:15:00.000Z');
        const existingRecord = {
            id: 'sig-existing',
            instrumentId: 'inst-nifty',
            entryPrice: 50.0,
            exitPrice: 110.0,
            activatedAt,
            closedAt,
        };
        mockPrisma.signal.findFirst.mockResolvedValue(existingRecord);
        const result = await service.recordCompletedTrade({
            symbol: 'NIFTY',
            direction: 'BEARISH',
            state: 'TP2_HIT',
            entryPrice: 50.0,
            stopLoss: 30.0,
            target1: 80.0,
            target2: 110.0,
            exitPrice: 110.0,
            pnlAmount: 3900.0,
            pnlRMultiple: 3.0,
            exitReason: 'Target 2 Hit',
            activatedAt,
            closedAt,
        });
        expect(result).toBe(existingRecord);
        expect(mockPrisma.signal.create).not.toHaveBeenCalled();
    });
    it('should generate tax-compliant CSV export with fee breakdown and headers', async () => {
        const mockCompletedTrades = [
            {
                id: 'sig-trade-1',
                instrument: { symbol: 'NIFTY', name: 'Nifty 50', currency: 'INR' },
                direction: 'BEARISH',
                state: 'TP2_HIT',
                grade: 'A_PLUS',
                score: 95,
                timeframe: 'M15',
                entryPrice: 50.0,
                stopLoss: 30.0,
                target1: 80.0,
                target2: 110.0,
                exitPrice: 110.0,
                pnlAmount: 3840.0,
                pnlRMultiple: 3.0,
                reasonsJson: {
                    contractSymbol: 'NIFTY 24100 PE',
                    instrumentType: 'OPTION',
                    strike: 24100,
                    optionType: 'PE',
                    quantity: 65,
                    tradeReason: 'NIFTY 24100 PE Bearish Execution',
                    exitReason: 'TP2 Hit',
                },
                activatedAt: new Date('2026-09-03T09:30:00.000Z'),
                closedAt: new Date('2026-09-03T10:15:00.000Z'),
            },
        ];
        mockPrisma.signal.findMany.mockResolvedValue(mockCompletedTrades);
        const { filename, csvContent } = await service.exportTradesToCsv();
        expect(filename).toContain('quant-trade-journal-tax-report-');
        expect(filename).toContain('.csv');
        expect(csvContent).toContain('Trade ID,Symbol,Contract,Asset Type');
        expect(csvContent).toContain('Turnover (INR)');
        expect(csvContent).toContain('Brokerage (INR)');
        expect(csvContent).toContain('STT (INR)');
        expect(csvContent).toContain('GST 18% (INR)');
        expect(csvContent).toContain('NIFTY 24100 PE');
        expect(csvContent).toContain('3840.00');
    });
});
//# sourceMappingURL=signals-journal.spec.js.map