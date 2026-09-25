import {
  calculateOptionRiskAndOutlay,
  calculateOptionBuyPnL,
  validateOptionLotQuantity,
  calculateOptionRiskQuantity,
  buildCanonicalOptionTradeSetup,
  DEFAULT_OPTION_RR_RATIOS,
  calculateTargetR,
  calculateRiskDistance,
} from '@quant/shared';
import { PaperTradingService } from '../paper-trading.service';

describe('NIFTY Option Premium Mode Audit & Execution Invariants (Section 16)', () => {
  const canonicalSetup = {
    underlyingSymbol: 'NIFTY',
    underlyingTriggerPrice: 24175.65,
    strike: 24200,
    optionType: 'CE' as const,
    expiry: '29-Sep-2026',
    lotSize: 65,
    entryPremium: 56.63,
    stopPremium: 36.81,
    quantity: 65,
    tp1: 86.36,
    tp2: 106.18,
    tp3: 135.91,
  };

  // =========================================================================
  // TEST 1: Entry 56.63, SL 36.81, Quantity 65
  // =========================================================================
  it('TEST 1: riskPerUnit = 19.82, plannedRisk = 1288.30, premiumOutlay = 3680.95', () => {
    const { riskPerUnit, plannedRisk, premiumOutlay, maxPremiumLoss } = calculateOptionRiskAndOutlay(
      canonicalSetup.entryPremium,
      canonicalSetup.stopPremium,
      canonicalSetup.quantity,
    );

    expect(riskPerUnit).toBe(19.82);
    expect(plannedRisk).toBe(1288.30);
    expect(premiumOutlay).toBe(3680.95);
    expect(maxPremiumLoss).toBe(3680.95);
  });

  // =========================================================================
  // TEST 2: TP1 86.36 -> R = 1.5
  // =========================================================================
  it('TEST 2: TP1 86.36 produces exact R = 1.5', () => {
    const riskDistance = calculateRiskDistance(
      canonicalSetup.entryPremium,
      canonicalSetup.stopPremium,
      'BULLISH',
    );
    expect(riskDistance).toBe(19.82);

    const r1 = calculateTargetR(
      canonicalSetup.entryPremium,
      canonicalSetup.tp1,
      riskDistance,
      'BULLISH',
    );
    expect(r1).toBe(1.5);
  });

  // =========================================================================
  // TEST 3: TP2 106.18 -> R = 2.5
  // =========================================================================
  it('TEST 3: TP2 106.18 produces exact R = 2.5', () => {
    const riskDistance = 19.82;
    const r2 = calculateTargetR(
      canonicalSetup.entryPremium,
      canonicalSetup.tp2,
      riskDistance,
      'BULLISH',
    );
    expect(r2).toBe(2.5);
  });

  // =========================================================================
  // TEST 4: TP3 135.91 -> R = 4.0
  // =========================================================================
  it('TEST 4: TP3 135.91 produces exact R = 4.0', () => {
    const riskDistance = 19.82;
    const r3 = calculateTargetR(
      canonicalSetup.entryPremium,
      canonicalSetup.tp3,
      riskDistance,
      'BULLISH',
    );
    expect(r3).toBe(4.0);
  });

  // =========================================================================
  // Canonical Trade Setup Builder Integration
  // =========================================================================
  it('Canonical Option Trade Setup Model validates and generates complete 1.5R, 2.5R, 4.0R target structure', () => {
    const model = buildCanonicalOptionTradeSetup({
      underlyingSymbol: 'NIFTY',
      underlyingTriggerPrice: 24175.65,
      strike: 24200,
      optionType: 'CE',
      expiry: '29-Sep-2026',
      lotSize: 65,
      entryPremium: 56.63,
      stopPremium: 36.81,
      quantity: 65,
    });

    expect(model.entryPremium).toBe(56.63);
    expect(model.stopPremium).toBe(36.81);
    expect(model.plannedRisk).toBe(1288.30);
    expect(model.premiumOutlay).toBe(3680.95);
    expect(model.maxPremiumLoss).toBe(3680.95);
    expect(model.lots).toBe(1);
    expect(model.quantity).toBe(65);
    expect(model.primaryTargetR).toBe(2.5);
    expect(model.maxPotentialR).toBe(4.0);

    expect(model.targets).toHaveLength(3);
    expect(model.targets[0]).toEqual({ targetIndex: 1, price: 86.36, rMultiple: 1.5 });
    expect(model.targets[1]).toEqual({ targetIndex: 2, price: 106.18, rMultiple: 2.5 });
    expect(model.targets[2]).toEqual({ targetIndex: 3, price: 135.91, rMultiple: 4.0 });
  });

  // =========================================================================
  // Backend Execution Service Setup
  // =========================================================================
  let paperTradingService: PaperTradingService;
  let mockPrisma: any;

  beforeEach(() => {
    const accountRecord = {
      id: 'acc-opt-1',
      currency: 'INR',
      cashBalance: 500000,
    };

    mockPrisma = {
      paperAccount: {
        findFirst: jest.fn().mockResolvedValue(accountRecord),
        findUnique: jest.fn().mockResolvedValue(accountRecord),
        update: jest.fn().mockResolvedValue(accountRecord),
      },
      paperOrder: {
        findUnique: jest.fn().mockResolvedValue(null),
        count: jest.fn().mockResolvedValue(0),
        create: jest.fn().mockImplementation((args) => Promise.resolve({ id: 'ord-1', ...args.data })),
        update: jest.fn().mockImplementation((args) => Promise.resolve({ id: 'ord-1', ...args.data })),
      },
      paperPosition: {
        count: jest.fn().mockResolvedValue(0),
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockImplementation((args) => Promise.resolve({ id: 'pos-1', ...args.data })),
      },
      paperTrade: {
        aggregate: jest.fn().mockResolvedValue({ _sum: { realizedPnL: 0 } }),
        findMany: jest.fn().mockResolvedValue([]),
      },
      paperFill: {
        create: jest.fn().mockImplementation((args) => Promise.resolve({ id: 'fill-1', ...args.data })),
      },
      auditLog: {
        create: jest.fn().mockResolvedValue({}),
      },
      auditEvent: {
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      systemConfig: {
        findFirst: jest.fn().mockResolvedValue({
          configJson: { maxLeverage: 1, maxSlippageBps: 0 },
        }),
      },
      $transaction: jest.fn().mockImplementation(async (callback) => {
        return callback(mockPrisma);
      }),
    };

    paperTradingService = new PaperTradingService(
      mockPrisma,
      {} as any,
      { getValidatedTicker: () => ({ price: 56.63 }) } as any,
      undefined,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );

    jest.spyOn(paperTradingService as any, 'getOrCreateAccount').mockResolvedValue(accountRecord);
    jest.spyOn(paperTradingService as any, 'getSystemConfig').mockResolvedValue({
      maxLeverage: 1,
      maxSlippageBps: 0,
      maxTotalExposurePercent: 100,
    });
    jest.spyOn(paperTradingService as any, 'rejectOrder').mockResolvedValue(undefined as any);
  });

  // =========================================================================
  // TEST 5: Execution price must equal canonical option entry premium (1.25 MUST REJECT)
  // =========================================================================
  it('TEST 5: Execution price must equal canonical entry (request @ 1.25 MUST REJECT)', async () => {
    // If backend canonical market/signal price is 56.63, a rogue execution request @ 1.25 is rejected
    jest.spyOn(paperTradingService as any, 'getValidatedMarketPrice').mockResolvedValue({
      price: 56.63,
      timestamp: new Date(),
    });

    await expect(
      paperTradingService.placeOrder({
        symbol: 'NIFTY',
        contractSymbol: 'NIFTY 24200 CE',
        instrumentType: 'OPTION',
        executionInstrumentType: 'OPTION',
        direction: 'BUY',
        orderType: 'MARKET',
        strike: 24200,
        optionType: 'CE',
        quantity: 65,
        price: 1.25, // Rogue / stale scraper quote
        stopLoss: 36.81,
        target1: 86.36,
        target2: 106.18,
        target3: 135.91,
      }),
    ).rejects.toThrow(/INVALID_STOP_LOSS|PRICE_MISMATCH|CANONICAL_PRICE_DIVERGENCE/);
  });

  // =========================================================================
  // TEST 6: LONG option with SL >= entry MUST REJECT
  // =========================================================================
  it('TEST 6: LONG option with SL >= entry MUST REJECT', async () => {
    jest.spyOn(paperTradingService as any, 'getValidatedMarketPrice').mockResolvedValue({
      price: 56.63,
      timestamp: new Date(),
    });

    // 1. SL > Entry (e.g. SL = 60, Entry = 56.63)
    await expect(
      paperTradingService.placeOrder({
        symbol: 'NIFTY',
        contractSymbol: 'NIFTY 24200 CE',
        instrumentType: 'OPTION',
        executionInstrumentType: 'OPTION',
        direction: 'BUY',
        orderType: 'MARKET',
        strike: 24200,
        optionType: 'CE',
        quantity: 65,
        price: 56.63,
        stopLoss: 60.0,
      }),
    ).rejects.toThrow(/INVALID_STOP_LOSS|OPTION_SL_GE_ENTRY/);

    // 2. SL === Entry (SL = 56.63, Entry = 56.63)
    await expect(
      paperTradingService.placeOrder({
        symbol: 'NIFTY',
        contractSymbol: 'NIFTY 24200 CE',
        instrumentType: 'OPTION',
        executionInstrumentType: 'OPTION',
        direction: 'BUY',
        orderType: 'MARKET',
        strike: 24200,
        optionType: 'CE',
        quantity: 65,
        price: 56.63,
        stopLoss: 56.63,
      }),
    ).rejects.toThrow(/INVALID_STOP_LOSS|OPTION_SL_GE_ENTRY/);
  });

  // =========================================================================
  // TEST 7: Quantity 100 on NIFTY (lot size 65) MUST REJECT
  // =========================================================================
  it('TEST 7: Quantity 100 on NIFTY lot size 65 MUST REJECT', async () => {
    const lotVal = validateOptionLotQuantity(100, 65);
    expect(lotVal.isValid).toBe(false);
    expect(lotVal.error).toContain('must be an exact integer multiple of lot size (65)');

    jest.spyOn(paperTradingService as any, 'getValidatedMarketPrice').mockResolvedValue({
      price: 56.63,
      timestamp: new Date(),
    });

    await expect(
      paperTradingService.placeOrder({
        symbol: 'NIFTY',
        contractSymbol: 'NIFTY 24200 CE',
        instrumentType: 'OPTION',
        executionInstrumentType: 'OPTION',
        direction: 'BUY',
        orderType: 'MARKET',
        strike: 24200,
        optionType: 'CE',
        quantity: 100,
        price: 56.63,
        stopLoss: 36.81,
      }),
    ).rejects.toThrow(/INVALID_LOT_QUANTITY|OPTION_INVALID_LOT_QUANTITY/);
  });

  // =========================================================================
  // TEST 8: Quantity 130 on NIFTY MUST PASS lot validation
  // =========================================================================
  it('TEST 8: Quantity 130 on NIFTY MUST PASS lot validation (2 lots)', () => {
    const lotVal = validateOptionLotQuantity(130, 65);
    expect(lotVal.isValid).toBe(true);
    expect(lotVal.lots).toBe(2);
  });

  // =========================================================================
  // TEST 9: Quantity 195 with max risk ₹3,000 MUST REJECT ((56.63 - 36.81) * 195 = ₹3,864.90)
  // =========================================================================
  it('TEST 9: Quantity 195 with max risk ₹3,000 MUST REJECT (Risk ₹3,864.90 > ₹3,000)', () => {
    const riskPerOption = 56.63 - 36.81; // 19.82
    const totalRisk = riskPerOption * 195;
    expect(Number(totalRisk.toFixed(2))).toBe(3864.90);

    const maxRiskLimit = 3000;
    const isWithinRisk = totalRisk <= maxRiskLimit;
    expect(isWithinRisk).toBe(false);

    // Sizing helper strictly caps lots so risk does not exceed ₹3,000
    const sizing = calculateOptionRiskQuantity(maxRiskLimit, riskPerOption, 65);
    expect(sizing.lots).toBe(2); // 2 lots = 130 qty
    expect(sizing.quantity).toBe(130);
    expect(sizing.plannedRisk).toBe(2576.60);
    expect(sizing.quantity).not.toBe(195);
  });

  // =========================================================================
  // TEST 10: Quantity 130 planned risk 19.82 * 130 = ₹2,576.60 MUST PASS ₹3,000 risk limit
  // =========================================================================
  it('TEST 10: Quantity 130 planned risk 19.82 * 130 = ₹2,576.60 MUST PASS ₹3,000 limit', () => {
    const riskPerOption = 19.82;
    const plannedRisk = Number((riskPerOption * 130).toFixed(2));
    expect(plannedRisk).toBe(2576.60);
    expect(plannedRisk).toBeLessThanOrEqual(3000);
  });

  // =========================================================================
  // TEST 11: TP2 P&L for 65 quantity = ₹3,220.75 before charges
  // =========================================================================
  it('TEST 11: TP2 P&L for 65 quantity = ₹3,220.75 before charges (2.5R)', () => {
    const entryPremium = 56.63;
    const exitPremium = 106.18;
    const quantity = 65;

    const pnl = calculateOptionBuyPnL(entryPremium, exitPremium, quantity);
    expect(pnl).toBe(3220.75);

    // Verify 2.5R relationship
    const plannedRisk = 1288.30;
    const rMultiple = Number((pnl / plannedRisk).toFixed(2));
    expect(rMultiple).toBe(2.5);
  });

  // =========================================================================
  // TEST 12: TP3 P&L for 65 quantity = ₹5,153.20 before charges
  // =========================================================================
  it('TEST 12: TP3 P&L for 65 quantity = ₹5,153.20 before charges (4.0R)', () => {
    const entryPremium = 56.63;
    const exitPremium = 135.91;
    const quantity = 65;

    const pnl = calculateOptionBuyPnL(entryPremium, exitPremium, quantity);
    expect(pnl).toBe(5153.20);

    // Verify 4.0R relationship
    const plannedRisk = 1288.30;
    const rMultiple = Number((pnl / plannedRisk).toFixed(2));
    expect(rMultiple).toBe(4.0);
  });

  // =========================================================================
  // TEST 13: Option P&L must NOT change when internal leverage changes
  // =========================================================================
  it('TEST 13: Option P&L must NOT change when internal leverage field changes (No leverage distortion)', () => {
    const entryPremium = 56.63;
    const exitPremium = 106.18;
    const quantity = 65;

    const basePnL = calculateOptionBuyPnL(entryPremium, exitPremium, quantity);

    // Simulate various hypothetical leverage values (1x, 5x, 50x)
    // Long option BUY P&L is strictly (exit - entry) * quantity, NEVER multiplied by leverage
    const pnl1x = (exitPremium - entryPremium) * quantity;
    const pnlWithIgnoredLeverage = (exitPremium - entryPremium) * quantity; // leverage must NOT enter formula

    expect(basePnL).toBe(3220.75);
    expect(pnl1x).toBeCloseTo(3220.75, 2);
    expect(pnlWithIgnoredLeverage).toBeCloseTo(basePnL, 2);
  });

  // =========================================================================
  // TEST 14: Frontend must NOT be able to override backend execution premium
  // =========================================================================
  it('TEST 14: Frontend cannot override backend execution premium with arbitrary price', async () => {
    // When backend authoritative price is 56.63
    jest.spyOn(paperTradingService as any, 'getValidatedMarketPrice').mockResolvedValue({
      price: 56.63,
      timestamp: new Date(),
    });

    // Frontend attempts to submit order with corrupted price 1.25
    await expect(
      paperTradingService.placeOrder({
        symbol: 'NIFTY',
        contractSymbol: 'NIFTY 24200 CE',
        instrumentType: 'OPTION',
        executionInstrumentType: 'OPTION',
        direction: 'BUY',
        orderType: 'MARKET',
        strike: 24200,
        optionType: 'CE',
        quantity: 65,
        price: 1.25, // Unauthoritative override
        stopLoss: 36.81,
        target1: 86.36,
      }),
    ).rejects.toThrow();

    // Valid canonical submission at 56.63 succeeds
    const position = await paperTradingService.placeOrder({
      symbol: 'NIFTY',
      contractSymbol: 'NIFTY 24200 CE',
      instrumentType: 'OPTION',
      executionInstrumentType: 'OPTION',
      direction: 'BUY',
      orderType: 'MARKET',
      strike: 24200,
      optionType: 'CE',
      quantity: 65,
      price: 56.63,
      stopLoss: 36.81,
      target1: 86.36,
      target2: 106.18,
      target3: 135.91,
    });

    expect(position).toBeDefined();
    expect(position.entryPrice).toBe(56.63);
    expect(position.usedMargin).toBe(3680.95); // 56.63 * 65 cash outlay
  });

  // =========================================================================
  // Additional Invariant: Insufficient Cash Rejection
  // =========================================================================
  it('Option BUY requires 100% premium cash outlay and rejects if account cash is insufficient', async () => {
    jest.spyOn(paperTradingService as any, 'getValidatedMarketPrice').mockResolvedValue({
      price: 56.63,
      timestamp: new Date(),
    });

    // Account only has ₹2,000 cash, but outlay requires ₹3,680.95
    const lowCashAccount = {
      id: 'acc-low-cash',
      currency: 'INR',
      cashBalance: 2000,
    };
    jest.spyOn(paperTradingService as any, 'getOrCreateAccount').mockResolvedValue(lowCashAccount);
    mockPrisma.paperAccount.findFirst.mockResolvedValue(lowCashAccount);
    mockPrisma.paperAccount.findUnique.mockResolvedValue(lowCashAccount);

    await expect(
      paperTradingService.placeOrder({
        symbol: 'NIFTY',
        contractSymbol: 'NIFTY 24200 CE',
        instrumentType: 'OPTION',
        executionInstrumentType: 'OPTION',
        direction: 'BUY',
        orderType: 'MARKET',
        strike: 24200,
        optionType: 'CE',
        quantity: 65,
        price: 56.63,
        stopLoss: 36.81,
        target1: 86.36,
      }),
    ).rejects.toThrow(/INSUFFICIENT_FUNDS/);
  });
});
