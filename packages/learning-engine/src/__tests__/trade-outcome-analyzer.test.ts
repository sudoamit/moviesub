import { Direction, SignalGrade } from '@quant/shared';
import { TradeOutcomeAnalyzer } from '../trade-outcome-analyzer';

describe('TradeOutcomeAnalyzer', () => {
  it('should classify a high-quality setup with positive outcome as GOOD_TRADE_WIN', () => {
    const res = TradeOutcomeAnalyzer.analyze({
      tradeId: 't1',
      symbol: 'NIFTY',
      direction: Direction.BULLISH,
      entryPrice: 24000,
      entryTime: new Date('2026-09-01T09:30:00Z'),
      exitPrice: 24150,
      exitTime: new Date('2026-09-01T10:15:00Z'),
      stopLoss: 23950,
      pnl: 150,
      pnlR: 3.0,
      signalSetup: {
        symbol: 'NIFTY',
        direction: Direction.BULLISH,
        score: 88,
        grade: SignalGrade.A_PLUS,
        htfBias: Direction.BULLISH,
      } as any,
    });

    expect(res.outcomeClassification).toBe('GOOD_TRADE_WIN');
    expect(res.outcomeStatus).toBe('WIN');
    expect(res.maxFavorableExcursion).toBeGreaterThan(0);
    expect(res.failureReasons.length).toBe(0);
  });

  it('should classify a high-quality setup that hit stop as GOOD_TRADE_LOSS', () => {
    const res = TradeOutcomeAnalyzer.analyze({
      tradeId: 't2',
      symbol: 'NIFTY',
      direction: Direction.BULLISH,
      entryPrice: 24000,
      entryTime: new Date('2026-09-01T09:30:00Z'),
      exitPrice: 23950,
      exitTime: new Date('2026-09-01T09:45:00Z'),
      stopLoss: 23950,
      pnl: -50,
      pnlR: -1.0,
      signalSetup: {
        symbol: 'NIFTY',
        direction: Direction.BULLISH,
        score: 85,
        grade: SignalGrade.A,
        htfBias: Direction.BULLISH,
      } as any,
    });

    expect(res.outcomeClassification).toBe('GOOD_TRADE_LOSS');
    expect(res.outcomeStatus).toBe('LOSS');
  });

  it('should classify a poor setup that won due to luck as BAD_TRADE_WIN', () => {
    const res = TradeOutcomeAnalyzer.analyze({
      tradeId: 't3',
      symbol: 'NIFTY',
      direction: Direction.BULLISH,
      entryPrice: 24000,
      entryTime: new Date('2026-09-01T09:30:00Z'),
      exitPrice: 24100,
      exitTime: new Date('2026-09-01T10:00:00Z'),
      stopLoss: 23950,
      pnl: 100,
      pnlR: 2.0,
      signalSetup: {
        symbol: 'NIFTY',
        direction: Direction.BULLISH,
        score: 45,
        grade: SignalGrade.C,
        htfBias: Direction.BEARISH, // Conflict
      } as any,
    });

    expect(res.outcomeClassification).toBe('BAD_TRADE_WIN');
    expect(res.outcomeStatus).toBe('WIN');
    expect(res.failureReasons).toContain('HTF_CONFLICT');
  });
});
