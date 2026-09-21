import { BadRequestException } from '@nestjs/common';
import { Direction } from '@quant/shared';
import { ExecutionCostService } from '../execution-cost.service';

describe('Phase 26 — Slippage Modeling & Execution Cost Engine', () => {
  let service: ExecutionCostService;

  beforeEach(() => {
    service = new ExecutionCostService();
  });

  describe('1. Almgren-Chriss Square-Root Market Impact Model', () => {
    it('should compute market impact using non-linear square root of participation rate', () => {
      // Order: 10,000 units. ADV: 1,000,000 units -> Participation = 0.01
      // sqrt(0.01) = 0.10
      // Daily Vol: 0.015 (1.5%)
      // Impact Constant Y: 0.6
      // Expected impact = 0.6 * 0.015 * 0.10 * 10,000 = 9 bps
      const result = service.calculateMarketImpact({
        orderQuantity: 10000,
        averageDailyVolume: 1000000,
        price: 1000,
        dailyVolatility: 0.015,
        impactConstant: 0.6,
        modelType: 'ALMGREN_CHRISS_SQUARE_ROOT',
      });

      expect(result.participationRate).toBe(0.01);
      expect(result.impactBps).toBeCloseTo(9.0, 2);
      expect(result.impactPriceDelta).toBeCloseTo(0.9, 2); // 9 bps of 1000 = 0.90
      expect(result.estimatedImpactCost).toBeCloseTo(9000, 1); // 0.90 * 10,000 = 9000
    });

    it('should exhibit square-root scaling when order size quadruples', () => {
      // Base order: 10,000 units -> 9 bps
      const base = service.calculateMarketImpact({
        orderQuantity: 10000,
        averageDailyVolume: 1000000,
        price: 1000,
        dailyVolatility: 0.015,
      });

      // Quadrupled order: 40,000 units -> sqrt(4) * 9 = 2 * 9 = 18 bps
      const quad = service.calculateMarketImpact({
        orderQuantity: 40000,
        averageDailyVolume: 1000000,
        price: 1000,
        dailyVolatility: 0.015,
      });

      expect(quad.impactBps).toBeCloseTo(base.impactBps * 2, 2);
    });
  });

  describe('2. Linear Market Impact Model', () => {
    it('should scale linearly with order size and gamma parameter', () => {
      // Q = 50,000, ADV = 1,000,000 -> P = 0.05
      // Gamma = 0.10 -> Impact = 0.10 * 0.05 * 10,000 = 50 bps
      const linearResult = service.calculateMarketImpact({
        orderQuantity: 50000,
        averageDailyVolume: 1000000,
        price: 200,
        modelType: 'LINEAR',
        linearGamma: 0.1,
      });

      expect(linearResult.impactBps).toBeCloseTo(50.0, 2);
    });
  });

  describe('3. Bid-Ask Spread Capture & Order Urgency Weighting', () => {
    it('should derive half-spread from live quotes and scale by urgency', () => {
      // Bid: 24000, Ask: 24004.8 -> Mid: 24002.4
      // Half-spread = (24004.8 - 24000) / (2 * 24002.4) * 10,000 = 1.0 bps
      const estimateAggressive = service.estimateSlippage({
        symbol: 'NIFTY',
        direction: 'BUY',
        orderQuantity: 50,
        referencePrice: 24002.4,
        bid: 24000,
        ask: 24004.8,
        averageDailyVolume: 10000000,
        urgency: 'AGGRESSIVE',
      });

      expect(estimateAggressive.halfSpreadBps).toBeCloseTo(1.0, 1);

      // Passive resting order should capture spread (spreadWeight = -0.25)
      const estimatePassive = service.estimateSlippage({
        symbol: 'NIFTY',
        direction: 'BUY',
        orderQuantity: 50,
        referencePrice: 24002.4,
        bid: 24000,
        ask: 24004.8,
        averageDailyVolume: 10000000,
        urgency: 'PASSIVE',
      });

      expect(estimatePassive.totalExpectedSlippageBps).toBeLessThan(
        estimateAggressive.totalExpectedSlippageBps,
      );
    });
  });

  describe('4. Directional Fill Price Adjustment', () => {
    it('should slip BUY orders upwards and SELL orders downwards', () => {
      const refPrice = 1000;

      const buyEstimate = service.estimateSlippage({
        symbol: 'RELIANCE',
        direction: 'BUY',
        orderQuantity: 100,
        referencePrice: refPrice,
        maxSlippageBps: 50,
      });

      const sellEstimate = service.estimateSlippage({
        symbol: 'RELIANCE',
        direction: 'SELL',
        orderQuantity: 100,
        referencePrice: refPrice,
        maxSlippageBps: 50,
      });

      expect(buyEstimate.expectedFillPrice).toBeGreaterThan(refPrice);
      expect(sellEstimate.expectedFillPrice).toBeLessThan(refPrice);
      expect(buyEstimate.expectedSlippageAmount).toBeGreaterThan(0);
      expect(sellEstimate.expectedSlippageAmount).toBeGreaterThan(0);
    });
  });

  describe('5. Pre-Trade Slippage Budget Assertion', () => {
    it('should reject execution when expected slippage exceeds maxSlippageBps budget', () => {
      // Huge order relative to ADV causing 80+ bps market impact
      const estimate = service.estimateSlippage({
        symbol: 'SMALLCAP',
        direction: 'BUY',
        orderQuantity: 500000,
        referencePrice: 100,
        averageDailyVolume: 100000, // order is 5x ADV!
        maxSlippageBps: 30, // 30 bps budget
      });

      expect(estimate.exceedsBudget).toBe(true);
      expect(estimate.actionAllowed).toBe(false);
      expect(estimate.reason).toContain('exceeds maximum allowed budget 30 bps');

      // assertSlippageWithinBudget must throw BadRequestException
      expect(() =>
        service.assertSlippageWithinBudget({
          symbol: 'SMALLCAP',
          direction: 'BUY',
          orderQuantity: 500000,
          referencePrice: 100,
          averageDailyVolume: 100000,
          maxSlippageBps: 30,
        }),
      ).toThrow(BadRequestException);
    });

    it('should allow execution when expected slippage is within budget', () => {
      const estimate = service.estimateSlippage({
        symbol: 'NIFTY',
        direction: 'BUY',
        orderQuantity: 100,
        referencePrice: 24000,
        averageDailyVolume: 20000000,
        maxSlippageBps: 50,
      });

      expect(estimate.exceedsBudget).toBe(false);
      expect(estimate.actionAllowed).toBe(true);
      expect(() =>
        service.assertSlippageWithinBudget({
          symbol: 'NIFTY',
          direction: 'BUY',
          orderQuantity: 100,
          referencePrice: 24000,
          averageDailyVolume: 20000000,
          maxSlippageBps: 50,
        }),
      ).not.toThrow();
    });
  });

  describe('6. Indian Statutory Taxes & Regulatory Charges (NSE)', () => {
    it('should apply STT on both Buy & Sell for Equity Delivery, and Stamp Duty on Buy only', () => {
      const notional = 100000; // 1 Lakh INR

      // Buy Delivery
      const buyCharges = service.calculateItemizedCharges({
        exchange: 'NSE',
        category: 'EQUITY_DELIVERY',
        side: 'BUY',
        price: 1000,
        quantity: 100,
      });

      expect(buyCharges.stt).toBe(100); // 0.1% = 100
      expect(buyCharges.stampDuty).toBe(15); // 0.015% = 15
      expect(buyCharges.brokerage).toBe(20); // capped at 20
      expect(buyCharges.gst).toBeCloseTo((20 + 3.25 + 0.1) * 0.18, 2); // 18% of taxable

      // Sell Delivery
      const sellCharges = service.calculateItemizedCharges({
        exchange: 'NSE',
        category: 'EQUITY_DELIVERY',
        side: 'SELL',
        price: 1000,
        quantity: 100,
      });

      expect(sellCharges.stt).toBe(100); // 0.1% = 100
      expect(sellCharges.stampDuty).toBe(0); // 0 on Sell
    });

    it('should apply STT strictly on SELL side for Equity Intraday, Futures, and Options', () => {
      // 1. Equity Intraday: STT 0.025% on SELL only
      const intraBuy = service.calculateItemizedCharges({
        exchange: 'NSE',
        category: 'EQUITY_INTRADAY',
        side: 'BUY',
        price: 2000,
        quantity: 100,
      });
      const intraSell = service.calculateItemizedCharges({
        exchange: 'NSE',
        category: 'EQUITY_INTRADAY',
        side: 'SELL',
        price: 2000,
        quantity: 100,
      });
      expect(intraBuy.stt).toBe(0);
      expect(intraSell.stt).toBe(50); // 200,000 * 0.00025 = 50

      // 2. Futures: STT 0.02% on SELL only
      const futBuy = service.calculateItemizedCharges({
        exchange: 'NSE',
        category: 'FUTURES',
        side: 'BUY',
        price: 24000,
        quantity: 50,
      });
      const futSell = service.calculateItemizedCharges({
        exchange: 'NSE',
        category: 'FUTURES',
        side: 'SELL',
        price: 24000,
        quantity: 50,
      });
      expect(futBuy.stt).toBe(0);
      expect(futSell.stt).toBe(240); // 1,200,000 * 0.0002 = 240

      // 3. Options: STT 0.1% on Option Premium on SELL only
      const optBuy = service.calculateItemizedCharges({
        exchange: 'NSE',
        category: 'OPTIONS',
        side: 'BUY',
        price: 24000,
        optionPremium: 200,
        quantity: 50,
      });
      const optSell = service.calculateItemizedCharges({
        exchange: 'NSE',
        category: 'OPTIONS',
        side: 'SELL',
        price: 24000,
        optionPremium: 200,
        quantity: 50,
      });
      expect(optBuy.stt).toBe(0);
      expect(optSell.stt).toBe(10); // Premium notional = 200 * 50 = 10,000 * 0.001 = 10
    });
  });

  describe('7. Crypto Exchange Fee Schedules (BINANCE)', () => {
    it('should compute maker (2 bps) and taker (4 bps) fees without Indian taxes', () => {
      const notional = 50000; // $50,000 USDT

      const maker = service.calculateItemizedCharges({
        exchange: 'BINANCE',
        category: 'CRYPTO_SPOT',
        side: 'BUY',
        price: 50000,
        quantity: 1,
        isMaker: true,
      });

      expect(maker.brokerage).toBe(10); // 50,000 * 0.0002 = 10
      expect(maker.stt).toBe(0);
      expect(maker.gst).toBe(0);
      expect(maker.totalTaxesAndCharges).toBe(10);

      const taker = service.calculateItemizedCharges({
        exchange: 'BINANCE',
        category: 'CRYPTO_SPOT',
        side: 'BUY',
        price: 50000,
        quantity: 1,
        isMaker: false,
      });

      expect(taker.brokerage).toBe(20); // 50,000 * 0.0004 = 20
      expect(taker.totalTaxesAndCharges).toBe(20);
    });
  });

  describe('8. Total Execution Cost & Execution Quality Analysis', () => {
    it('should accurately combine itemized statutory charges with slippage estimate', () => {
      const total = service.calculateTotalExecutionCost({
        slippageParams: {
          symbol: 'TCS',
          direction: 'BUY',
          orderQuantity: 50,
          referencePrice: 3800,
          averageDailyVolume: 1000000,
        },
        chargeParams: {
          exchange: 'NSE',
          category: 'EQUITY_INTRADAY',
          side: 'BUY',
          price: 3800,
          quantity: 50,
        },
      });

      expect(total.itemizedCharges.totalTaxesAndCharges).toBeGreaterThan(0);
      expect(total.slippageEstimate.expectedSlippageAmount).toBeGreaterThan(0);
      expect(total.totalExpectedCostAccount).toBeCloseTo(
        total.itemizedCharges.totalTaxesAndCharges + total.slippageEstimate.expectedSlippageAmount,
        2,
      );
      expect(total.costBpsOfNotional).toBeGreaterThan(0);
    });

    it('should analyze post-trade execution quality and categorize slippage drift', () => {
      // 1. Superior execution: beat expected slippage by > 2 bps
      const sup = service.analyzeExecutionQuality('ord_1', 10, 6);
      expect(sup.qualityAssessment).toBe('SUPERIOR');
      expect(sup.slippageDriftBps).toBe(-4);

      // 2. In-line execution: within 5 bps drift
      const inLine = service.analyzeExecutionQuality('ord_2', 10, 12);
      expect(inLine.qualityAssessment).toBe('IN_LINE');

      // 3. Degraded execution: 5 - 15 bps drift
      const degraded = service.analyzeExecutionQuality('ord_3', 10, 20);
      expect(degraded.qualityAssessment).toBe('DEGRADED');

      // 4. Excessive execution: > 15 bps drift
      const excessive = service.analyzeExecutionQuality('ord_4', 10, 30);
      expect(excessive.qualityAssessment).toBe('EXCESSIVE');
    });
  });

  describe('9. Fail-Closed Edge Cases & Robustness', () => {
    it('should throw BadRequestException on non-positive or non-finite prices or quantities', () => {
      expect(() =>
        service.calculateMarketImpact({
          orderQuantity: -10,
          averageDailyVolume: 1000000,
          price: 1000,
        }),
      ).toThrow(BadRequestException);

      expect(() =>
        service.estimateSlippage({
          symbol: 'TEST',
          direction: 'BUY',
          orderQuantity: 100,
          referencePrice: -50,
        }),
      ).toThrow(BadRequestException);
    });
  });
});
