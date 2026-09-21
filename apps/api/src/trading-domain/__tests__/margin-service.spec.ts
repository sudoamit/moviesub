import { Test, TestingModule } from '@nestjs/testing';
import { PositionSide } from '@quant/shared';
import { MarginService } from '../margin.service';

describe('MarginService', () => {
  let marginService: MarginService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [MarginService],
    }).compile();

    marginService = module.get<MarginService>(MarginService);
  });

  describe('Separation of Notional Exposure, Margin, and Risk', () => {
    it('separates notional exposure, initial margin, maintenance margin, and risk amount', () => {
      const res = marginService.calculateMargin({
        instrument: {
          symbol: 'BTCUSDT_PERP',
          contractSize: 1,
          maxLeverage: 20,
          maintenanceMarginRate: 0.05,
          marginMode: 'ISOLATED',
        } as any,
        quantity: 2,
        price: 50000,
        stopLoss: 48000, // 2000 per BTC risk
        leverage: 10,
        direction: PositionSide.LONG,
        accountCashBalance: 25000,
        currentUsedMargin: 5000,
      });

      // 1. Notional Exposure: 2 * 50000 = 100,000
      expect(res.notionalAccount).toBe(100000);
      expect(res.notionalValue).toBe(100000);

      // 2. Initial Margin: 100,000 / 10 = 10,000
      expect(res.initialMarginRequired).toBe(10000);
      expect(res.initialMargin).toBe(10000);

      // 3. Maintenance Margin: 100,000 * 0.05 = 5,000
      expect(res.maintenanceMarginRequired).toBe(5000);
      expect(res.maintenanceMargin).toBe(5000);

      // 4. Risk Amount: |50000 - 48000| * 2 = 4,000
      expect(res.riskAmount).toBe(4000);

      // 5. Margin Balance Tracking:
      // usedMargin = currentUsed (5000) + initialMargin (10000) = 15000
      expect(res.usedMargin).toBe(15000);
      // availableMargin = 25000 - 15000 = 10000
      expect(res.availableMargin).toBe(10000);

      // 6. Effective Leverage
      expect(res.effectiveLeverage).toBe(10);
    });

    it('accurately factors contractSize and FX conversion rate into notional and margin', () => {
      const res = marginService.calculateMargin({
        instrument: {
          symbol: 'BANKNIFTY26SEP50000FUT',
          contractSize: 15,
          maxLeverage: 5,
          maintenanceMarginRate: 0.10,
          marginMode: 'ISOLATED',
        } as any,
        quantity: 2, // 2 contracts = 30 index units
        price: 50000,
        leverage: 5,
        fxRate: 0.012, // INR to USD
      });

      // Quote Notional: 2 * 50000 * 15 = 1,500,000 INR
      expect(res.notionalQuote).toBe(1500000);
      // Account Notional (USD): 1,500,000 * 0.012 = 18,000 USD
      expect(res.notionalAccount).toBe(18000);
      expect(res.notionalValue).toBe(18000);

      // Initial Margin: 18000 / 5 = 3,600 USD
      expect(res.initialMarginRequired).toBe(3600);
      // Maintenance Margin: 18000 * 0.10 = 1,800 USD
      expect(res.maintenanceMarginRequired).toBe(1800);
    });
  });

  describe('Spot Margin Invariants', () => {
    it('enforces leverage=1, 100% margin, and no liquidation price for SPOT instruments', () => {
      const res = marginService.calculateMargin({
        instrument: {
          symbol: 'BTCUSDT_SPOT',
          contractSize: 1,
          marginMode: 'SPOT',
        } as any,
        quantity: 0.5,
        price: 60000,
        leverage: 25, // Caller attempts to pass leverage on spot
      });

      expect(res.effectiveLeverage).toBe(1);
      expect(res.notionalAccount).toBe(30000);
      expect(res.initialMarginRequired).toBe(30000); // 100%
      expect(res.maintenanceMarginRequired).toBe(30000);
      expect(res.marginMode).toBe('SPOT');
      expect(res.liquidationPrice).toBeUndefined();
      expect(res.fundingPayment).toBeUndefined();
    });
  });

  describe('Option Premium Margin Invariants', () => {
    it('treats long options as 100% initial premium payment with zero maintenance margin', () => {
      const res = marginService.calculateMargin({
        instrument: {
          symbol: 'NIFTY26SEP24500CE',
          contractSize: 25,
          assetType: 'OPTION',
        } as any,
        quantity: 4, // 4 lots = 100 units
        price: 150,  // Option premium = 150
        leverage: 10, // Leveraged options are not allowed for pure buyer
      });

      expect(res.effectiveLeverage).toBe(1);
      // Notional = 4 * 150 * 25 = 15,000
      expect(res.notionalAccount).toBe(15000);
      expect(res.initialMarginRequired).toBe(15000); // Buyer pays full premium
      expect(res.maintenanceMarginRequired).toBe(0); // Long buyer has no maintenance margin call
      expect(res.liquidationPrice).toBeUndefined();
    });
  });

  describe('Liquidation Price Calculation', () => {
    it('calculates long liquidation price: entryPrice * (1 - 1/leverage + MMR)', () => {
      const liqLong = marginService.calculateLiquidationPrice({
        entryPrice: 1000,
        leverage: 10,
        maintenanceMarginRate: 0.05,
        direction: PositionSide.LONG,
      });

      // 1000 * (1 - 0.10 + 0.05) = 1000 * 0.95 = 950
      expect(liqLong).toBe(950);
    });

    it('calculates short liquidation price: entryPrice * (1 + 1/leverage - MMR)', () => {
      const liqShort = marginService.calculateLiquidationPrice({
        entryPrice: 1000,
        leverage: 10,
        maintenanceMarginRate: 0.05,
        direction: PositionSide.SHORT,
      });

      // 1000 * (1 + 0.10 - 0.05) = 1000 * 1.05 = 1050
      expect(liqShort).toBe(1050);
    });

    it('returns undefined when leverage <= 1 or invalid price', () => {
      expect(
        marginService.calculateLiquidationPrice({
          entryPrice: 1000,
          leverage: 1,
          maintenanceMarginRate: 0.05,
          direction: PositionSide.LONG,
        }),
      ).toBeUndefined();

      expect(
        marginService.calculateLiquidationPrice({
          entryPrice: 0,
          leverage: 10,
          maintenanceMarginRate: 0.05,
          direction: PositionSide.LONG,
        }),
      ).toBeUndefined();
    });

    it('clamps negative long liquidation price to 0', () => {
      // Extremely low leverage / high MMR scenario (e.g. leverage 1.1, MMR 0.01: 1 - 0.909 + 0.01 = 0.101)
      // Extreme case: leverage 1.05, MMR = -0.1 -> negative
      const liq = marginService.calculateLiquidationPrice({
        entryPrice: 100,
        leverage: 1.01,
        maintenanceMarginRate: -0.05,
        direction: PositionSide.LONG,
      });
      expect(liq).toBe(0);
    });
  });

  describe('Margin Ratio and Health Monitoring', () => {
    it('calculates margin ratio = maintenanceMargin / marginEquity', () => {
      // MMR requirement: 2,000; Margin Equity: 10,000 -> Ratio: 0.20 (20% healthy)
      const ratio = marginService.calculateMarginRatio(2000, 10000);
      expect(ratio).toBe(0.20);
    });

    it('detects margin call / liquidation threshold when margin ratio >= 1.0', () => {
      // MMR requirement: 5,000; Margin Equity: 4,000 -> Ratio: 1.25 (Insolvency / Liquidation)
      const ratio = marginService.calculateMarginRatio(5000, 4000);
      expect(ratio).toBe(1.25);
    });

    it('handles zero or negative margin equity gracefully', () => {
      expect(marginService.calculateMarginRatio(1000, 0)).toBe(1.0);
      expect(marginService.calculateMarginRatio(1000, -500)).toBe(1.0);
      expect(marginService.calculateMarginRatio(0, 0)).toBe(0);
    });
  });

  describe('Funding Payment Calculation', () => {
    it('calculates funding payment = notionalValue * fundingRate', () => {
      // Position notional: $50,000, 8-hour funding rate: +0.01% (+0.0001)
      const payment = marginService.calculateFundingPayment(50000, 0.0001);
      expect(payment).toBe(5); // $5 outflow for long
    });

    it('supports negative funding rate (shorts pay longs)', () => {
      // Position notional: $50,000, 8-hour funding rate: -0.015% (-0.00015)
      const payment = marginService.calculateFundingPayment(50000, -0.00015);
      expect(payment).toBe(-7.5);
    });
  });

  describe('Margin Sufficiency Validation', () => {
    it('passes when available margin exceeds required margin + buffer', () => {
      const check = marginService.validateMarginSufficiency(10000, 8000, 500);
      expect(check.sufficient).toBe(true);
      expect(check.deficit).toBe(0);
    });

    it('fails and returns deficit when available margin is insufficient', () => {
      const check = marginService.validateMarginSufficiency(5000, 4800, 300);
      expect(check.sufficient).toBe(false);
      expect(check.deficit).toBe(100); // 5100 required - 5000 available = 100 deficit
    });
  });
});
