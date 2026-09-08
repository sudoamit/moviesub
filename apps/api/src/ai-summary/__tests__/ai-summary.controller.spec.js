"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const testing_1 = require("@nestjs/testing");
const ai_summary_controller_1 = require("../ai-summary.controller");
const ai_summary_service_1 = require("../ai-summary.service");
const shared_1 = require("@quant/shared");
describe('AISummaryController', () => {
    let controller;
    let service;
    const mockSummary = {
        symbol: 'NIFTY',
        bias: 'BEARISH',
        score: 85,
        grade: 'A+',
        executiveSummary: 'NIFTY is demonstrating strong institutional distribution.',
        marketStructureNarrative: 'Market Regime: BEARISH_TREND. Higher timeframe alignment is strong.',
        institutionalFootprint: 'Mitigation tap into active BEARISH Fair Value Gap.',
        riskParameters: {
            optimalEntry: 26017.99,
            invalidationStopLoss: 26310.54,
        },
    };
    beforeEach(async () => {
        service = {
            generateSymbolSummary: jest.fn().mockResolvedValue(mockSummary),
            generateDailyBriefing: jest.fn().mockResolvedValue({
                title: 'Daily Institutional Market Intelligence Briefing',
                assetSummaries: [mockSummary],
            }),
        };
        const module = await testing_1.Test.createTestingModule({
            controllers: [ai_summary_controller_1.AISummaryController],
            providers: [{ provide: ai_summary_service_1.AISummaryService, useValue: service }],
        }).compile();
        controller = module.get(ai_summary_controller_1.AISummaryController);
    });
    it('should generate symbol summary', async () => {
        const res = await controller.getMarketSummary('NIFTY', shared_1.Timeframe.M15);
        expect(res.symbol).toBe('NIFTY');
        expect(res.score).toBe(85);
    });
    it('should generate daily briefing', async () => {
        const res = await controller.getDailyBriefing(shared_1.Timeframe.M15);
        expect(res.title).toContain('Daily Institutional');
    });
});
//# sourceMappingURL=ai-summary.controller.spec.js.map