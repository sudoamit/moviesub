import { ExperienceStore } from '../experience-store';
import { LearningEngine } from '../learning-engine';
import { TradingExperience } from '../types';

describe('LearningEngine Pipeline', () => {
  beforeEach(() => {
    ExperienceStore.clear();
  });

  const createMockDataset = (count = 40): TradingExperience[] => {
    return Array.from({ length: count }, (_, i) => {
      const isWin = i % 3 !== 0;
      return {
        id: `exp-${i}`,
        tradeId: `tr-${i}`,
        timestamp: new Date(1700000000000 + i * 3600000),
        instrument: { symbol: 'NIFTY', assetType: 'INDEX' },
        marketState: {
          quant: { smcScore: 0.8, mtfAlignment: 0.9, obStrength: 0.85 },
          multiHorizon: { alignment: isWin ? 'ALIGNED' : 'CONFLICTED' },
          smc: { liquiditySweeps: isWin ? [{ id: '1' }] : [] },
        },
        decision: { action: 'BUY', score: 85 },
        execution: { entryPrice: 24000, entryTime: new Date() },
        risk: { stopLoss: 23950 },
        prediction: { probabilityWin: 0.75 },
        outcome: {
          status: isWin ? 'WIN' : 'LOSS',
          pnl: isWin ? 100 : -50,
          pnlR: isWin ? 2.0 : -1.0,
          maxFavorableExcursion: isWin ? 2.5 : 0.1,
          maxAdverseExcursion: isWin ? 0.2 : 1.0,
          holdingTimeSeconds: 1800,
        },
        marketContext: {
          regime: isWin ? 'BULLISH_TREND' : 'HIGH_VOLATILITY',
          volatilityRegime: 'P40',
          session: 'NSE_MORNING',
          dayOfWeek: 2,
        },
        outcomeClassification: isWin ? 'GOOD_TRADE_WIN' : 'GOOD_TRADE_LOSS',
        reasons: ['BOS'],
        failureReasons: isWin ? [] : ['HTF_CONFLICT'],
        strategyVersion: 'v2.0',
        featureSchemaVersion: '2.0',
        createdAt: new Date(),
      };
    });
  };

  it('should run a complete self-improvement learning cycle end-to-end', async () => {
    const dataset = createMockDataset(45);
    ExperienceStore.loadExperiences(dataset);

    const report = await LearningEngine.runLearningCycle({
      baseStrategyVersion: 'v2.0-smc-quant',
      autoPromote: false,
    });

    expect(report.experiencesUsed).toBe(45);
    expect(report.errorReport.totalTrades).toBe(45);
    expect(report.candidatesGenerated).toBeGreaterThanOrEqual(0);
    expect(report.driftReport).toBeDefined();
    expect(report.summary).toContain('Self-Improvement cycle completed');
  });
});
