import { TradingExperience } from '../types';
import { ErrorAnalyzer } from '../error-analyzer';

describe('ErrorAnalyzer', () => {
  const createMockExperiences = (): TradingExperience[] => [
    {
      id: 'e1',
      tradeId: 't1',
      timestamp: new Date('2026-09-01T10:00:00Z'),
      instrument: { symbol: 'NIFTY', assetType: 'INDEX' },
      marketState: {},
      decision: { action: 'BUY', score: 85 },
      execution: { entryPrice: 24000, entryTime: new Date() },
      risk: { stopLoss: 23950 },
      prediction: { probabilityWin: 0.75 },
      outcome: {
        status: 'LOSS',
        pnl: -5000,
        pnlR: -1.0,
        maxFavorableExcursion: 0.2,
        maxAdverseExcursion: 1.0,
        holdingTimeSeconds: 600,
      },
      marketContext: {
        regime: 'BULLISH_TREND',
        volatilityRegime: 'P40',
        session: 'NSE_MORNING',
        dayOfWeek: 2,
      },
      outcomeClassification: 'GOOD_TRADE_LOSS',
      reasons: ['BOS'],
      failureReasons: ['HTF_CONFLICT'],
      strategyVersion: 'v2.0',
      featureSchemaVersion: '2.0',
      createdAt: new Date(),
    },
    {
      id: 'e2',
      tradeId: 't2',
      timestamp: new Date('2026-09-01T11:00:00Z'),
      instrument: { symbol: 'NIFTY', assetType: 'INDEX' },
      marketState: {},
      decision: { action: 'BUY', score: 80 },
      execution: { entryPrice: 24050, entryTime: new Date() },
      risk: { stopLoss: 24000 },
      prediction: { probabilityWin: 0.7 },
      outcome: {
        status: 'WIN',
        pnl: 10000,
        pnlR: 2.0,
        maxFavorableExcursion: 2.5,
        maxAdverseExcursion: 0.3,
        holdingTimeSeconds: 1200,
      },
      marketContext: {
        regime: 'BULLISH_TREND',
        volatilityRegime: 'P40',
        session: 'NSE_MORNING',
        dayOfWeek: 2,
      },
      outcomeClassification: 'GOOD_TRADE_WIN',
      reasons: ['BOS', 'OB'],
      failureReasons: [],
      strategyVersion: 'v2.0',
      featureSchemaVersion: '2.0',
      createdAt: new Date(),
    },
  ];

  it('should compute error statistics and identify primary failure modes', () => {
    const exps = createMockExperiences();
    const report = ErrorAnalyzer.analyze(exps);

    expect(report.totalTrades).toBe(2);
    expect(report.overallWinRate).toBe(50.0);
    expect(report.overallExpectancy).toBe(0.5);
    expect(report.failureStats.length).toBeGreaterThan(0);
    expect(report.failureStats[0].failureMode).toBe('HTF_CONFLICT');
  });
});
