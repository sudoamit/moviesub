"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const testing_1 = require("@nestjs/testing");
const instruments_controller_1 = require("./instruments.controller");
const instruments_service_1 = require("./instruments.service");
const common_1 = require("@nestjs/common");
const shared_1 = require("@quant/shared");
describe('InstrumentsController', () => {
    let controller;
    let service;
    const mockInstrument = {
        id: 'inst-1',
        symbol: 'NIFTY',
        name: 'NIFTY 50 Index',
        exchange: 'NSE',
        assetType: shared_1.AssetType.INDEX,
        tickSize: 0.05,
        lotSize: 25,
        contractSize: 1,
        currency: 'INR',
        isActive: true,
    };
    beforeEach(async () => {
        service = {
            findAll: jest.fn().mockResolvedValue([mockInstrument]),
            findBySymbol: jest.fn().mockImplementation((sym) => {
                if (sym === 'NIFTY')
                    return Promise.resolve(mockInstrument);
                return Promise.resolve(null);
            }),
        };
        const module = await testing_1.Test.createTestingModule({
            controllers: [instruments_controller_1.InstrumentsController],
            providers: [{ provide: instruments_service_1.InstrumentsService, useValue: service }],
        }).compile();
        controller = module.get(instruments_controller_1.InstrumentsController);
    });
    it('should return all instruments', async () => {
        const result = await controller.getInstruments();
        expect(result).toHaveLength(1);
        expect(result[0].symbol).toBe('NIFTY');
    });
    it('should return instrument by symbol', async () => {
        const result = await controller.getInstrument('NIFTY');
        expect(result.symbol).toBe('NIFTY');
    });
    it('should throw NotFoundException if symbol does not exist', async () => {
        await expect(controller.getInstrument('UNKNOWN')).rejects.toThrow(common_1.NotFoundException);
    });
});
//# sourceMappingURL=instruments.controller.spec.js.map