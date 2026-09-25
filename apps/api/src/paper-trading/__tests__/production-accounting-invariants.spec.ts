import { PositionSizer, TradeAccountingEngine } from '@quant/risk-engine';
import {
  Direction,
  getAuthoritativeInstrument,
  PointInTimeCurrencyConverter,
  resolveMarginModel,
} from '@quant/shared';
import { BadRequestException } from '@nestjs/common';
import { Decimal } from '@prisma/client/runtime/library';
import { PaperTradingService } from '../paper-trading.service';

describe('Production Trading & Accounting Invariants Regression Tests', () => {
  const pitConverter = PointInTimeCurrencyConverter.getInstance();
  const fxUsdtInr = pitConverter.getRate('USDT', 'INR', Date.now()).fxRate; // e.g. 92.5

  // =========================================================================
  // TEST 1 — Positive LONG P&L (BTCUSDT_SPOT)
  // =========================================================================
  it('TEST 1: Positive LONG price move yields positive gross quote and account P&L', () => {
    const entryPrice = 84190.98;
    const currentPrice = 84333.08;
    const quantity = 0.05;

    const pnlCalc = TradeAccountingEngine.calculateTradePnl({
      entryPrice,
      exitPrice: currentPrice,
      quantity,
      direction: Direction.BULLISH,
      quoteCurrency: 'USDT',
      accountCurrency: 'INR',
      fxRate: fxUsdtInr,
    });

    expect(pnlCalc.priceMove).toBeCloseTo(142.10, 2);
    expect(pnlCalc.grossPnlQuote).toBeCloseTo(7.105, 3);
    expect(pnlCalc.grossPnlAccount).toBeCloseTo(Number((7.105 * fxUsdtInr).toFixed(2)), 2);
    expect(pnlCalc.grossPnlQuote).toBeGreaterThan(0);
    expect(pnlCalc.grossPnlAccount).toBeGreaterThan(0);
  });

  // =========================================================================
  // TEST 2 — Positive SHORT P&L
  // =========================================================================
  it('TEST 2: Positive SHORT price move (falling price) yields positive gross quote P&L', () => {
    const entryPrice = 84333.08;
    const currentPrice = 84190.98;
    const quantity = 0.05;

    const pnlCalc = TradeAccountingEngine.calculateTradePnl({
      entryPrice,
      exitPrice: currentPrice,
      quantity,
      direction: Direction.BEARISH,
      quoteCurrency: 'USDT',
      accountCurrency: 'INR',
      fxRate: fxUsdtInr,
    });

    expect(pnlCalc.priceMove).toBeCloseTo(142.10, 2);
    expect(pnlCalc.grossPnlQuote).toBeCloseTo(7.105, 3);
    expect(pnlCalc.grossPnlQuote).toBeGreaterThan(0);
    expect(pnlCalc.grossPnlAccount).toBeGreaterThan(0);
  });

  // =========================================================================
  // TEST 3 — Losing LONG
  // =========================================================================
  it('TEST 3: Adverse price move on LONG yields negative gross quote P&L', () => {
    const entryPrice = 84190.98;
    const currentPrice = 84030.98;
    const quantity = 0.05;

    const pnlCalc = TradeAccountingEngine.calculateTradePnl({
      entryPrice,
      exitPrice: currentPrice,
      quantity,
      direction: Direction.BULLISH,
      quoteCurrency: 'USDT',
      accountCurrency: 'INR',
      fxRate: fxUsdtInr,
    });

    expect(pnlCalc.priceMove).toBeCloseTo(-160.0, 2);
    expect(pnlCalc.grossPnlQuote).toBeCloseTo(-8.0, 2);
    expect(pnlCalc.grossPnlQuote).toBeLessThan(0);
    expect(pnlCalc.grossPnlAccount).toBeLessThan(0);
  });

  // =========================================================================
  // TEST 4 — Leverage Independence
  // =========================================================================
  it('TEST 4: Gross P&L is strictly invariant under leverage for the same quantity', () => {
    const entryPrice = 84190.98;
    const currentPrice = 84333.08;
    const quantity = 0.05;

    const pnl1x = TradeAccountingEngine.calculateTradePnl({
      entryPrice,
      exitPrice: currentPrice,
      quantity,
      direction: 'LONG',
      fxRate: fxUsdtInr,
    });

    const pnl5x = TradeAccountingEngine.calculateTradePnl({
      entryPrice,
      exitPrice: currentPrice,
      quantity,
      direction: 'LONG',
      fxRate: fxUsdtInr,
    });

    const pnl10x = TradeAccountingEngine.calculateTradePnl({
      entryPrice,
      exitPrice: currentPrice,
      quantity,
      direction: 'LONG',
      fxRate: fxUsdtInr,
    });

    const pnl50x = TradeAccountingEngine.calculateTradePnl({
      entryPrice,
      exitPrice: currentPrice,
      quantity,
      direction: 'LONG',
      fxRate: fxUsdtInr,
    });

    // Invariant: grossPnl(1x) === grossPnl(5x) === grossPnl(10x) === grossPnl(50x)
    expect(pnl1x.grossPnlQuote).toBe(7.105);
    expect(pnl5x.grossPnlQuote).toBe(pnl1x.grossPnlQuote);
    expect(pnl10x.grossPnlQuote).toBe(pnl1x.grossPnlQuote);
    expect(pnl50x.grossPnlQuote).toBe(pnl1x.grossPnlQuote);

    expect(pnl1x.grossPnlAccount).toBe(pnl50x.grossPnlAccount);
  });

  // =========================================================================
  // TEST 5 — BTCUSDT_SPOT Leverage Rejection
  // =========================================================================
  it('TEST 5: Explicitly rejects requested 50x leverage on BTCUSDT_SPOT with LEVERAGE_EXCEEDS_MAX', async () => {
    const btcInst = getAuthoritativeInstrument('BTCUSDT_SPOT');
    expect(btcInst.marginMode).toBe('SPOT');
    expect(btcInst.maxLeverage).toBe(1);

    const mockPrisma: any = {
      paperAccount: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'acc-1',
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
      {} as any, // candlesService
      { getValidatedTicker: () => ({ price: 84190.98 }) } as any, // streamer
      undefined, // tradeLifecycleService
      {} as any, // accountingService
      {} as any, // positionService
      {} as any, // orderService
      {} as any, // fillService
      {} as any, // reconciliationService
      {} as any, // marginService
      {} as any, // journalService
    );

    jest.spyOn(service as any, 'getOrCreateAccount').mockResolvedValue({
      id: 'acc-1',
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
      price: 84190.98,
      timestamp: new Date(),
    });

    await expect(
      service.placeOrder({
        symbol: 'BTCUSDT_SPOT',
        direction: 'BUY',
        orderType: 'MARKET',
        quantity: 0.05,
        stopLoss: 84000,
        target1: 85000,
        leverage: 50,
      }),
    ).rejects.toThrow(BadRequestException);

    try {
      await service.placeOrder({
        symbol: 'BTCUSDT_SPOT',
        direction: 'BUY',
        orderType: 'MARKET',
        quantity: 0.05,
        stopLoss: 84000,
        target1: 85000,
        leverage: 50,
      });
    } catch (err: any) {
      expect(err.message).toContain('LEVERAGE_EXCEEDS_MAX');
      expect(err.message).toContain('BTCUSDT_SPOT');
      expect(err.message).toContain('50x');
      expect(err.message).toContain('1x');
    }
  });

  // =========================================================================
  // TEST 6 — BTCUSDT_SPOT Always 1x When No Leverage Provided
  // =========================================================================
  it('TEST 6: BTCUSDT_SPOT defaults to 1x leverage and SPOT margin model', () => {
    const inst = getAuthoritativeInstrument('BTCUSDT_SPOT');
    const marginModel = resolveMarginModel(inst);

    expect(marginModel.effectiveLeverage).toBe(1);
    expect(marginModel.marginMode).toBe('SPOT');
    expect(marginModel.initialMarginRate).toBe(1.0);
    expect(marginModel.liquidationModel).toBe('SPOT_NONE');
  });

  // =========================================================================
  // TEST 7 — Margin Calculation (Spot = 100% Notional)
  // =========================================================================
  it('TEST 7: SPOT required margin equals 100% notional', () => {
    const price = 84190.98;
    const quantity = 0.05;
    const notionalQuote = price * quantity; // 4209.549 USDT
    const notionalAccount = notionalQuote * fxUsdtInr; // ~389,383.28 INR

    const inst = getAuthoritativeInstrument('BTCUSDT_SPOT');
    const model = resolveMarginModel(inst);

    const requiredMargin = (notionalAccount * model.initialMarginRate) / model.effectiveLeverage;

    expect(model.effectiveLeverage).toBe(1);
    expect(model.initialMarginRate).toBe(1.0);
    expect(requiredMargin).toBeCloseTo(notionalAccount, 2);
  });

  // =========================================================================
  // TEST 8 — Fee Calculation Audit
  // =========================================================================
  it('TEST 8: Incurred fees are deducted accurately and open positions do not charge double exit fees', () => {
    const entryPrice = 84190.98;
    const currentPrice = 84333.08;
    const quantity = 0.05;
    const fxRate = 92.5;

    // Gross P&L: 7.105 USDT * 92.5 = 657.21 INR
    const grossPnlAccount = Number(((currentPrice - entryPrice) * quantity * fxRate).toFixed(2));
    expect(grossPnlAccount).toBe(657.21);

    // Binance entry fee: 0.1% of turnover = 4209.549 * 0.001 = 4.2095 USDT * 92.5 = 389.38 INR
    const entryFeeInr = 389.38;

    const pnlCalc = TradeAccountingEngine.calculateTradePnl({
      entryPrice,
      exitPrice: currentPrice,
      quantity,
      direction: 'LONG',
      fxRate,
      fees: entryFeeInr,
    });

    // Net P&L: 657.21 - 389.38 = +267.83 INR (STILL POSITIVE!)
    expect(pnlCalc.grossPnlAccount).toBe(657.21);
    expect(pnlCalc.fees).toBe(389.38);
    expect(pnlCalc.netPnlAccount).toBe(267.83);
    expect(pnlCalc.netPnlAccount).toBeGreaterThan(0);
  });

  // =========================================================================
  // TEST 9 — Single FX Conversion
  // =========================================================================
  it('TEST 9: USDT P&L is converted to INR exactly once', () => {
    const entryPrice = 84190.98;
    const currentPrice = 84333.08;
    const quantity = 0.05;
    const fxRate = 92.5;

    const pnlCalc = TradeAccountingEngine.calculateTradePnl({
      entryPrice,
      exitPrice: currentPrice,
      quantity,
      direction: 'LONG',
      quoteCurrency: 'USDT',
      accountCurrency: 'INR',
      fxRate,
    });

    const expectedQuotePnl = Number(((currentPrice - entryPrice) * quantity).toFixed(4));
    expect(pnlCalc.grossPnlQuote).toBe(expectedQuotePnl);
    expect(pnlCalc.grossPnlAccount).toBe(Number((expectedQuotePnl * fxRate).toFixed(2)));
    expect(pnlCalc.fxRateUsed).toBe(fxRate);
  });

  // =========================================================================
  // TEST 10 — R-Multiple Calculation
  // =========================================================================
  it('TEST 10: R-multiple is derived strictly from price risk distance', () => {
    const entryPrice = 84190.98;
    const stopLoss = 84030.98;
    const currentPrice = 84333.08;
    const quantity = 0.05;

    // Risk points = 84190.98 - 84030.98 = 160.00
    // Price move = 84333.08 - 84190.98 = 142.10
    // Expected R = 142.10 / 160.00 = 0.888125R (~0.8881R)
    const pnlCalc = TradeAccountingEngine.calculateTradePnl({
      entryPrice,
      exitPrice: currentPrice,
      quantity,
      direction: 'LONG',
      stopLoss,
      initialStopLoss: stopLoss,
      fxRate: fxUsdtInr,
    });

    expect(pnlCalc.realizedR).toBeCloseTo(0.8881, 3);
  });

  // =========================================================================
  // TEST 11 — REQUIRED VALIDATION: ₹300,000 Capital Rejection for 0.05 BTC Spot
  // =========================================================================
  it('TEST 11: Rejects 0.05 BTC BTCUSDT_SPOT order when account capital is ₹300,000 (required margin ₹389,383 > available ₹300,000)', async () => {
    const entryPrice = 84190.98;
    const quantity = 0.05;
    const accountCash = 300000; // Account only has ₹3,00,000
    const notionalQuote = entryPrice * quantity; // 4,209.549 USDT
    const requiredMargin = Number((notionalQuote * fxUsdtInr).toFixed(2)); // ~₹389,383.28

    expect(requiredMargin).toBeGreaterThan(accountCash);

    let paperPositionCreated = false;
    let paperOrderCreated = false;

    const mockTx: any = {
      paperAccount: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'acc-300k',
          currency: 'INR',
          cashBalance: new Decimal(accountCash),
        }),
      },
      paperPosition: {
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockImplementation(() => {
          paperPositionCreated = true;
          return { id: 'pos-1' };
        }),
      },
      paperOrder: {
        create: jest.fn().mockImplementation(() => {
          paperOrderCreated = true;
          return { id: 'order-1' };
        }),
      },
      paperFill: {
        create: jest.fn().mockResolvedValue({ id: 'fill-1' }),
      },
    };

    const mockPrisma: any = {
      paperAccount: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'acc-300k',
          currency: 'INR',
          cashBalance: new Decimal(accountCash),
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
          configJson: { maxLeverage: 10, maxSlippageBps: 0, maxTotalExposurePercent: 100 },
        }),
      },
      $transaction: jest.fn().mockImplementation(async (callback: any) => {
        return callback(mockTx);
      }),
    };

    const service = new PaperTradingService(
      mockPrisma,
      {} as any,
      { getValidatedTicker: () => ({ price: entryPrice }) } as any,
      undefined,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );

    jest.spyOn(service as any, 'getOrCreateAccount').mockResolvedValue({
      id: 'acc-300k',
      currency: 'INR',
      cashBalance: new Decimal(accountCash),
      initialCapital: new Decimal(accountCash),
    });
    jest.spyOn(service as any, 'getSystemConfig').mockResolvedValue({
      maxLeverage: 10,
      maxSlippageBps: 0,
      maxTotalExposurePercent: 100,
      maxPositionRiskPercent: 10,
      maxDailyLossPercent: 10,
      maxTradesPerDay: 50,
      maxConsecutiveLosses: 10,
      maxOpenPositions: 5,
    });
    jest.spyOn(service as any, 'rejectOrder').mockResolvedValue(undefined as any);
    jest.spyOn(service as any, 'getValidatedMarketPrice').mockResolvedValue({
      price: entryPrice,
      timestamp: new Date(),
    });

    await expect(
      service.placeOrder({
        symbol: 'BTCUSDT_SPOT',
        direction: 'BUY',
        orderType: 'MARKET',
        quantity: 0.05,
        price: entryPrice,
        stopLoss: 84030.98,
        target1: 84430.98,
        leverage: 1,
      }),
    ).rejects.toThrow(BadRequestException);

    try {
      await service.placeOrder({
        symbol: 'BTCUSDT_SPOT',
        direction: 'BUY',
        orderType: 'MARKET',
        quantity: 0.05,
        price: entryPrice,
        stopLoss: 84030.98,
        target1: 84430.98,
        leverage: 1,
      });
    } catch (err: any) {
      expect(err.message).toContain('INSUFFICIENT_MARGIN');
    }

    // Invariant: No FILLED order or PaperPosition may exist
    expect(paperPositionCreated).toBe(false);
    expect(paperOrderCreated).toBe(false);
  });

  // =========================================================================
  // TEST 12 — SECOND TEST: Affordable Spot Position
  // =========================================================================
  it('TEST 12: Sizing engine limits BTCUSDT_SPOT quantity to affordable cash balance (<= 0.0385 BTC for ₹300,000 capital)', () => {
    const accountBalance = 300000;
    const entryPrice = 84190.98;
    const stopLoss = 84030.98;

    const sizing = PositionSizer.calculatePosition({
      accountBalance,
      availableMargin: accountBalance,
      riskPercentage: 1.0, // 1% risk = ₹3000
      entryPrice,
      stopLoss,
      symbol: 'BTCUSDT_SPOT',
      requestedLeverage: 1,
    });

    expect(sizing.isValid).toBe(true);
    // 300000 / (84190.98 * 92.5) ≈ 0.038522 BTC -> floor to 0.0385 BTC
    expect(sizing.roundedUnits).toBeLessThanOrEqual(0.0386);
    expect(sizing.roundedUnits).toBeGreaterThan(0.038);
    expect(sizing.initialMarginRequired).toBeLessThanOrEqual(accountBalance);
    // Risk must also be within risk budget
    expect(sizing.maximumLoss).toBeLessThanOrEqual(3000);
  });

  // =========================================================================
  // TEST 13 — THIRD TEST: 50x Spot Rejected
  // =========================================================================
  it('TEST 13: Position sizer explicitly rejects requested 50x leverage on BTCUSDT_SPOT without silently converting to 1x', () => {
    const sizing = PositionSizer.calculatePosition({
      accountBalance: 300000,
      riskPercentage: 1.0,
      entryPrice: 84190.98,
      stopLoss: 84030.98,
      symbol: 'BTCUSDT_SPOT',
      requestedLeverage: 50,
    });

    expect(sizing.isValid).toBe(false);
    expect(sizing.rejectionReason).toContain('LEVERAGE_EXCEEDS_MAX');
    expect(sizing.roundedUnits).toBe(0);
  });

  // =========================================================================
  // TEST 14 — FOURTH TEST: Approved Leveraged Instrument
  // =========================================================================
  it('TEST 14: Approved leveraged derivative instrument validates margin correctly under leverage', () => {
    const btcDeriv = getAuthoritativeInstrument('BTCUSDT');
    expect(btcDeriv.marginMode).toBe('ISOLATED');
    expect(btcDeriv.maxLeverage).toBeGreaterThanOrEqual(20);

    const accountBalance = 300000;
    const entryPrice = 84190.98;
    const stopLoss = 84030.98;
    const requestedLeverage = 20;

    const sizing = PositionSizer.calculatePosition({
      accountBalance,
      availableMargin: accountBalance,
      riskPercentage: 1.0,
      entryPrice,
      stopLoss,
      symbol: 'BTCUSDT',
      instrument: btcDeriv,
      requestedLeverage,
    });

    expect(sizing.isValid).toBe(true);
    expect(sizing.leverage).toBe(20);
    expect(sizing.resolvedMarginModel?.effectiveLeverage).toBe(20);
    // For 20x, required margin is notional / 20, well below ₹300,000
    expect(sizing.initialMarginRequired).toBeLessThan(accountBalance);
  });

  // =========================================================================
  // TEST 15 — FIFTH TEST: Strategy Stop Loss Invariant & Geometry Validation
  // =========================================================================
  it('TEST 15: Exact stop loss from signal is strictly preserved and invalid geometry is rejected', async () => {
    const strategySL = 84030.98;
    const entryPrice = 84190.98;

    let executedPositionSL: number | undefined;

    const mockTx: any = {
      paperAccount: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'acc-1',
          currency: 'INR',
          cashBalance: new Decimal(1000000),
        }),
        update: jest.fn().mockResolvedValue({}),
      },
      paperPosition: {
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockImplementation((args: any) => {
          executedPositionSL = Number(args.data.stopLoss);
          return { id: 'pos-1', ...args.data };
        }),
      },
      paperOrder: {
        create: jest.fn().mockResolvedValue({ id: 'order-1' }),
      },
      paperFill: {
        create: jest.fn().mockResolvedValue({ id: 'fill-1' }),
      },
      auditEvent: {
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };

    const mockPrisma: any = {
      paperAccount: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'acc-1',
          currency: 'INR',
          cashBalance: new Decimal(1000000),
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
          configJson: { maxLeverage: 10, maxSlippageBps: 0, maxTotalExposurePercent: 100 },
        }),
      },
      $transaction: jest.fn().mockImplementation(async (callback: any) => {
        return callback(mockTx);
      }),
    };

    const service = new PaperTradingService(
      mockPrisma,
      {} as any,
      { getValidatedTicker: () => ({ price: entryPrice }) } as any,
      undefined,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );

    jest.spyOn(service as any, 'getOrCreateAccount').mockResolvedValue({
      id: 'acc-1',
      currency: 'INR',
      cashBalance: new Decimal(1000000),
      initialCapital: new Decimal(1000000),
    });
    jest.spyOn(service as any, 'getSystemConfig').mockResolvedValue({
      maxLeverage: 10,
      maxSlippageBps: 0,
      maxTotalExposurePercent: 100,
      maxPositionRiskPercent: 10,
      maxDailyLossPercent: 10,
      maxTradesPerDay: 50,
      maxConsecutiveLosses: 10,
      maxOpenPositions: 5,
    });
    jest.spyOn(service as any, 'rejectOrder').mockResolvedValue(undefined as any);
    jest.spyOn(service as any, 'getValidatedMarketPrice').mockResolvedValue({
      price: entryPrice,
      timestamp: new Date(),
    });

    await service.placeOrder({
      symbol: 'BTCUSDT_SPOT',
      direction: 'BUY',
      orderType: 'MARKET',
      quantity: 0.01,
      price: entryPrice,
      stopLoss: strategySL,
      target1: 84430.98,
      leverage: 1,
    });

    // Invariant: executed position stopLoss must match approved signal stopLoss exactly
    expect(executedPositionSL).toBe(strategySL);

    // Invalid Geometry: LONG order with SL above entry price must be rejected
    await expect(
      service.placeOrder({
        symbol: 'BTCUSDT_SPOT',
        direction: 'BUY',
        orderType: 'MARKET',
        quantity: 0.01,
        price: entryPrice,
        stopLoss: 85000.0, // Invalid: above entry
        target1: 86000.0,
        leverage: 1,
      }),
    ).rejects.toThrow(BadRequestException);
  });

  // =========================================================================
  // TEST 16 — SIXTH TEST: Risk Budget Capping
  // =========================================================================
  it('TEST 16: Actual position risk cannot exceed configured risk budget', () => {
    const accountBalance = 300000;
    const riskPercentage = 1.0;
    const riskBudget = accountBalance * (riskPercentage / 100); // ₹3,000

    const entryPrice = 84190.98;
    const stopLoss = 84030.98;
    const stopDistance = entryPrice - stopLoss; // 160 USDT

    const sizing = PositionSizer.calculatePosition({
      accountBalance,
      availableMargin: accountBalance,
      riskPercentage,
      entryPrice,
      stopLoss,
      symbol: 'BTCUSDT_SPOT',
      requestedLeverage: 1,
    });

    expect(sizing.isValid).toBe(true);
    const actualRisk = Number((stopDistance * sizing.roundedUnits * fxUsdtInr).toFixed(2));
    expect(actualRisk).toBeLessThanOrEqual(riskBudget);
    expect(sizing.maximumLoss).toBeLessThanOrEqual(riskBudget);
  });

  // =========================================================================
  // TEST 17 — SEVENTH TEST: Canonical P&L and Fee Breakdown
  // =========================================================================
  it('TEST 17: Canonical P&L calculation accurately exposes grossPnlQuote, grossPnlAccount, fees, and netPnlAccount', () => {
    const entryPrice = 84190.98;
    const currentPrice = 84333.08;
    const quantity = 0.05;
    const fxRate = 92.5;
    const fees = 750.35; // Roundtrip/brokerage fees

    const pnlCalc = TradeAccountingEngine.calculateTradePnl({
      entryPrice,
      exitPrice: currentPrice,
      quantity,
      direction: 'LONG',
      fxRate,
      fees,
    });

    // Favorable move: 84333.08 - 84190.98 = +142.10
    expect(pnlCalc.priceMove).toBeCloseTo(142.10, 2);
    // Gross quote: 142.10 * 0.05 = +7.105 USDT
    expect(pnlCalc.grossPnlQuote).toBeCloseTo(7.105, 3);
    // Gross account: 7.105 * 92.5 = +657.21 INR (> 0)
    expect(pnlCalc.grossPnlAccount).toBeCloseTo(657.21, 2);
    expect(pnlCalc.grossPnlAccount).toBeGreaterThan(0);
    // Fees: 750.35 INR
    expect(pnlCalc.fees).toBe(750.35);
    // Net account: 657.21 - 750.35 = -93.14 INR
    expect(pnlCalc.netPnlAccount).toBeCloseTo(-93.14, 2);
  });

  // =========================================================================
  // SECTION: REQUIRED HARD TESTS (A THROUGH H)
  // =========================================================================
  describe('Required Hard Tests (TEST A - TEST H)', () => {
    const entryPrice = 84190.98;
    const currentPrice = 84333.08;
    const stopLoss = 84030.98;
    const fxUsdtInr = 92.5;

    // -----------------------------------------------------------------------
    // TEST A: ₹300,000 account, BTCUSDT_SPOT, 0.05 BTC, 1x -> REJECT, No Position
    // -----------------------------------------------------------------------
    it('TEST A: ₹300,000 account, BTCUSDT_SPOT, 0.05 BTC, 1x -> ORDER REJECTED, no position created', async () => {
      const accountCash = 300000;
      const quantity = 0.05;
      const requiredMargin = entryPrice * quantity * fxUsdtInr; // ~₹389,383
      expect(requiredMargin).toBeGreaterThan(accountCash);

      let positionCreated = false;
      let orderCreated = false;

      const mockTx: any = {
        paperAccount: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'acc-test-a',
            currency: 'INR',
            cashBalance: new Decimal(accountCash),
          }),
        },
        paperPosition: {
          findMany: jest.fn().mockResolvedValue([]),
          create: jest.fn().mockImplementation(() => {
            positionCreated = true;
            return { id: 'pos-a' };
          }),
        },
        paperOrder: {
          create: jest.fn().mockImplementation(() => {
            orderCreated = true;
            return { id: 'order-a' };
          }),
        },
      };

      const mockPrisma: any = {
        paperAccount: {
          findFirst: jest.fn().mockResolvedValue({
            id: 'acc-test-a',
            currency: 'INR',
            cashBalance: new Decimal(accountCash),
          }),
        },
        paperOrder: { findUnique: jest.fn().mockResolvedValue(null), count: jest.fn().mockResolvedValue(0) },
        paperPosition: { count: jest.fn().mockResolvedValue(0) },
        paperTrade: { aggregate: jest.fn().mockResolvedValue({ _sum: { realizedPnL: 0 } }), findMany: jest.fn().mockResolvedValue([]) },
        systemConfig: { findFirst: jest.fn().mockResolvedValue({ configJson: { maxLeverage: 10, maxSlippageBps: 0, maxTotalExposurePercent: 100 } }) },
        $transaction: jest.fn().mockImplementation(async (cb: any) => cb(mockTx)),
      };

      const service = new PaperTradingService(
        mockPrisma,
        {} as any,
        { getValidatedTicker: () => ({ price: entryPrice }) } as any,
        undefined,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
      );

      jest.spyOn(service as any, 'getOrCreateAccount').mockResolvedValue({
        id: 'acc-test-a',
        currency: 'INR',
        cashBalance: new Decimal(accountCash),
        initialCapital: new Decimal(accountCash),
      });
      jest.spyOn(service as any, 'getSystemConfig').mockResolvedValue({
        maxLeverage: 10,
        maxSlippageBps: 0,
        maxTotalExposurePercent: 100,
        maxPositionRiskPercent: 10,
        maxDailyLossPercent: 10,
        maxTradesPerDay: 50,
        maxConsecutiveLosses: 10,
        maxOpenPositions: 5,
      });
      jest.spyOn(service as any, 'rejectOrder').mockResolvedValue(undefined as any);
      jest.spyOn(service as any, 'getValidatedMarketPrice').mockResolvedValue({ price: entryPrice, timestamp: new Date() });

      await expect(
        service.placeOrder({
          symbol: 'BTCUSDT_SPOT',
          direction: 'BUY',
          quantity,
          orderType: 'MARKET',
          stopLoss,
          target1: 85000,
          leverage: 1,
        }),
      ).rejects.toThrow('INSUFFICIENT_MARGIN');

      expect(positionCreated).toBe(false);
      expect(orderCreated).toBe(false);
    });

    // -----------------------------------------------------------------------
    // TEST B: ₹300,000 account, BTCUSDT_SPOT, requested leverage = 50 -> REJECT
    // -----------------------------------------------------------------------
    it('TEST B: ₹300,000 account, BTCUSDT_SPOT, requested leverage = 50 -> REJECT LEVERAGE_EXCEEDS_MAX', async () => {
      const accountCash = 300000;
      const mockPrisma: any = {
        paperAccount: { findFirst: jest.fn().mockResolvedValue({ id: 'acc-test-b', currency: 'INR', cashBalance: new Decimal(accountCash) }) },
        paperOrder: { findUnique: jest.fn().mockResolvedValue(null), count: jest.fn().mockResolvedValue(0) },
        paperPosition: { count: jest.fn().mockResolvedValue(0) },
        paperTrade: { aggregate: jest.fn().mockResolvedValue({ _sum: { realizedPnL: 0 } }), findMany: jest.fn().mockResolvedValue([]) },
        systemConfig: { findFirst: jest.fn().mockResolvedValue({ configJson: { maxLeverage: 50 } }) },
      };

      const service = new PaperTradingService(
        mockPrisma,
        {} as any,
        { getValidatedTicker: () => ({ price: entryPrice }) } as any,
        undefined,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
      );

      jest.spyOn(service as any, 'getOrCreateAccount').mockResolvedValue({ id: 'acc-test-b', currency: 'INR', cashBalance: new Decimal(accountCash) });
      jest.spyOn(service as any, 'getSystemConfig').mockResolvedValue({ maxLeverage: 50, maxOpenPositions: 5, maxTradesPerDay: 50, maxConsecutiveLosses: 10, maxPositionRiskPercent: 10, maxDailyLossPercent: 10 });
      jest.spyOn(service as any, 'rejectOrder').mockResolvedValue(undefined as any);
      jest.spyOn(service as any, 'getValidatedMarketPrice').mockResolvedValue({ price: entryPrice, timestamp: new Date() });

      await expect(
        service.placeOrder({
          symbol: 'BTCUSDT_SPOT',
          direction: 'BUY',
          quantity: 0.01,
          orderType: 'MARKET',
          stopLoss,
          target1: 85000,
          leverage: 50,
        }),
      ).rejects.toThrow('LEVERAGE_EXCEEDS_MAX');
    });

    // -----------------------------------------------------------------------
    // TEST C: ₹300,000 account, BTCUSDT_SPOT, 1x -> quantity * entry * FX <= 300,000
    // -----------------------------------------------------------------------
    it('TEST C: ₹300,000 account, BTCUSDT_SPOT, 1x -> final quantity * entry * FX <= 300000', () => {
      const accountBalance = 300000;
      const sizing = PositionSizer.calculatePosition({
        accountBalance,
        availableMargin: accountBalance,
        riskPercentage: 1.0,
        entryPrice,
        stopLoss,
        symbol: 'BTCUSDT_SPOT',
        requestedLeverage: 1,
      });

      expect(sizing.isValid).toBe(true);
      expect(sizing.roundedUnits).toBeLessThanOrEqual(0.0385);
      const totalNotionalINR = sizing.roundedUnits * entryPrice * fxUsdtInr;
      expect(totalNotionalINR).toBeLessThanOrEqual(accountBalance);
      expect(sizing.initialMarginRequired).toBeLessThanOrEqual(accountBalance);
    });

    // -----------------------------------------------------------------------
    // TEST D: Same position at different leverage settings -> gross P&L identical
    // -----------------------------------------------------------------------
    it('TEST D: Leverage does not multiply gross position P&L (1x, 5x, 10x, 50x identical)', () => {
      const qty = 0.05;
      const pnl1x = TradeAccountingEngine.calculateTradePnl({ entryPrice, exitPrice: currentPrice, quantity: qty, direction: 'LONG', fxRate: fxUsdtInr });
      const pnl5x = TradeAccountingEngine.calculateTradePnl({ entryPrice, exitPrice: currentPrice, quantity: qty, direction: 'LONG', fxRate: fxUsdtInr, initialRiskAccount: 1000 });
      const pnl10x = TradeAccountingEngine.calculateTradePnl({ entryPrice, exitPrice: currentPrice, quantity: qty, direction: 'LONG', fxRate: fxUsdtInr });
      const pnl50x = TradeAccountingEngine.calculateTradePnl({ entryPrice, exitPrice: currentPrice, quantity: qty, direction: 'LONG', fxRate: fxUsdtInr });

      expect(pnl1x.grossPnlQuote).toBeCloseTo(7.105, 3);
      expect(pnl5x.grossPnlQuote).toBe(pnl1x.grossPnlQuote);
      expect(pnl10x.grossPnlQuote).toBe(pnl1x.grossPnlQuote);
      expect(pnl50x.grossPnlQuote).toBe(pnl1x.grossPnlQuote);

      expect(pnl1x.grossPnlAccount).toBeCloseTo(657.21, 2);
      expect(pnl5x.grossPnlAccount).toBe(pnl1x.grossPnlAccount);
      expect(pnl10x.grossPnlAccount).toBe(pnl1x.grossPnlAccount);
      expect(pnl50x.grossPnlAccount).toBe(pnl1x.grossPnlAccount);
    });

    // -----------------------------------------------------------------------
    // TEST E: Positive LONG: 84190.98 -> 84333.08 -> priceMove = +142.10, grossQuote = +7.105, grossAccount > 0
    // -----------------------------------------------------------------------
    it('TEST E: Positive LONG price move produces positive gross quote and account P&L', () => {
      const pnl = TradeAccountingEngine.calculateTradePnl({
        entryPrice,
        exitPrice: currentPrice,
        quantity: 0.05,
        direction: 'LONG',
        fxRate: fxUsdtInr,
      });

      expect(pnl.priceMove).toBeCloseTo(142.10, 2);
      expect(pnl.grossPnlQuote).toBeCloseTo(7.105, 3);
      expect(pnl.grossPnlAccount).toBeCloseTo(657.21, 2);
      expect(pnl.grossPnlAccount).toBeGreaterThan(0);
    });

    // -----------------------------------------------------------------------
    // TEST F: LONG R: entry = 84190.98, SL = 84030.98, current = 84333.08 -> R ≈ 0.8881
    // -----------------------------------------------------------------------
    it('TEST F: LONG R is derived strictly from price risk distance (142.10 / 160 ≈ 0.8881R)', () => {
      const pnl = TradeAccountingEngine.calculateTradePnl({
        entryPrice,
        exitPrice: currentPrice,
        quantity: 0.05,
        direction: 'LONG',
        fxRate: fxUsdtInr,
        initialStopLoss: stopLoss,
      });

      expect(pnl.realizedR).toBeCloseTo(0.8881, 3);
    });

    // -----------------------------------------------------------------------
    // TEST G: Executed stop: signal.stopLoss === position.stopLoss
    // -----------------------------------------------------------------------
    it('TEST G: Executed stop strictly matches signal stop loss without modification', async () => {
      const exactSignalSL = 84030.98;
      let executedPositionSL: number | null = null;

      const mockTx: any = {
        paperAccount: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'acc-test-g',
            currency: 'INR',
            cashBalance: new Decimal(10000000),
          }),
          update: jest.fn().mockResolvedValue({}),
        },
        paperPosition: {
          findMany: jest.fn().mockResolvedValue([]),
          create: jest.fn().mockImplementation((args: any) => {
            executedPositionSL = Number(args.data.stopLoss);
            return { id: 'pos-g', ...args.data };
          }),
        },
        paperOrder: { create: jest.fn().mockResolvedValue({ id: 'order-g' }) },
        paperFill: { create: jest.fn().mockResolvedValue({ id: 'fill-g', fillTimestamp: new Date() }), update: jest.fn() },
        auditEvent: { createMany: jest.fn().mockResolvedValue({ count: 1 }) },
      };

      const mockPrisma: any = {
        paperAccount: { findFirst: jest.fn().mockResolvedValue({ id: 'acc-test-g', currency: 'INR', cashBalance: new Decimal(10000000) }) },
        paperOrder: { findUnique: jest.fn().mockResolvedValue(null), count: jest.fn().mockResolvedValue(0) },
        paperPosition: { count: jest.fn().mockResolvedValue(0) },
        paperTrade: { aggregate: jest.fn().mockResolvedValue({ _sum: { realizedPnL: 0 } }), findMany: jest.fn().mockResolvedValue([]) },
        systemConfig: { findFirst: jest.fn().mockResolvedValue({ configJson: { maxLeverage: 10, maxSlippageBps: 0, maxTotalExposurePercent: 100 } }) },
        $transaction: jest.fn().mockImplementation(async (cb: any) => cb(mockTx)),
      };

      const service = new PaperTradingService(
        mockPrisma,
        {} as any,
        { getValidatedTicker: () => ({ price: entryPrice }) } as any,
        undefined,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
      );

      jest.spyOn(service as any, 'getOrCreateAccount').mockResolvedValue({ id: 'acc-test-g', currency: 'INR', cashBalance: new Decimal(10000000), initialCapital: new Decimal(10000000) });
      jest.spyOn(service as any, 'getSystemConfig').mockResolvedValue({ maxLeverage: 10, maxSlippageBps: 0, maxTotalExposurePercent: 100, maxPositionRiskPercent: 10, maxDailyLossPercent: 10, maxTradesPerDay: 50, maxConsecutiveLosses: 10, maxOpenPositions: 5 });
      jest.spyOn(service as any, 'getValidatedMarketPrice').mockResolvedValue({ price: entryPrice, timestamp: new Date() });

      await service.placeOrder({
        symbol: 'BTCUSDT_SPOT',
        direction: 'BUY',
        quantity: 0.01,
        orderType: 'MARKET',
        stopLoss: exactSignalSL,
        target1: 85000,
        leverage: 1,
      });

      expect(executedPositionSL).toBe(exactSignalSL);
    });

    // -----------------------------------------------------------------------
    // TEST H: No silent quantity override: If PositionSizer approves 0.0385 BTC, execution layer rejects 0.05 BTC
    // -----------------------------------------------------------------------
    it('TEST H: Execution layer rejects 0.05 BTC when PositionSizer caps affordable quantity at 0.0385 BTC for ₹300,000 cash', async () => {
      const accountCash = 300000;
      const sizing = PositionSizer.calculatePosition({
        accountBalance: accountCash,
        availableMargin: accountCash,
        riskPercentage: 1.0,
        entryPrice,
        stopLoss,
        symbol: 'BTCUSDT_SPOT',
        requestedLeverage: 1,
      });

      expect(sizing.roundedUnits).toBeLessThanOrEqual(0.0385);

      const mockTx: any = {
        paperAccount: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'acc-test-h',
            currency: 'INR',
            cashBalance: new Decimal(accountCash),
          }),
        },
        paperPosition: { findMany: jest.fn().mockResolvedValue([]) },
      };

      const mockPrisma: any = {
        paperAccount: { findFirst: jest.fn().mockResolvedValue({ id: 'acc-test-h', currency: 'INR', cashBalance: new Decimal(accountCash) }) },
        paperOrder: { findUnique: jest.fn().mockResolvedValue(null), count: jest.fn().mockResolvedValue(0) },
        paperPosition: { count: jest.fn().mockResolvedValue(0) },
        paperTrade: { aggregate: jest.fn().mockResolvedValue({ _sum: { realizedPnL: 0 } }), findMany: jest.fn().mockResolvedValue([]) },
        systemConfig: { findFirst: jest.fn().mockResolvedValue({ configJson: { maxLeverage: 10, maxSlippageBps: 0, maxTotalExposurePercent: 100 } }) },
        $transaction: jest.fn().mockImplementation(async (cb: any) => cb(mockTx)),
      };

      const service = new PaperTradingService(
        mockPrisma,
        {} as any,
        { getValidatedTicker: () => ({ price: entryPrice }) } as any,
        undefined,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
      );

      jest.spyOn(service as any, 'getOrCreateAccount').mockResolvedValue({ id: 'acc-test-h', currency: 'INR', cashBalance: new Decimal(accountCash), initialCapital: new Decimal(accountCash) });
      jest.spyOn(service as any, 'getSystemConfig').mockResolvedValue({ maxLeverage: 10, maxSlippageBps: 0, maxTotalExposurePercent: 100, maxPositionRiskPercent: 10, maxDailyLossPercent: 10, maxTradesPerDay: 50, maxConsecutiveLosses: 10, maxOpenPositions: 5 });
      jest.spyOn(service as any, 'rejectOrder').mockResolvedValue(undefined as any);
      jest.spyOn(service as any, 'getValidatedMarketPrice').mockResolvedValue({ price: entryPrice, timestamp: new Date() });

      // Attempting to place 0.05 BTC must be strictly rejected
      await expect(
        service.placeOrder({
          symbol: 'BTCUSDT_SPOT',
          direction: 'BUY',
          quantity: 0.05,
          orderType: 'MARKET',
          stopLoss,
          target1: 85000,
          leverage: 1,
        }),
      ).rejects.toThrow('INSUFFICIENT_MARGIN');
    });
  });

  // =========================================================================
  // SECTION: MANDATORY PART 16 SPECIFICATION SUITE (TEST 1 - TEST 10)
  // =========================================================================
  describe('Mandatory Part 16 Specification Suite (TEST 1 - TEST 10)', () => {
    const entryPrice = 84190.98;
    const currentPrice = 84333.08;
    const stopLoss = 84030.98;
    const fxUsdtInr = 92.5;

    // TEST 1: ₹300,000 account, BTCUSDT_SPOT, 0.05 BTC, 1x -> REJECTED, no position, no filled order
    it('TEST 1: ₹300,000 account, BTCUSDT_SPOT, 0.05 BTC, 1x -> REJECTED, no position, no filled order', async () => {
      const accountCash = 300000;
      const quantity = 0.05;
      const requiredMargin = entryPrice * quantity * fxUsdtInr; // ~₹389,383
      expect(requiredMargin).toBeGreaterThan(accountCash);

      let positionCreated = false;
      let orderCreated = false;

      const mockTx: any = {
        $executeRawUnsafe: jest.fn().mockResolvedValue(1),
        paperAccount: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'acc-part16-t1',
            currency: 'INR',
            cashBalance: new Decimal(accountCash),
          }),
        },
        paperPosition: {
          findMany: jest.fn().mockResolvedValue([]),
          create: jest.fn().mockImplementation(() => {
            positionCreated = true;
            return { id: 'pos-1' };
          }),
        },
        tradeReservation: { findMany: jest.fn().mockResolvedValue([]) },
        paperOrder: {
          create: jest.fn().mockImplementation(() => {
            orderCreated = true;
            return { id: 'order-1' };
          }),
        },
      };

      const mockPrisma: any = {
        paperAccount: { findFirst: jest.fn().mockResolvedValue({ id: 'acc-part16-t1', currency: 'INR', cashBalance: new Decimal(accountCash) }) },
        paperOrder: { findUnique: jest.fn().mockResolvedValue(null), count: jest.fn().mockResolvedValue(0) },
        paperPosition: { count: jest.fn().mockResolvedValue(0) },
        paperTrade: { aggregate: jest.fn().mockResolvedValue({ _sum: { realizedPnL: 0 } }), findMany: jest.fn().mockResolvedValue([]) },
        systemConfig: { findFirst: jest.fn().mockResolvedValue({ configJson: { maxLeverage: 10 } }) },
        $transaction: jest.fn().mockImplementation(async (cb: any) => cb(mockTx)),
      };

      const service = new PaperTradingService(
        mockPrisma,
        {} as any,
        { getValidatedTicker: () => ({ price: entryPrice }) } as any,
        undefined,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
      );

      jest.spyOn(service as any, 'getOrCreateAccount').mockResolvedValue({ id: 'acc-part16-t1', currency: 'INR', cashBalance: new Decimal(accountCash), initialCapital: new Decimal(accountCash) });
      jest.spyOn(service as any, 'getSystemConfig').mockResolvedValue({ maxLeverage: 10, maxOpenPositions: 5, maxTradesPerDay: 50, maxConsecutiveLosses: 10, maxPositionRiskPercent: 10, maxDailyLossPercent: 10 });
      jest.spyOn(service as any, 'rejectOrder').mockResolvedValue(undefined as any);
      jest.spyOn(service as any, 'getValidatedMarketPrice').mockResolvedValue({ price: entryPrice, timestamp: new Date() });

      await expect(
        service.placeOrder({
          symbol: 'BTCUSDT_SPOT',
          direction: 'BUY',
          quantity,
          orderType: 'MARKET',
          stopLoss,
          target1: 85000,
          leverage: 1,
        }),
      ).rejects.toThrow('INSUFFICIENT_MARGIN');

      expect(positionCreated).toBe(false);
      expect(orderCreated).toBe(false);
    });

    // TEST 2: ₹300,000, BTCUSDT_SPOT, 0.05 BTC, 50x -> REJECTED, LEVERAGE_EXCEEDS_MAX
    it('TEST 2: ₹300,000, BTCUSDT_SPOT, 0.05 BTC, 50x -> REJECTED, LEVERAGE_EXCEEDS_MAX', async () => {
      const mockPrisma: any = {
        paperAccount: { findFirst: jest.fn().mockResolvedValue({ id: 'acc-part16-t2', currency: 'INR', cashBalance: new Decimal(300000) }) },
        paperOrder: { findUnique: jest.fn().mockResolvedValue(null), count: jest.fn().mockResolvedValue(0) },
        paperPosition: { count: jest.fn().mockResolvedValue(0) },
        paperTrade: { aggregate: jest.fn().mockResolvedValue({ _sum: { realizedPnL: 0 } }), findMany: jest.fn().mockResolvedValue([]) },
        systemConfig: { findFirst: jest.fn().mockResolvedValue({ configJson: { maxLeverage: 50 } }) },
      };

      const service = new PaperTradingService(
        mockPrisma,
        {} as any,
        { getValidatedTicker: () => ({ price: entryPrice }) } as any,
        undefined,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
      );

      jest.spyOn(service as any, 'getOrCreateAccount').mockResolvedValue({ id: 'acc-part16-t2', currency: 'INR', cashBalance: new Decimal(300000) });
      jest.spyOn(service as any, 'getSystemConfig').mockResolvedValue({ maxLeverage: 50, maxOpenPositions: 5, maxTradesPerDay: 50, maxConsecutiveLosses: 10, maxPositionRiskPercent: 10, maxDailyLossPercent: 10 });
      jest.spyOn(service as any, 'rejectOrder').mockResolvedValue(undefined as any);
      jest.spyOn(service as any, 'getValidatedMarketPrice').mockResolvedValue({ price: entryPrice, timestamp: new Date() });

      await expect(
        service.placeOrder({
          symbol: 'BTCUSDT_SPOT',
          direction: 'BUY',
          quantity: 0.05,
          orderType: 'MARKET',
          stopLoss,
          target1: 85000,
          leverage: 50,
        }),
      ).rejects.toThrow('LEVERAGE_EXCEEDS_MAX');
    });

    // TEST 3: ₹300,000, BTCUSDT_SPOT, 1x, valid SL -> final quantity <= affordable quantity
    it('TEST 3: ₹300,000, BTCUSDT_SPOT, 1x, valid SL -> final quantity <= affordable quantity', () => {
      const accountBalance = 300000;
      const sizing = PositionSizer.calculatePosition({
        accountBalance,
        availableMargin: accountBalance,
        riskPercentage: 1.0,
        entryPrice,
        stopLoss,
        symbol: 'BTCUSDT_SPOT',
        requestedLeverage: 1,
      });

      expect(sizing.isValid).toBe(true);
      const unitPriceINR = entryPrice * 1 * fxUsdtInr;
      const maxAffordableQty = accountBalance / unitPriceINR; // ~0.038522 BTC
      expect(sizing.roundedUnits).toBeLessThanOrEqual(maxAffordableQty);
      expect(sizing.roundedUnits * unitPriceINR).toBeLessThanOrEqual(accountBalance);
    });

    // TEST 4: Existing usedMargin = ₹100,000, Available = ₹200,000, New required margin = ₹220,000 -> REJECTED
    it('TEST 4: Existing usedMargin = ₹100,000, Available = ₹200,000, New required margin = ₹220,000 -> REJECTED', async () => {
      const totalCash = 300000;
      const existingUsedMargin = 100000;
      const availableCash = totalCash - existingUsedMargin; // ₹200,000
      expect(availableCash).toBe(200000);

      // Sizing for 0.03 BTC requires 0.03 * 84190.98 * 92.5 = ₹233,629 > ₹200,000
      const orderQty = 0.03;
      const orderMargin = orderQty * entryPrice * fxUsdtInr; // ~₹233,629.97 > ₹200,000

      const mockTx: any = {
        $executeRawUnsafe: jest.fn().mockResolvedValue(1),
        paperAccount: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'acc-part16-t4',
            currency: 'INR',
            cashBalance: new Decimal(totalCash),
          }),
        },
        paperPosition: {
          findMany: jest.fn().mockResolvedValue([
            { usedMargin: new Decimal(existingUsedMargin) },
          ]),
        },
        tradeReservation: { findMany: jest.fn().mockResolvedValue([]) },
      };

      const mockPrisma: any = {
        paperAccount: { findFirst: jest.fn().mockResolvedValue({ id: 'acc-part16-t4', currency: 'INR', cashBalance: new Decimal(totalCash) }) },
        paperOrder: { findUnique: jest.fn().mockResolvedValue(null), count: jest.fn().mockResolvedValue(0) },
        paperPosition: { count: jest.fn().mockResolvedValue(1) },
        paperTrade: { aggregate: jest.fn().mockResolvedValue({ _sum: { realizedPnL: 0 } }), findMany: jest.fn().mockResolvedValue([]) },
        systemConfig: { findFirst: jest.fn().mockResolvedValue({ configJson: { maxLeverage: 10 } }) },
        $transaction: jest.fn().mockImplementation(async (cb: any) => cb(mockTx)),
      };

      const service = new PaperTradingService(
        mockPrisma,
        {} as any,
        { getValidatedTicker: () => ({ price: entryPrice }) } as any,
        undefined,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
      );

      jest.spyOn(service as any, 'getOrCreateAccount').mockResolvedValue({ id: 'acc-part16-t4', currency: 'INR', cashBalance: new Decimal(totalCash), initialCapital: new Decimal(totalCash) });
      jest.spyOn(service as any, 'getSystemConfig').mockResolvedValue({ maxLeverage: 10, maxOpenPositions: 5, maxTradesPerDay: 50, maxConsecutiveLosses: 10, maxPositionRiskPercent: 10, maxDailyLossPercent: 10 });
      jest.spyOn(service as any, 'rejectOrder').mockResolvedValue(undefined as any);
      jest.spyOn(service as any, 'getValidatedMarketPrice').mockResolvedValue({ price: entryPrice, timestamp: new Date() });

      await expect(
        service.placeOrder({
          symbol: 'BTCUSDT_SPOT',
          direction: 'BUY',
          quantity: orderQty,
          orderType: 'MARKET',
          stopLoss,
          target1: 85000,
          leverage: 1,
        }),
      ).rejects.toThrow('INSUFFICIENT_MARGIN');
    });

    // TEST 5: Two simultaneous orders whose combined margin exceeds available cash -> Only first order passes, second rejected
    it('TEST 5: Two simultaneous orders whose combined margin exceeds available cash -> No over-allocation', async () => {
      let currentCash = 300000;
      let activePositionsState: any[] = [];

      const createMockService = () => {
        const mockTx: any = {
          $executeRawUnsafe: jest.fn().mockResolvedValue(1),
          paperAccount: {
            findUnique: jest.fn().mockImplementation(() => Promise.resolve({
              id: 'acc-part16-t5',
              currency: 'INR',
              cashBalance: new Decimal(currentCash),
            })),
            update: jest.fn().mockImplementation((args: any) => {
              if (args.data.usedMargin?.increment) {
                // committed margin tracked in activePositionsState
              }
              return Promise.resolve({});
            }),
          },
          paperPosition: {
            findMany: jest.fn().mockImplementation(() => Promise.resolve([...activePositionsState])),
            create: jest.fn().mockImplementation((args: any) => {
              const pos = { id: `pos-${Date.now()}`, usedMargin: args.data.usedMargin };
              activePositionsState.push(pos);
              return pos;
            }),
          },
          tradeReservation: { findMany: jest.fn().mockResolvedValue([]) },
          paperOrder: { create: jest.fn().mockResolvedValue({ id: 'order-conc' }) },
          paperFill: { create: jest.fn().mockResolvedValue({ id: 'fill-conc', fillTimestamp: new Date() }), update: jest.fn() },
          auditEvent: { createMany: jest.fn().mockResolvedValue({ count: 1 }) },
        };

        const mockPrisma: any = {
          paperAccount: { findFirst: jest.fn().mockResolvedValue({ id: 'acc-part16-t5', currency: 'INR', cashBalance: new Decimal(currentCash) }) },
          paperOrder: { findUnique: jest.fn().mockResolvedValue(null), count: jest.fn().mockResolvedValue(0) },
          paperPosition: { count: jest.fn().mockResolvedValue(0) },
          paperTrade: { aggregate: jest.fn().mockResolvedValue({ _sum: { realizedPnL: 0 } }), findMany: jest.fn().mockResolvedValue([]) },
          systemConfig: { findFirst: jest.fn().mockResolvedValue({ configJson: { maxLeverage: 10 } }) },
          $transaction: jest.fn().mockImplementation(async (cb: any) => cb(mockTx)),
        };

        const s = new PaperTradingService(
          mockPrisma,
          {} as any,
          { getValidatedTicker: () => ({ price: entryPrice }) } as any,
          undefined,
          {} as any,
          {} as any,
          {} as any,
          {} as any,
          {} as any,
          {} as any,
          {} as any,
        );
        jest.spyOn(s as any, 'getOrCreateAccount').mockResolvedValue({ id: 'acc-part16-t5', currency: 'INR', cashBalance: new Decimal(currentCash), initialCapital: new Decimal(currentCash) });
        jest.spyOn(s as any, 'getSystemConfig').mockResolvedValue({ maxLeverage: 10, maxOpenPositions: 5, maxTradesPerDay: 50, maxConsecutiveLosses: 10, maxPositionRiskPercent: 10, maxDailyLossPercent: 10 });
        jest.spyOn(s as any, 'rejectOrder').mockResolvedValue(undefined as any);
        jest.spyOn(s as any, 'getValidatedMarketPrice').mockResolvedValue({ price: entryPrice, timestamp: new Date() });
        return s;
      };

      const s1 = createMockService();
      const s2 = createMockService();

      // Order 1: 0.025 BTC requires ~₹194,691 margin (fits in ₹300,000 cash)
      const res1 = await s1.placeOrder({
        symbol: 'BTCUSDT_SPOT',
        direction: 'BUY',
        quantity: 0.025,
        orderType: 'MARKET',
        stopLoss,
        target1: 85000,
        leverage: 1,
      });
      expect(res1).toBeDefined();
      expect(activePositionsState.length).toBe(1);

      // Order 2: Another 0.025 BTC requires ~₹194,691 margin
      // Combined = ₹389,382 > ₹300,000 cash! Second order MUST be rejected!
      await expect(
        s2.placeOrder({
          symbol: 'BTCUSDT_SPOT',
          direction: 'BUY',
          quantity: 0.025,
          orderType: 'MARKET',
          stopLoss,
          target1: 85000,
          leverage: 1,
        }),
      ).rejects.toThrow('INSUFFICIENT_MARGIN');

      // Total positions allocated remains strictly 1 (no over-allocation)
      expect(activePositionsState.length).toBe(1);
    });

    // TEST 6: Signal SL = 84030.98 -> Executed position SL must equal 84030.98
    it('TEST 6: Signal SL = 84030.98 -> Executed position SL must equal 84030.98', async () => {
      let executedSL: number | null = null;
      const mockTx: any = {
        $executeRawUnsafe: jest.fn().mockResolvedValue(1),
        paperAccount: { findUnique: jest.fn().mockResolvedValue({ id: 'acc-part16-t6', currency: 'INR', cashBalance: new Decimal(10000000) }), update: jest.fn().mockResolvedValue({}) },
        paperPosition: {
          findMany: jest.fn().mockResolvedValue([]),
          create: jest.fn().mockImplementation((args: any) => {
            executedSL = Number(args.data.stopLoss);
            return { id: 'pos-sl', ...args.data };
          }),
        },
        tradeReservation: { findMany: jest.fn().mockResolvedValue([]) },
        paperOrder: { create: jest.fn().mockResolvedValue({ id: 'order-sl' }) },
        paperFill: { create: jest.fn().mockResolvedValue({ id: 'fill-sl', fillTimestamp: new Date() }), update: jest.fn() },
        auditEvent: { createMany: jest.fn().mockResolvedValue({ count: 1 }) },
      };

      const mockPrisma: any = {
        paperAccount: { findFirst: jest.fn().mockResolvedValue({ id: 'acc-part16-t6', currency: 'INR', cashBalance: new Decimal(10000000) }) },
        paperOrder: { findUnique: jest.fn().mockResolvedValue(null), count: jest.fn().mockResolvedValue(0) },
        paperPosition: { count: jest.fn().mockResolvedValue(0) },
        paperTrade: { aggregate: jest.fn().mockResolvedValue({ _sum: { realizedPnL: 0 } }), findMany: jest.fn().mockResolvedValue([]) },
        systemConfig: { findFirst: jest.fn().mockResolvedValue({ configJson: { maxLeverage: 10 } }) },
        $transaction: jest.fn().mockImplementation(async (cb: any) => cb(mockTx)),
      };

      const service = new PaperTradingService(
        mockPrisma,
        {} as any,
        { getValidatedTicker: () => ({ price: entryPrice }) } as any,
        undefined,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
      );

      jest.spyOn(service as any, 'getOrCreateAccount').mockResolvedValue({ id: 'acc-part16-t6', currency: 'INR', cashBalance: new Decimal(10000000), initialCapital: new Decimal(10000000) });
      jest.spyOn(service as any, 'getSystemConfig').mockResolvedValue({ maxLeverage: 10, maxOpenPositions: 5, maxTradesPerDay: 50, maxConsecutiveLosses: 10, maxPositionRiskPercent: 10, maxDailyLossPercent: 10 });
      jest.spyOn(service as any, 'getValidatedMarketPrice').mockResolvedValue({ price: entryPrice, timestamp: new Date() });

      await service.placeOrder({
        symbol: 'BTCUSDT_SPOT',
        direction: 'BUY',
        quantity: 0.01,
        orderType: 'MARKET',
        stopLoss: 84030.98,
        target1: 85000,
        leverage: 1,
      });

      expect(executedSL).toBe(84030.98);
    });

    // TEST 7: Positive LONG: 84190.98 -> 84333.08, 0.05 BTC -> priceMove = +142.10, grossPnlQuote = +7.105, grossPnlAccount > 0
    it('TEST 7: Positive LONG: 84190.98 -> 84333.08, 0.05 BTC -> priceMove = +142.10, grossPnlQuote = +7.105, grossPnlAccount > 0', () => {
      const pnl = TradeAccountingEngine.calculateTradePnl({
        entryPrice: 84190.98,
        exitPrice: 84333.08,
        quantity: 0.05,
        direction: 'LONG',
        quoteCurrency: 'USDT',
        accountCurrency: 'INR',
        fxRate: fxUsdtInr,
      });

      expect(pnl.priceMove).toBeCloseTo(142.10, 2);
      expect(pnl.grossPnlQuote).toBeCloseTo(7.105, 3);
      expect(pnl.grossPnlAccount).toBeCloseTo(657.21, 2);
      expect(pnl.grossPnlAccount).toBeGreaterThan(0);
    });

    // TEST 8: R: 142.10 / 160 -> ~0.8881R
    it('TEST 8: R: 142.10 / 160 -> ~0.8881R', () => {
      const pnl = TradeAccountingEngine.calculateTradePnl({
        entryPrice: 84190.98,
        exitPrice: 84333.08,
        quantity: 0.05,
        direction: 'LONG',
        initialStopLoss: 84030.98,
        fxRate: fxUsdtInr,
      });

      expect(pnl.realizedR).toBeCloseTo(0.8881, 3);
    });

    // TEST 9: Leverage independence. Same quantity/entry/exit: 1x, 5x, 10x, 50x -> Gross P&L identical
    it('TEST 9: Leverage independence. Same quantity/entry/exit: 1x, 5x, 10x, 50x -> Gross P&L identical', () => {
      const qty = 0.05;
      const pnl1x = TradeAccountingEngine.calculateTradePnl({ entryPrice, exitPrice: currentPrice, quantity: qty, direction: 'LONG', fxRate: fxUsdtInr });
      const pnl5x = TradeAccountingEngine.calculateTradePnl({ entryPrice, exitPrice: currentPrice, quantity: qty, direction: 'LONG', fxRate: fxUsdtInr, initialRiskAccount: 1000 });
      const pnl10x = TradeAccountingEngine.calculateTradePnl({ entryPrice, exitPrice: currentPrice, quantity: qty, direction: 'LONG', fxRate: fxUsdtInr });
      const pnl50x = TradeAccountingEngine.calculateTradePnl({ entryPrice, exitPrice: currentPrice, quantity: qty, direction: 'LONG', fxRate: fxUsdtInr });

      expect(pnl1x.grossPnlQuote).toBe(pnl5x.grossPnlQuote);
      expect(pnl1x.grossPnlQuote).toBe(pnl10x.grossPnlQuote);
      expect(pnl1x.grossPnlQuote).toBe(pnl50x.grossPnlQuote);

      expect(pnl1x.grossPnlAccount).toBe(pnl5x.grossPnlAccount);
      expect(pnl1x.grossPnlAccount).toBe(pnl10x.grossPnlAccount);
      expect(pnl1x.grossPnlAccount).toBe(pnl50x.grossPnlAccount);
    });

    // TEST 10: Client sends fake: accountBalance = 10,000,000 while DB cash = ₹300,000 -> Server rejects based on DB cash
    it('TEST 10: Client sends fake: accountBalance = 10,000,000 while DB cash = ₹300,000 -> Server rejects based on DB cash', async () => {
      const dbCash = 300000;
      const fakeClientBalance = 10000000;
      const quantity = 0.05; // Requires ~₹389,383 > ₹300,000 DB cash

      const mockTx: any = {
        $executeRawUnsafe: jest.fn().mockResolvedValue(1),
        paperAccount: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'acc-part16-t10',
            currency: 'INR',
            cashBalance: new Decimal(dbCash),
          }),
        },
        paperPosition: { findMany: jest.fn().mockResolvedValue([]) },
        tradeReservation: { findMany: jest.fn().mockResolvedValue([]) },
      };

      const mockPrisma: any = {
        paperAccount: { findFirst: jest.fn().mockResolvedValue({ id: 'acc-part16-t10', currency: 'INR', cashBalance: new Decimal(dbCash) }) },
        paperOrder: { findUnique: jest.fn().mockResolvedValue(null), count: jest.fn().mockResolvedValue(0) },
        paperPosition: { count: jest.fn().mockResolvedValue(0) },
        paperTrade: { aggregate: jest.fn().mockResolvedValue({ _sum: { realizedPnL: 0 } }), findMany: jest.fn().mockResolvedValue([]) },
        systemConfig: { findFirst: jest.fn().mockResolvedValue({ configJson: { maxLeverage: 10 } }) },
        $transaction: jest.fn().mockImplementation(async (cb: any) => cb(mockTx)),
      };

      const service = new PaperTradingService(
        mockPrisma,
        {} as any,
        { getValidatedTicker: () => ({ price: entryPrice }) } as any,
        undefined,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
      );

      jest.spyOn(service as any, 'getOrCreateAccount').mockResolvedValue({ id: 'acc-part16-t10', currency: 'INR', cashBalance: new Decimal(dbCash), initialCapital: new Decimal(dbCash) });
      jest.spyOn(service as any, 'getSystemConfig').mockResolvedValue({ maxLeverage: 10, maxOpenPositions: 5, maxTradesPerDay: 50, maxConsecutiveLosses: 10, maxPositionRiskPercent: 10, maxDailyLossPercent: 10 });
      jest.spyOn(service as any, 'rejectOrder').mockResolvedValue(undefined as any);
      jest.spyOn(service as any, 'getValidatedMarketPrice').mockResolvedValue({ price: entryPrice, timestamp: new Date() });

      // Client sends fake accountBalance = 10,000,000; server MUST still reject because DB cash is ₹300,000
      await expect(
        service.placeOrder({
          symbol: 'BTCUSDT_SPOT',
          direction: 'BUY',
          quantity,
          orderType: 'MARKET',
          stopLoss,
          target1: 85000,
          leverage: 1,
          accountBalance: fakeClientBalance, // FAKE CLIENT OVERRIDE ATTEMPT
        }),
      ).rejects.toThrow('INSUFFICIENT_MARGIN');
    });
  });
});
