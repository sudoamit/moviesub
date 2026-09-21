import { BadRequestException } from '@nestjs/common';
import { ICandle } from '@quant/shared';
import { VolatilityService } from '../volatility.service';

describe('Phase 24 — Realized Volatility & Dynamic Sizing Engine', () => {
  let service: VolatilityService;

  beforeEach(() => {
    service = new VolatilityService();
  });

  const createMockCandle = (
    open: number,
    high: number,
    low: number,
    close: number,
    dayOffset = 0,
  ): ICandle => ({
    timestamp: new Date(Date.UTC(2026, 0, 1 + dayOffset, 9, 15)),
    open,
    high,
    low,
    close,
    volume: 1000,
    isClosed: true,
  });

  describe('1. Close-to-Close Realized Volatility', () => {
    it('should correctly calculate sample standard deviation of log returns', () => {
      // 5 daily candles with 1% daily increments: 100 -> 101 -> 102.01 -> 103.0301 -> 104.060401
      // r_i = ln(1.01) ~= 0.00995033
      // Since all returns are identical, sample variance should be ~0 and daily volatility ~0
      const candles: ICandle[] = [
        createMockCandle(100, 100.5, 99.5, 100, 0),
        createMockCandle(100, 101.5, 100, 101, 1),
        createMockCandle(101, 102.5, 101, 102.01, 2),
        createMockCandle(102.01, 103.5, 102, 103.0301, 3),
      ];

      const result = service.calculateCloseToCloseVol(candles, 252);

      expect(result.estimator).toBe('CLOSE_TO_CLOSE');
      expect(result.period).toBe(4);
      expect(result.dailyVolatility).toBeCloseTo(0, 5);
      expect(result.annualizedVolatility).toBeCloseTo(0, 4);
    });

    it('should calculate non-zero volatility for oscillating prices and scale by sqrt(252)', () => {
      const candles: ICandle[] = [
        createMockCandle(100, 102, 98, 100, 0),
        createMockCandle(100, 105, 99, 104, 1), // +4%
        createMockCandle(104, 104, 97, 98, 2),  // -5.7%
        createMockCandle(98, 103, 97, 102, 3),  // +4.08%
        createMockCandle(102, 102, 95, 97, 4),  // -4.9%
      ];

      const result = service.calculateCloseToCloseVol(candles, 252);

      expect(result.dailyVolatility).toBeGreaterThan(0.03);
      expect(result.annualizedVolatility).toBeCloseTo(result.dailyVolatility * Math.sqrt(252), 6);
    });
  });

  describe('2. Parkinson (1980) High-Low Realized Volatility', () => {
    it('should compute volatility purely from intraday high-low range even if close equals open', () => {
      // Intraday range is 10% on every day: High = 105, Low = 95
      // Close == Open = 100 every day (Close-to-Close would yield 0)
      const candles: ICandle[] = [
        createMockCandle(100, 105, 95, 100, 0),
        createMockCandle(100, 105, 95, 100, 1),
        createMockCandle(100, 105, 95, 100, 2),
        createMockCandle(100, 105, 95, 100, 3),
      ];

      const parkinsonResult = service.calculateParkinsonVol(candles, 252);
      const c2cResult = service.calculateCloseToCloseVol(candles, 252);

      expect(c2cResult.dailyVolatility).toBe(0);
      expect(parkinsonResult.dailyVolatility).toBeGreaterThan(0.04);
      expect(parkinsonResult.estimator).toBe('PARKINSON');
    });
  });

  describe('3. Garman-Klass (1980) OHLC Realized Volatility', () => {
    it('should incorporate both high-low and open-close price boundaries', () => {
      const candles: ICandle[] = [
        createMockCandle(100, 104, 98, 103, 0),
        createMockCandle(103, 106, 101, 102, 1),
        createMockCandle(102, 105, 99, 104, 2),
        createMockCandle(104, 108, 103, 107, 3),
      ];

      const gkResult = service.calculateGarmanKlassVol(candles, 252);

      expect(gkResult.estimator).toBe('GARMAN_KLASS');
      expect(gkResult.dailyVolatility).toBeGreaterThan(0);
      expect(gkResult.annualizedVolatility).toBeCloseTo(gkResult.dailyVolatility * Math.sqrt(252), 6);
    });
  });

  describe('4. Yang-Zhang (2000) Realized Volatility', () => {
    it('should account for overnight gap jumps between consecutive sessions', () => {
      // Day 0: Close 100. Day 1: Gaps up to Open 105 (+5% gap)
      // Day 1: Close 106. Day 2: Gaps down to Open 101 (-4.7% gap)
      const candles: ICandle[] = [
        createMockCandle(100, 102, 99, 100, 0),
        createMockCandle(105, 107, 104, 106, 1), // gap up
        createMockCandle(101, 103, 100, 102, 2), // gap down
        createMockCandle(102, 104, 101, 103, 3),
      ];

      const yzResult = service.calculateYangZhangVol(candles, 252);

      expect(yzResult.estimator).toBe('YANG_ZHANG');
      expect(yzResult.dailyVolatility).toBeGreaterThan(0);
      expect(yzResult.details?.varOpen).toBeGreaterThan(0); // Overnight jump variance detected
      expect(yzResult.annualizedVolatility).toBeGreaterThan(0);
    });
  });

  describe('5. Average True Range (ATR) & Volatility Regimes', () => {
    it('should account for gaps in true range and calculate smoothed ATR', () => {
      // Day 0: C=100. Day 1: H=110, L=105 -> Gap up. TR = max(110-105, |110-100|, |105-100|) = 10
      const candles: ICandle[] = [
        createMockCandle(100, 102, 98, 100, 0),
        createMockCandle(106, 110, 105, 108, 1),
        createMockCandle(108, 112, 106, 110, 2),
      ];

      const atrResult = service.calculateATR(candles, 14);

      expect(atrResult.trueRanges[1]).toBe(10); // Gap included in TR
      expect(atrResult.atr).toBeGreaterThan(0);
      expect(atrResult.normalizedATR).toBeGreaterThan(0);
    });

    it('should accurately classify volatility regimes and scale stop loss multipliers', () => {
      // Baseline ATR = 10
      // 1. Low volatility (ratio = 6/10 = 0.6 < 0.8)
      expect(service.classifyRegime(6, 10)).toBe('LOW_VOLATILITY');

      // 2. Normal volatility (ratio = 10/10 = 1.0)
      expect(service.classifyRegime(10, 10)).toBe('NORMAL_VOLATILITY');

      // 3. High volatility (ratio = 15/10 = 1.5)
      expect(service.classifyRegime(15, 10)).toBe('HIGH_VOLATILITY');

      // 4. Extreme volatility (ratio = 25/10 = 2.5 > 2.0)
      expect(service.classifyRegime(25, 10)).toBe('EXTREME_VOLATILITY');
    });

    it('should compute regime-adaptive stop loss prices widening in extreme vol and tightening in low vol', () => {
      const lowVolATR = {
        atr: 20,
        normalizedATR: 1.0,
        period: 14,
        trueRanges: [20],
        regime: 'LOW_VOLATILITY' as const,
        adaptiveStopLossMultiplier: 1.5,
      };

      const highVolATR = {
        atr: 20,
        normalizedATR: 1.0,
        period: 14,
        trueRanges: [20],
        regime: 'HIGH_VOLATILITY' as const,
        adaptiveStopLossMultiplier: 2.5,
      };

      const entry = 1000;
      const buyStopLow = service.getAdaptiveStopLoss(entry, 'BUY', lowVolATR, 2.0);
      const buyStopHigh = service.getAdaptiveStopLoss(entry, 'BUY', highVolATR, 2.0);

      // Low vol stop should be tighter: 1000 - (20 * 1.5) = 970
      expect(buyStopLow).toBe(970);
      // High vol stop should be wider to prevent whipsaws: 1000 - (20 * 2.5) = 950
      expect(buyStopHigh).toBe(950);
      expect(buyStopLow).toBeGreaterThan(buyStopHigh);

      // Short / SELL positions
      const sellStopLow = service.getAdaptiveStopLoss(entry, 'SELL', lowVolATR, 2.0);
      const sellStopHigh = service.getAdaptiveStopLoss(entry, 'SELL', highVolATR, 2.0);
      expect(sellStopLow).toBe(1030);
      expect(sellStopHigh).toBe(1050);
      expect(sellStopHigh).toBeGreaterThan(sellStopLow);
    });
  });

  describe('6. Volatility-Targeted Position Sizing Engine', () => {
    it('should size inversely proportional to realized volatility', () => {
      // Account: 1,000,000 INR
      // Target Vol: 10% = 100,000 INR risk budget
      // Entry: 1000 INR, contractSize: 1, fxRate: 1
      // Case A: Realized Vol = 20% -> Size = 100,000 / (1000 * 0.20) = 500 units
      const sizeNormal = service.calculateVolatilityTargetSize({
        accountBalance: 1000000,
        targetVolatilityPercent: 10,
        realizedVolatilityAnnualized: 0.20,
        entryPrice: 1000,
        contractSize: 1,
        fxRate: 1.0,
        stepSize: 10,
        minQuantity: 10,
      });

      expect(sizeNormal.isValid).toBe(true);
      expect(sizeNormal.normalizedQuantity).toBe(500);

      // Case B: Realized Vol spikes to 40% (2x vol) -> Size should halve to 250 units
      const sizeHighVol = service.calculateVolatilityTargetSize({
        accountBalance: 1000000,
        targetVolatilityPercent: 10,
        realizedVolatilityAnnualized: 0.40,
        entryPrice: 1000,
        contractSize: 1,
        fxRate: 1.0,
        stepSize: 10,
        minQuantity: 10,
      });

      expect(sizeHighVol.isValid).toBe(true);
      expect(sizeHighVol.normalizedQuantity).toBe(250);
    });

    it('should enforce min and max scale factor clamps to prevent extreme leverage/deleverage', () => {
      // Target Vol: 10%, Realized Vol: 2% -> Raw scale factor = 0.10 / 0.02 = 5.0x
      // But maxScaleFactor is 2.5x -> must clamp to 2.5x
      const sizeClampedHigh = service.calculateVolatilityTargetSize({
        accountBalance: 1000000,
        targetVolatilityPercent: 10,
        realizedVolatilityAnnualized: 0.02,
        entryPrice: 1000,
        contractSize: 1,
        maxScaleFactor: 2.5,
      });

      expect(sizeClampedHigh.isClamped).toBe(true);
      expect(sizeClampedHigh.clampedScaleFactor).toBe(2.5);
      expect(sizeClampedHigh.rawVolatilityScaleFactor).toBe(5.0);

      // Target Vol: 10%, Realized Vol: 80% -> Raw scale factor = 0.10 / 0.80 = 0.125
      // But minScaleFactor is 0.25 (floor) -> must clamp to 0.25
      const sizeClampedLow = service.calculateVolatilityTargetSize({
        accountBalance: 1000000,
        targetVolatilityPercent: 10,
        realizedVolatilityAnnualized: 0.80,
        entryPrice: 1000,
        contractSize: 1,
        minScaleFactor: 0.25,
      });

      expect(sizeClampedLow.isClamped).toBe(true);
      expect(sizeClampedLow.clampedScaleFactor).toBe(0.25);
    });

    it('should reject when sized quantity is below minimum quantity and NEVER upward clamp', () => {
      const result = service.calculateVolatilityTargetSize({
        accountBalance: 1000,
        targetVolatilityPercent: 1,
        realizedVolatilityAnnualized: 0.50,
        entryPrice: 20000,
        contractSize: 1,
        minQuantity: 1,
      });

      expect(result.isValid).toBe(false);
      expect(result.code).toBe('QUANTITY_BELOW_MINIMUM');
      expect(result.normalizedQuantity).toBe(0); // Zero upward rounding!
    });
  });

  describe('7. Fail-Closed Edge Cases & Robustness', () => {
    it('should fail closed when fewer than 2 candles are provided', () => {
      expect(() => service.calculateCloseToCloseVol([])).toThrow(BadRequestException);
      expect(() =>
        service.calculateCloseToCloseVol([createMockCandle(100, 102, 98, 100)]),
      ).toThrow(BadRequestException);
    });

    it('should fail closed when candle contains high < low or negative prices', () => {
      const invalidHighLow: ICandle[] = [
        createMockCandle(100, 95, 105, 100, 0), // high 95 < low 105
        createMockCandle(100, 105, 95, 100, 1),
      ];
      expect(() => service.calculateParkinsonVol(invalidHighLow)).toThrow(BadRequestException);

      const negativePrice: ICandle[] = [
        createMockCandle(100, 105, 95, 100, 0),
        createMockCandle(-10, 105, 95, 100, 1),
      ];
      expect(() => service.calculateGarmanKlassVol(negativePrice)).toThrow(BadRequestException);
    });

    it('should reject position sizing if parameters are non-positive', () => {
      const res = service.calculateVolatilityTargetSize({
        accountBalance: -100,
        targetVolatilityPercent: 10,
        realizedVolatilityAnnualized: 0.2,
        entryPrice: 1000,
      });
      expect(res.isValid).toBe(false);
      expect(res.code).toBe('INVALID_PARAMETERS');
    });
  });
});
