"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const testing_1 = require("@nestjs/testing");
const signals_controller_1 = require("../signals.controller");
const signals_service_1 = require("../signals.service");
const shared_1 = require("@quant/shared");
describe('SignalsController', () => {
    let controller;
    let service;
    const mockSignal = {
        symbol: 'NIFTY',
        direction: shared_1.Direction.BULLISH,
        timeframe: shared_1.Timeframe.M15,
        state: shared_1.SignalState.PENDING,
        grade: shared_1.SignalGrade.A_PLUS,
        score: 90,
        entryZone: { min: 25000, max: 25050, optimal: 25025 },
        stopLoss: 24900,
        takeProfits: { tp1: 25212.5, tp2: 25337.5, tp3: 25525 },
        riskRewardRatios: { rr1: 1.5, rr2: 2.5, rr3: 4.0 },
        reasoning: {
            htfStructure: 'Bullish',
            liquidityReason: 'SSL swept',
            triggerReason: 'FVG tap',
            invalidationReason: 'SL below 24900',
            confirmedChecklist: ['HTF', 'FVG'],
            summary: 'Long setup on NIFTY',
        },
        scoreBreakdown: {
            htfBias: 20,
            liquiditySweep: 15,
            bos: 15,
            fvg: 7,
            orderBlock: 8,
            displacement: 10,
            premiumDiscount: 10,
            volumeConfirmation: 5,
            riskReward: 5,
            indicatorAlignment: 5,
            totalScore: 90,
            grade: shared_1.SignalGrade.A_PLUS,
        },
    };
    beforeEach(async () => {
        service = {
            generateSignalForSymbol: jest.fn().mockResolvedValue(mockSignal),
            getAllSignals: jest.fn().mockResolvedValue([mockSignal]),
            calculatePositionSize: jest.fn().mockReturnValue({
                accountBalance: 100000,
                riskPercentage: 1.0,
                riskAmount: 1000,
                entryPrice: 25000,
                stopLoss: 24900,
                riskPerUnit: 100,
                calculatedUnits: 10,
                lotSize: 1,
                roundedUnits: 10,
                totalPositionValue: 250000,
                maximumLoss: 1000,
                isValid: true,
            }),
        };
        const module = await testing_1.Test.createTestingModule({
            controllers: [signals_controller_1.SignalsController],
            providers: [{ provide: signals_service_1.SignalsService, useValue: service }],
        }).compile();
        controller = module.get(signals_controller_1.SignalsController);
    });
    it('should return signal for symbol', async () => {
        const res = await controller.getSignalForSymbol('NIFTY', shared_1.Timeframe.M15);
        expect(res.symbol).toBe('NIFTY');
        expect(res.score).toBe(90);
        expect(res.grade).toBe(shared_1.SignalGrade.A_PLUS);
    });
    it('should calculate position size', async () => {
        const res = await controller.calculatePositionSize({
            accountBalance: 100000,
            riskPercentage: 1.0,
            entryPrice: 25000,
            stopLoss: 24900,
        });
        expect(res.isValid).toBe(true);
        expect(res.roundedUnits).toBe(10);
    });
});
//# sourceMappingURL=signals.controller.spec.js.map