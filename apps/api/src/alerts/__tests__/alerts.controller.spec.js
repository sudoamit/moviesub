"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const testing_1 = require("@nestjs/testing");
const alerts_controller_1 = require("../alerts.controller");
const alerts_service_1 = require("../alerts.service");
const shared_1 = require("@quant/shared");
describe('AlertsController', () => {
    let controller;
    let service;
    const mockAlert = {
        id: 'alert-1',
        channel: 'TELEGRAM',
        target: '-100123456789',
        minScore: 80,
        minGrade: shared_1.SignalGrade.A,
        isActive: true,
    };
    beforeEach(async () => {
        service = {
            createAlert: jest.fn().mockResolvedValue(mockAlert),
            listAlerts: jest.fn().mockResolvedValue([mockAlert]),
            deleteAlert: jest.fn().mockResolvedValue(mockAlert),
            testAlert: jest.fn().mockResolvedValue({ success: true, channel: 'TELEGRAM' }),
        };
        const module = await testing_1.Test.createTestingModule({
            controllers: [alerts_controller_1.AlertsController],
            providers: [{ provide: alerts_service_1.AlertsService, useValue: service }],
        }).compile();
        controller = module.get(alerts_controller_1.AlertsController);
    });
    it('should create an alert rule', async () => {
        const res = await controller.createAlert({
            channel: 'TELEGRAM',
            target: '-100123456789',
            minScore: 80,
        });
        expect(res.channel).toBe('TELEGRAM');
        expect(res.minScore).toBe(80);
    });
    it('should list alert rules', async () => {
        const res = await controller.listAlerts();
        expect(res.length).toBe(1);
    });
    it('should test an alert dispatch', async () => {
        const res = await controller.testAlert({
            channel: 'TELEGRAM',
            target: '-100123456789',
        });
        expect(res.success).toBe(true);
    });
});
//# sourceMappingURL=alerts.controller.spec.js.map