import { ExperienceStore } from '../experience-store';
import { LearningEngine } from '../learning-engine';
import { TradingExperience } from '../types';
import { CANONICAL_FEATURE_NAMES_V2 } from '../model-trainer';

describe('LearningEngine Pipeline', () => {
  beforeEach(() => {
    ExperienceStore.clear();
  });

  const createMockDataset = (count = 40): TradingExperience[] => {
    return Array.from({ length: count }, (_, i) => {
      const isWin = i % 3 !== 0;
      const quant: Record<string, number> = {};
      for (const name of CANONICAL_FEATURE_NAMES_V2) {
        quant[name] = 0.5;
      }
      quant.smcScore = 0.8;
      quant.mtfAlignment = 0.9;
      quant.obStrength = 0.85;

      return {
        id: `exp-${i}`,
        tradeId: `tr-${i}`,
        timestamp: new Date(1700000000000 + i * 3600000),
        decisionTimestamp: 1700000000000 + i * 3600000,
        featureTimestamp: 1700000000000 + i * 3600000,
        labelStartTimestamp: 1700000000000 + i * 3600000 + 1000,
        labelEndTimestamp: 1700000000000 + i * 3600000 + 1801000,
        instrument: { symbol: 'NIFTY', assetType: 'INDEX' },
        marketState: {
          quant,
          multiHorizon: { alignment: isWin ? 'ALIGNED' : 'CONFLICTED' },
          smc: { liquiditySweeps: isWin ? [{ id: '1' }] : [] },
        },
        decision: { action: 'BUY', score: 85 },
        execution: {
          entryPrice: 24000,
          entryTime: new Date(1700000000000 + i * 3600000 + 1000),
          exitTime: new Date(1700000000000 + i * 3600000 + 1801000),
        },
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
        createdAt: new Date(1700000000000 + i * 3600000),
        candlesDuringTrade: [
          {
            timestamp: new Date(1700000000000 + i * 3600000 + 1000),
            open: 24000,
            high: isWin ? 24150 : 24010,
            low: isWin ? 23990 : 23940,
            close: isWin ? 24100 : 23945,
            volume: 100,
          },
          {
            timestamp: new Date(1700000000000 + i * 3600000 + 61000),
            open: isWin ? 24100 : 23945,
            high: isWin ? 24160 : 23950,
            low: isWin ? 24080 : 23930,
            close: isWin ? 24150 : 23935,
            volume: 120,
          },
        ],
      } as any;
    });
  };

  it('should run a complete self-improvement learning cycle end-to-end', async () => {
    const dataset = createMockDataset(45);
    ExperienceStore.loadExperiences(dataset);

    const baseTs = 1700000000000;
    const candles = Array.from({ length: 100 }, (_, i) => ({
      timestamp: new Date(baseTs + i * 1800000),
      open: 24000 + Math.sin(i * 0.2) * 200,
      high: 24000 + Math.sin(i * 0.2) * 200 + 50,
      low: 24000 + Math.sin(i * 0.2) * 200 - 50,
      close: 24000 + Math.sin(i * 0.2) * 200 + (i % 2 === 0 ? 20 : -20),
      volume: 1000 + (i % 5) * 200,
    }));

    const report = await LearningEngine.runLearningCycle({
      baseStrategyVersion: 'v2.0-smc-quant',
      autoPromote: false,
      candles,
    });

    expect(report.experiencesUsed).toBe(45);
    expect(report.errorReport.totalTrades).toBe(27); // 60% training partition of 45 experiences
    expect(report.candidatesGenerated).toBeGreaterThanOrEqual(0);
    expect(report.driftReport).toBeDefined();
    expect(report.summary).toContain('Self-Improvement cycle completed');
  });
});
