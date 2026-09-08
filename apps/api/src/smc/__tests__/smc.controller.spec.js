"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const testing_1 = require("@nestjs/testing");
const smc_controller_1 = require("../smc.controller");
const smc_service_1 = require("../smc.service");
const shared_1 = require("@quant/shared");
describe('SMCController', () => {
    let controller;
    let service;
    const mockAnalysis = {
        symbol: 'NIFTY',
        timeframe: '15m',
        candlesCount: 100,
        swingPoints: [],
        breaksOfStructure: [],
        changesOfCharacter: [],
        liquidityPools: [],
        liquiditySweeps: [],
        fairValueGaps: [],
        activeFVGs: [],
        orderBlocks: [],
        activeOrderBlocks: [],
        dealingRange: null,
        marketRegime: {
            regime: shared_1.MarketRegimeType.BULLISH_TREND,
            atr: 50,
            adx: 28,
            volatility: 0.2,
            timestamp: new Date(),
        },
        currentTrend: shared_1.Direction.BULLISH,
    };
    beforeEach(async () => {
        service = {
            getSMCAnalysis: jest.fn().mockResolvedValue(mockAnalysis),
            getMarketStructure: jest.fn().mockResolvedValue({
                symbol: 'NIFTY',
                timeframe: '15m',
                swingPoints: [],
                breaksOfStructure: [],
                changesOfCharacter: [],
                currentTrend: shared_1.Direction.BULLISH,
            }),
            getLiquidity: jest.fn().mockResolvedValue({
                symbol: 'NIFTY',
                timeframe: '15m',
                pools: [],
                sweeps: [],
            }),
            getFairValueGaps: jest.fn().mockResolvedValue({
                symbol: 'NIFTY',
                timeframe: '15m',
                allFVGs: [],
                activeFVGs: [],
            }),
            getOrderBlocks: jest.fn().mockResolvedValue({
                symbol: 'NIFTY',
                timeframe: '15m',
                allOrderBlocks: [],
                activeOrderBlocks: [],
            }),
            getMarketRegime: jest.fn().mockResolvedValue({
                symbol: 'NIFTY',
                timeframe: '15m',
                regime: mockAnalysis.marketRegime,
                dealingRange: null,
            }),
        };
        const module = await testing_1.Test.createTestingModule({
            controllers: [smc_controller_1.SMCController],
            providers: [{ provide: smc_service_1.SMCService, useValue: service }],
        }).compile();
        controller = module.get(smc_controller_1.SMCController);
    });
    it('should return market structure for symbol', async () => {
        const res = await controller.getMarketStructure('NIFTY', shared_1.Timeframe.M15);
        expect(res.symbol).toBe('NIFTY');
        expect(res.currentTrend).toBe(shared_1.Direction.BULLISH);
    });
    it('should return market regime', async () => {
        const res = await controller.getMarketRegime('NIFTY', shared_1.Timeframe.M15);
        expect(res.regime.regime).toBe(shared_1.MarketRegimeType.BULLISH_TREND);
    });
});
//# sourceMappingURL=smc.controller.spec.js.map