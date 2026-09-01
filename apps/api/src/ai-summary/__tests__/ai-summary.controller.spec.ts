import { Test, TestingModule } from '@nestjs/testing';
import { AISummaryController } from '../ai-summary.controller';
import { AISummaryService } from '../ai-summary.service';
import { Timeframe } from '@quant/shared';

describe('AISummaryController', () => {
  let controller: AISummaryController;
  let service: any;

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

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AISummaryController],
      providers: [{ provide: AISummaryService, useValue: service }],
    }).compile();

    controller = module.get<AISummaryController>(AISummaryController);
  });

  it('should generate symbol summary', async () => {
    const res = await controller.getMarketSummary('NIFTY', Timeframe.M15);
    expect(res.symbol).toBe('NIFTY');
    expect(res.score).toBe(85);
  });

  it('should generate daily briefing', async () => {
    const res = await controller.getDailyBriefing(Timeframe.M15);
    expect(res.title).toContain('Daily Institutional');
  });
});
