"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const testing_1 = require("@nestjs/testing");
const backtests_controller_1 = require("../backtests.controller");
const backtests_service_1 = require("../backtests.service");
const shared_1 = require("@quant/shared");
describe('BacktestsController', () => {
    let controller;
    let service;
    const mockBacktestResult = {
        id: 'bt-123',
        symbol: 'NIFTY',
        timeframe: '15m',
        totalTrades: 12,
        winningTrades: 8,
        losingTrades: 4,
        winRate: 66.67,
        profitFactor: 2.4,
        netPnL: 8500,
        expectancy: 0.8,
        maxDrawdownPercent: 3.2,
        trades: [],
    };
    beforeEach(async () => {
        service = {
            runBacktest: jest.fn().mockResolvedValue(mockBacktestResult),
            listBacktests: jest.fn().mockResolvedValue([mockBacktestResult]),
            getBacktestById: jest.fn().mockResolvedValue(mockBacktestResult),
        };
        const module = await testing_1.Test.createTestingModule({
            controllers: [backtests_controller_1.BacktestsController],
            providers: [{ provide: backtests_service_1.BacktestsService, useValue: service }],
        }).compile();
        controller = module.get(backtests_controller_1.BacktestsController);
    });
    it('should run backtest and return metrics', async () => {
        const res = await controller.runBacktest({
            symbol: 'NIFTY',
            timeframe: shared_1.Timeframe.M15,
            initialCapital: 100000,
        });
        expect(res.symbol).toBe('NIFTY');
        expect(res.winRate).toBe(66.67);
    });
    it('should get backtest by id', async () => {
        const res = await controller.getBacktestById('bt-123');
        expect(res.id).toBe('bt-123');
    });
});
//# sourceMappingURL=backtests.controller.spec.js.map