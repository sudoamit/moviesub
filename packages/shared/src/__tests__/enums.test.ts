import {
  AssetType,
  Timeframe,
  Direction,
  SignalState,
  SignalGrade,
  MarketRegimeType,
} from '../enums';

describe('Shared Enums', () => {
  it('should verify supported AssetTypes', () => {
    expect(AssetType.INDEX).toBe('INDEX');
    expect(AssetType.EQUITY).toBe('EQUITY');
    expect(AssetType.CRYPTO).toBe('CRYPTO');
  });

  it('should verify supported Timeframes', () => {
    expect(Timeframe.M1).toBe('1m');
    expect(Timeframe.M5).toBe('5m');
    expect(Timeframe.M15).toBe('15m');
    expect(Timeframe.H1).toBe('1h');
    expect(Timeframe.H4).toBe('4h');
    expect(Timeframe.D1).toBe('1d');
  });

  it('should verify Signal States and Grades', () => {
    expect(SignalState.PENDING).toBe('PENDING');
    expect(SignalState.ACTIVE).toBe('ACTIVE');
    expect(SignalState.TP1_HIT).toBe('TP1_HIT');
    expect(SignalState.SL_HIT).toBe('SL_HIT');
    expect(SignalGrade.A_PLUS).toBe('A+');
    expect(SignalGrade.A).toBe('A');
  });

  it('should verify Market Regimes', () => {
    expect(MarketRegimeType.BULLISH_TREND).toBe('BULLISH_TREND');
    expect(MarketRegimeType.BEARISH_TREND).toBe('BEARISH_TREND');
    expect(MarketRegimeType.RANGE).toBe('RANGE');
  });
});
