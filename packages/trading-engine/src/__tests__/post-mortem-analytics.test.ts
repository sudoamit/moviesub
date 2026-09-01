import {
  PostMortemAnalyticsEngine,
  ITradePostMortemInput,
} from '../ai-trade-learning-engine';
import { ICandle } from '@quant/shared';

describe('PHASE 10: Deterministic Post-Mortem Failure & Success Analytics', () => {
  const baseTimestamp = new Date('2026-08-29T10:00:00Z');

  const createCandle = (
    offsetMinutes: number,
    open: number,
    high: number,
    low: number,
    close: number
  ): ICandle => ({
    timestamp: new Date(baseTimestamp.getTime() + offsetMinutes * 60000),
    open,
    high,
    low,
    close,
    volume: 1000,
    isClosed: true,
  });

  describe('1. MFE / MAE & Target Excursion Metrics in R-Multiples', () => {
    it('accurately computes MFE and MAE for Bullish trades reaching target', () => {
      // Entry: 100, SL: 90 (Risk = 10), TP1: 120 (2R), TP2: 130 (3R)
      // Subsequent candles:
      // C1: 100 -> 95 (MAE = 5 = 0.5R) -> 115 (MFE = 15 = 1.5R)
      // C2: 115 -> 125 (TP1 reached, MFE = 25 = 2.5R) -> 122
      const candles = [
        createCandle(15, 100, 115, 95, 110),
        createCandle(30, 110, 125, 108, 122),
      ];

      const report = PostMortemAnalyticsEngine.analyzeTrade({
        symbol: 'NIFTY',
        direction: 'BULLISH',
        entryPrice: 100,
        stopLoss: 90,
        targets: { tp1: 120, tp2: 130 },
        entryTimestamp: baseTimestamp,
        subsequentCandles: candles,
      });

      expect(report.outcome).toBe('TP1_HIT');
      expect(report.realizedRMultiple).toBe(2.0);
      expect(report.mfeR).toBe(2.5); // (125 - 100) / 10
      expect(report.maeR).toBe(0.5); // (100 - 95) / 10
      expect(report.classification).toBe('TARGET_ACHIEVED');
    });

    it('accurately computes MFE and MAE for Bearish trades', () => {
      // Short entry: 200, SL: 210 (Risk = 10), TP1: 180 (2R)
      // C1: 200 -> 204 (MAE = 4 = 0.4R) -> 185 (MFE = 15 = 1.5R)
      // C2: 185 -> 175 (TP1 reached, MFE = 25 = 2.5R)
      const candles = [
        createCandle(15, 200, 204, 185, 190),
        createCandle(30, 190, 192, 175, 178),
      ];

      const report = PostMortemAnalyticsEngine.analyzeTrade({
        symbol: 'BTCUSDT',
        direction: 'BEARISH',
        entryPrice: 200,
        stopLoss: 210,
        targets: { tp1: 180, tp2: 160 },
        entryTimestamp: baseTimestamp,
        subsequentCandles: candles,
      });

      expect(report.outcome).toBe('TP1_HIT');
      expect(report.realizedRMultiple).toBe(2.0);
      expect(report.mfeR).toBe(2.5); // (200 - 175) / 10
      expect(report.maeR).toBe(0.4); // (204 - 200) / 10
    });
  });

  describe('2. Deterministic Post-Mortem Root-Cause Classification Rules', () => {
    it('classifies LIQUIDITY_SWEEP_FAILURE when price sweeps SL and immediately reverses to TP', () => {
      // Entry: 100, SL: 95 (Risk = 5), TP1: 110 (3R)
      // C1: Sweeps SL to 94 (Stop hit!)
      // C2: Reverses aggressively and reaches 112 (TP1 target reached post-stop out)
      const candles = [
        createCandle(15, 100, 101, 94, 98),
        createCandle(30, 98, 112, 97, 110),
      ];

      const report = PostMortemAnalyticsEngine.analyzeTrade({
        symbol: 'NIFTY',
        direction: 'BULLISH',
        entryPrice: 100,
        stopLoss: 95,
        targets: { tp1: 110, tp2: 120 },
        entryTimestamp: baseTimestamp,
        subsequentCandles: candles,
      });

      expect(report.outcome).toBe('SL_HIT');
      expect(report.classification).toBe('LIQUIDITY_SWEEP_FAILURE');
      expect(report.classificationRationale).toContain('swept for resting retail liquidity');
    });

    it('classifies HTF_COUNTERTREND when trade fails against higher timeframe order flow', () => {
      const candles = [
        createCandle(15, 100, 101, 90, 92), // SL Hit (95)
      ];

      const report = PostMortemAnalyticsEngine.analyzeTrade({
        symbol: 'BANKNIFTY',
        direction: 'BULLISH',
        entryPrice: 100,
        stopLoss: 95,
        targets: { tp1: 110, tp2: 120 },
        entryTimestamp: baseTimestamp,
        subsequentCandles: candles,
        htfTrendAligned: false, // Against 1H HTF Trend
      });

      expect(report.outcome).toBe('SL_HIT');
      expect(report.classification).toBe('HTF_COUNTERTREND');
    });

    it('classifies NEWS_SPIKE when high-impact macro event coincides with stop out', () => {
      const candles = [
        createCandle(15, 100, 101, 88, 90),
      ];

      const report = PostMortemAnalyticsEngine.analyzeTrade({
        symbol: 'BTCUSDT',
        direction: 'BULLISH',
        entryPrice: 100,
        stopLoss: 95,
        targets: { tp1: 110, tp2: 120 },
        entryTimestamp: baseTimestamp,
        subsequentCandles: candles,
        hasNewsEventDuringTrade: true,
      });

      expect(report.outcome).toBe('SL_HIT');
      expect(report.classification).toBe('NEWS_SPIKE');
    });

    it('classifies VOLATILITY_EXPANSION_STOP when candle range sharply exceeds entry ATR', () => {
      // Entry ATR = 2.0. Stop candle range = 100 - 90 = 10.0 (> 2.5 * 2.0 = 5.0)
      const candles = [
        createCandle(15, 100, 100, 90, 92),
      ];

      const report = PostMortemAnalyticsEngine.analyzeTrade({
        symbol: 'RELIANCE',
        direction: 'BULLISH',
        entryPrice: 100,
        stopLoss: 95,
        targets: { tp1: 110, tp2: 120 },
        entryTimestamp: baseTimestamp,
        subsequentCandles: candles,
        atrAtEntry: 2.0,
      });

      expect(report.outcome).toBe('SL_HIT');
      expect(report.classification).toBe('VOLATILITY_EXPANSION_STOP');
    });

    it('classifies EARLY_ENTRY_BEFORE_CONFIRMATION when entered without structural confirmation', () => {
      const candles = [
        createCandle(15, 100, 101, 93, 94),
      ];

      const report = PostMortemAnalyticsEngine.analyzeTrade({
        symbol: 'HDFCBANK',
        direction: 'BULLISH',
        entryPrice: 100,
        stopLoss: 95,
        targets: { tp1: 110, tp2: 120 },
        entryTimestamp: baseTimestamp,
        subsequentCandles: candles,
        entrySignalConfirmed: false,
      });

      expect(report.outcome).toBe('SL_HIT');
      expect(report.classification).toBe('EARLY_ENTRY_BEFORE_CONFIRMATION');
    });
  });
});
