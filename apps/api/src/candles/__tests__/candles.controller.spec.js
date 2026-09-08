"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const testing_1 = require("@nestjs/testing");
const candles_controller_1 = require("../candles.controller");
const candles_service_1 = require("../candles.service");
const shared_1 = require("@quant/shared");
describe('CandlesController', () => {
    let controller;
    let service;
    const mockCandlesResponse = {
        symbol: 'NIFTY',
        timeframe: '15m',
        count: 2,
        candles: [
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
        ],
    };
    beforeEach(async () => {
        service = {
            getCandles: jest.fn().mockResolvedValue(mockCandlesResponse),
            getLatestCandle: jest.fn().mockResolvedValue(mockCandlesResponse.candles[1]),
            ingestCandles: jest.fn().mockResolvedValue({
                symbol: 'NIFTY',
                timeframe: '15m',
                totalReceived: 50,
                validIngested: 50,
            }),
        };
        const module = await testing_1.Test.createTestingModule({
            controllers: [candles_controller_1.CandlesController],
            providers: [{ provide: candles_service_1.CandlesService, useValue: service }],
        }).compile();
        controller = module.get(candles_controller_1.CandlesController);
    });
    it('should return historical candles for valid query', async () => {
        const res = await controller.getCandles({
            symbol: 'NIFTY',
            timeframe: shared_1.Timeframe.M15,
            limit: 100,
        });
        expect(res.symbol).toBe('NIFTY');
        expect(res.count).toBe(2);
        expect(res.candles).toHaveLength(2);
    });
    it('should return latest candle', async () => {
        const res = await controller.getLatestCandle('NIFTY', shared_1.Timeframe.M15);
        expect(res.close).toBe(24860);
    });
});
//# sourceMappingURL=candles.controller.spec.js.map