"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const testing_1 = require("@nestjs/testing");
const scanner_controller_1 = require("../scanner.controller");
const scanner_service_1 = require("../scanner.service");
const shared_1 = require("@quant/shared");
describe('ScannerController', () => {
    let controller;
    let service;
    const mockScanSummary = {
        timestamp: new Date().toISOString(),
        timeframe: '15m',
        scannedCount: 6,
        signalsFound: 5,
        durationMs: 120,
        signals: [],
    };
    beforeEach(async () => {
        service = {
            triggerScan: jest.fn().mockResolvedValue(mockScanSummary),
            getScannerStatus: jest.fn().mockResolvedValue(mockScanSummary),
        };
        const module = await testing_1.Test.createTestingModule({
            controllers: [scanner_controller_1.ScannerController],
            providers: [{ provide: scanner_service_1.ScannerService, useValue: service }],
        }).compile();
        controller = module.get(scanner_controller_1.ScannerController);
    });
    it('should trigger market scan and return summary', async () => {
        const res = await controller.triggerScan(shared_1.Timeframe.M15);
        expect(res.scannedCount).toBe(6);
        expect(res.signalsFound).toBe(5);
    });
    it('should return scanner status', async () => {
        const res = await controller.getStatus();
        expect(res.scannedCount).toBe(6);
    });
});
//# sourceMappingURL=scanner.controller.spec.js.map