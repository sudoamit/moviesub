import {
  calculateRiskDistance,
  calculateTargetR,
  validateTargetGeometry,
  calculateCanonicalTargets,
  DEFAULT_STRATEGY_RR_RATIOS,
  Direction,
  getAuthoritativeInstrument,
  PointInTimeCurrencyConverter,
  ISignalSetup,
  SignalState,
  SignalGrade,
} from '@quant/shared';
import { PositionSizer, TradeAccountingEngine } from '@quant/risk-engine';
import { BadRequestException } from '@nestjs/common';
import { PaperTradingService } from '../paper-trading.service';
import { RiskService } from '../../trading-domain/risk.service';

describe('BTCUSDT_SPOT SMC Setup Calculation & Execution Invariants Audit', () => {
  const pitConverter = PointInTimeCurrencyConverter.getInstance();
  const fxUsdtInr = pitConverter.getRate('USDT', 'INR', Date.now()).fxRate; // e.g. 92.5

  const screenshotSetup = {
    direction: 'BEARISH' as const,
    instrument: 'BTCUSDT_SPOT',
    cmp: 84193.02,
    optimalEntry: 84726.77,
    sl: 84846.77,
    quantity: 0.01,
    tp1: 84486.77,
    tp2: 84306.77,
    tp3: 84006.77,
  };

  // =========================================================================
  // 1. Math Verification
  // =========================================================================
  describe('1. Mathematical Verification of Screenshot Values', () => {
    it('produces exact riskDistance = 120 points for Entry 84726.77 and SL 84846.77', () => {
      const riskDistance = calculateRiskDistance(
        screenshotSetup.optimalEntry,
        screenshotSetup.sl,
        screenshotSetup.direction,
      );
      expect(riskDistance).toBe(120);
      expect(Math.abs(screenshotSetup.sl - screenshotSetup.optimalEntry)).toBe(120);
    });

    it('calculates exact R multiples for screenshot targets: TP1 -> 2.0R, TP2 -> 3.5R, TP3 -> 6.0R', () => {
      const riskDistance = calculateRiskDistance(
        screenshotSetup.optimalEntry,
        screenshotSetup.sl,
        screenshotSetup.direction,
      );

      const r1 = calculateTargetR(
        screenshotSetup.optimalEntry,
        screenshotSetup.tp1,
        riskDistance,
        screenshotSetup.direction,
      );
      const r2 = calculateTargetR(
        screenshotSetup.optimalEntry,
        screenshotSetup.tp2,
        riskDistance,
        screenshotSetup.direction,
      );
      const r3 = calculateTargetR(
        screenshotSetup.optimalEntry,
        screenshotSetup.tp3,
        riskDistance,
        screenshotSetup.direction,
      );

      expect(r1).toBe(2.0); // (84726.77 - 84486.77) / 120 = 240 / 120 = 2.0
      expect(r2).toBe(3.5); // (84726.77 - 84306.77) / 120 = 420 / 120 = 3.5
      expect(r3).toBe(6.0); // (84726.77 - 84006.77) / 120 = 720 / 120 = 6.0
    });

    it('validates SHORT target geometry: SL > Entry > TP1 > TP2 > TP3', () => {
      const geomValidation = validateTargetGeometry(
        screenshotSetup.optimalEntry,
        screenshotSetup.sl,
        screenshotSetup.tp1,
        screenshotSetup.tp2,
        screenshotSetup.tp3,
        screenshotSetup.direction,
      );

      expect(geomValidation.isValid).toBe(true);
      expect(screenshotSetup.sl).toBeGreaterThan(screenshotSetup.optimalEntry);
      expect(screenshotSetup.optimalEntry).toBeGreaterThan(screenshotSetup.tp1);
      expect(screenshotSetup.tp1).toBeGreaterThan(screenshotSetup.tp2);
      expect(screenshotSetup.tp2).toBeGreaterThan(screenshotSetup.tp3);
    });

    it('validates trade risk and margin calculations match screenshot', () => {
      // Risk: 120 points * 0.01 BTC * fxRate (~92.5) ≈ ₹111
      const notionalRiskUsdt = 120 * screenshotSetup.quantity; // 1.2 USDT
      const riskInr = Number((notionalRiskUsdt * fxUsdtInr).toFixed(0));
      expect(riskInr).toBe(111); // 1.2 * 92.5 = 111

      // Margin: 84726.77 * 0.01 BTC * fxRate (~92.5) ≈ ₹78372
      const notionalUsdt = screenshotSetup.optimalEntry * screenshotSetup.quantity; // 847.2677 USDT
      const marginInr = Number((notionalUsdt * fxUsdtInr).toFixed(0));
      expect(marginInr).toBe(78372); // 847.2677 * 92.5 = 78372.26
    });

    it('validates LONG target geometry: SL < Entry < TP1 < TP2 < TP3', () => {
      const longEntry = 84726.77;
      const longSL = 84606.77; // 120 risk distance
      const longCanonical = calculateCanonicalTargets(longEntry, longSL, 'BULLISH', {
        rr1: 2.0,
        rr2: 3.5,
        rr3: 6.0,
      });

      expect(longCanonical.riskDistance).toBe(120);
      expect(longCanonical.tp1).toBe(84966.77); // 84726.77 + 240
      expect(longCanonical.tp2).toBe(85146.77); // 84726.77 + 420
      expect(longCanonical.tp3).toBe(85446.77); // 84726.77 + 720
      expect(longCanonical.isValid).toBe(true);

      const geomValidation = validateTargetGeometry(
        longEntry,
        longSL,
        longCanonical.tp1,
        longCanonical.tp2,
        longCanonical.tp3,
        'BULLISH',
      );
      expect(geomValidation.isValid).toBe(true);
      expect(longSL).toBeLessThan(longEntry);
      expect(longEntry).toBeLessThan(longCanonical.tp1);
      expect(longCanonical.tp1).toBeLessThan(longCanonical.tp2);
      expect(longCanonical.tp2).toBeLessThan(longCanonical.tp3);
    });
  });

  // =========================================================================
  // 2. Canonical Target-RR Model Consistency
  // =========================================================================
  describe('2. Canonical Target-RR Model Authority', () => {
    it('authoritative strategy target configuration generates exact targets matching screenshot', () => {
      const canonical = calculateCanonicalTargets(
        screenshotSetup.optimalEntry,
        screenshotSetup.sl,
        'BEARISH',
      );

      expect(canonical.entry).toBe(84726.77);
      expect(canonical.stopLoss).toBe(84846.77);
      expect(canonical.riskDistance).toBe(120);
      expect(canonical.tp1).toBe(84486.77);
      expect(canonical.tp2).toBe(84306.77);
      expect(canonical.tp3).toBe(84006.77);
      expect(canonical.rr1).toBe(2.0);
      expect(canonical.rr2).toBe(3.5);
      expect(canonical.rr3).toBe(6.0);
      expect(canonical.maxPotentialR).toBe(6.0);
      expect(canonical.isValid).toBe(true);
    });

    it('rejects inverted or corrupt target geometries', () => {
      // SL lower than entry for SHORT
      const invalidShort = validateTargetGeometry(100, 90, 80, 70, 60, 'BEARISH');
      expect(invalidShort.isValid).toBe(false);
      expect(invalidShort.error).toContain('INVALID_GEOMETRY');

      // Targets inverted for LONG
      const invalidLong = validateTargetGeometry(100, 90, 110, 105, 120, 'BULLISH');
      expect(invalidLong.isValid).toBe(false);
      expect(invalidLong.error).toContain('INVALID_GEOMETRY');
    });
  });

  // =========================================================================
  // 3. BTCUSDT_SPOT Execution Invariants
  // =========================================================================
  describe('3. BTCUSDT_SPOT Invariants Enforcement', () => {
    const mockPrisma: any = {
      paperAccount: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'acc-spot-1',
          currency: 'INR',
          cashBalance: 1000000,
        }),
      },
      paperOrder: {
        findUnique: jest.fn().mockResolvedValue(null),
        count: jest.fn().mockResolvedValue(0),
      },
      paperPosition: {
        count: jest.fn().mockResolvedValue(0),
      },
      paperTrade: {
        aggregate: jest.fn().mockResolvedValue({ _sum: { realizedPnL: 0 } }),
        findMany: jest.fn().mockResolvedValue([]),
      },
      systemConfig: {
        findFirst: jest.fn().mockResolvedValue({
          configJson: { maxLeverage: 50, maxSlippageBps: 50 },
        }),
      },
    };

    const service = new PaperTradingService(
      mockPrisma,
      {} as any,
      { getValidatedTicker: () => ({ price: 84193.02 }) } as any,
      undefined,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );

    beforeEach(() => {
      jest.spyOn(service as any, 'getOrCreateAccount').mockResolvedValue({
        id: 'acc-spot-1',
        currency: 'INR',
        cashBalance: 1000000,
      });
      jest.spyOn(service as any, 'getSystemConfig').mockResolvedValue({
        maxLeverage: 50,
        maxSlippageBps: 50,
        maxTotalExposurePercent: 100,
      });
      jest.spyOn(service as any, 'rejectOrder').mockResolvedValue(undefined as any);
      jest.spyOn(service as any, 'getValidatedMarketPrice').mockResolvedValue({
        price: 84193.02,
        timestamp: new Date(),
      });
    });

    it('BTCUSDT_SPOT + SELL/SHORT -> REJECTED with SPOT_SHORT_SELLING_FORBIDDEN', async () => {
      // 1. PaperTradingService reject
      await expect(
        service.placeOrder({
          symbol: 'BTCUSDT_SPOT',
          direction: 'SELL',
          orderType: 'MARKET',
          quantity: 0.01,
          price: 84193.02,
          stopLoss: 84846.77,
          target1: 84486.77,
        }),
      ).rejects.toThrow('SPOT_SHORT_SELLING_FORBIDDEN');

      // 2. PositionSizer reject
      const btcInst = getAuthoritativeInstrument('BTCUSDT_SPOT');
      const sizing = PositionSizer.calculatePosition({
        accountBalance: 1000000,
        availableMargin: 1000000,
        riskPercentage: 1.0,
        entryPrice: 84726.77,
        stopLoss: 84846.77,
        symbol: 'BTCUSDT_SPOT',
        instrument: btcInst,
        direction: 'SELL',
      });
      expect(sizing.isValid).toBe(false);
      expect(sizing.rejectionReason).toContain('SPOT_SHORT_SELLING_FORBIDDEN');
    });

    it('BTCUSDT_SPOT + 50x -> REJECTED with LEVERAGE_EXCEEDS_MAX (Never silently converted to 1x)', async () => {
      // 1. PaperTradingService reject
      let caughtErr: any;
      try {
        await service.placeOrder({
          symbol: 'BTCUSDT_SPOT',
          direction: 'BUY',
          orderType: 'MARKET',
          quantity: 0.01,
          price: 84193.02,
          stopLoss: 84000.0,
          target1: 84500.0,
          leverage: 50,
        });
      } catch (err: any) {
        caughtErr = err;
      }
      expect(caughtErr).toBeDefined();
      expect(caughtErr.message).toContain('LEVERAGE_EXCEEDS_MAX');
      expect(caughtErr.message).toContain('50x');
      expect(caughtErr.message).toContain('1x');

      // 2. PositionSizer reject
      const btcInst = getAuthoritativeInstrument('BTCUSDT_SPOT');
      const sizing = PositionSizer.calculatePosition({
        accountBalance: 1000000,
        availableMargin: 1000000,
        riskPercentage: 1.0,
        entryPrice: 84726.77,
        stopLoss: 84000.0,
        symbol: 'BTCUSDT_SPOT',
        instrument: btcInst,
        direction: 'BUY',
        requestedLeverage: 50,
      });
      expect(sizing.isValid).toBe(false);
      expect(sizing.rejectionReason).toContain('LEVERAGE_EXCEEDS_MAX');

      // 3. RiskService reject
      const riskService = new RiskService({} as any);
      expect(() =>
        riskService.calculateTradeRisk({
          entryPrice: 84726.77,
          stopLoss: 84000.0,
          quantity: 0.01,
          fxRate: fxUsdtInr,
          leverage: 50,
          marginMode: 'SPOT',
          accountEquity: 1000000,
        }),
      ).toThrow('LEVERAGE_EXCEEDS_MAX');
    });

    it('BTCUSDT_SPOT + BUY + valid SL + <=1x -> ALLOWED subject to risk and cash constraints', async () => {
      const btcInst = getAuthoritativeInstrument('BTCUSDT_SPOT');
      expect(btcInst.marginMode).toBe('SPOT');
      expect(btcInst.maxLeverage).toBe(1);

      const sizing = PositionSizer.calculatePosition({
        accountBalance: 1000000,
        availableMargin: 1000000,
        riskPercentage: 1.0,
        entryPrice: 84193.02,
        stopLoss: 84000.0,
        symbol: 'BTCUSDT_SPOT',
        instrument: btcInst,
        direction: 'BUY',
        requestedLeverage: 1,
      });

      expect(sizing.isValid).toBe(true);
      expect(sizing.calculatedUnits).toBeGreaterThan(0);
      expect(sizing.initialMarginRequired ?? sizing.totalPositionValue).toBeLessThanOrEqual(1000000);
      expect(sizing.maximumLoss ?? sizing.riskAmount).toBeLessThanOrEqual(10000); // 1% of 10L
    });
  });
});
