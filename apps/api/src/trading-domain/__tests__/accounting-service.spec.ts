import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AccountingService } from '../accounting.service';
import { Direction, FxRateSnapshot } from '@quant/shared';
import { Decimal } from '@prisma/client/runtime/library';

describe('AccountingService', () => {
  let service: AccountingService;
  let mockAccounts: any[] = [];

  const mockPrisma: any = {
    paperAccount: {
      findUnique: jest.fn(({ where }) => {
        return mockAccounts.find((a) => a.id === where.id) || null;
      }),
      update: jest.fn(({ where, data }) => {
        const acc = mockAccounts.find((a) => a.id === where.id);
        if (!acc) throw new Error(`Account '${where.id}' not found`);

        if (data.cashBalance?.increment !== undefined) {
          acc.cashBalance = new Decimal(Number(acc.cashBalance) + Number(data.cashBalance.increment));
        }
        if (data.usedMargin?.increment !== undefined) {
          acc.usedMargin = new Decimal(Number(acc.usedMargin) + Number(data.usedMargin.increment));
        }
        if (data.realizedPnL?.increment !== undefined) {
          acc.realizedPnL = new Decimal(Number(acc.realizedPnL) + Number(data.realizedPnL.increment));
        }
        if (data.totalChargesPaid?.increment !== undefined) {
          acc.totalChargesPaid = new Decimal(Number(acc.totalChargesPaid) + Number(data.totalChargesPaid.increment));
        }
        return acc;
      }),
    },
  };

  beforeEach(async () => {
    mockAccounts = [];
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AccountingService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get<AccountingService>(AccountingService);
  });

  describe('FIFO & LIFO Lot Matching', () => {
    it('matches single entry lot completely using FIFO', () => {
      const entryLots = [
        { id: 'lot_1', quantity: 10, price: 100, fees: 5 },
      ];

      const result = service.matchLots(entryLots, 10, 110, 'FIFO');
      expect(result.totalMatchedQuantity).toBe(10);
      expect(result.weightedEntryPrice).toBe(100);
      expect(result.remainingLots).toHaveLength(0);
      expect(result.unmatchedExitQuantity).toBe(0);
      expect(result.matchedLots[0].matchedQuantity).toBe(10);
      expect(result.matchedLots[0].entryFeesAllocated).toBe(5);
      expect(result.matchedLots[0].grossPnLQuote).toBe(100);
    });

    it('matches multiple entry lots in FIFO order with partial consumption', () => {
      const entryLots = [
        { id: 'lot_1', quantity: 5, price: 100, fees: 10 },
        { id: 'lot_2', quantity: 10, price: 110, fees: 20 },
      ];

      // Exit 8 units: should consume 5 units of lot_1, and 3 units of lot_2
      const result = service.matchLots(entryLots, 8, 120, 'FIFO');
      expect(result.totalMatchedQuantity).toBe(8);
      expect(result.matchedLots).toHaveLength(2);

      // Matched from lot_1
      expect(result.matchedLots[0].lotId).toBe('lot_1');
      expect(result.matchedLots[0].matchedQuantity).toBe(5);
      expect(result.matchedLots[0].entryFeesAllocated).toBe(10);

      // Matched from lot_2
      expect(result.matchedLots[1].lotId).toBe('lot_2');
      expect(result.matchedLots[1].matchedQuantity).toBe(3);
      expect(result.matchedLots[1].entryFeesAllocated).toBe(6); // 20 * (3 / 10) = 6

      // Remaining lots: lot_2 with 7 units
      expect(result.remainingLots).toHaveLength(1);
      expect(result.remainingLots[0].id).toBe('lot_2');
      expect(result.remainingLots[0].quantity).toBe(7);
      expect(result.remainingLots[0].fees).toBe(14); // 20 - 6

      // Weighted entry price: (5 * 100 + 3 * 110) / 8 = (500 + 330) / 8 = 103.75
      expect(result.weightedEntryPrice).toBe(103.75);
    });

    it('matches entry lots in LIFO order', () => {
      const entryLots = [
        { id: 'lot_1', quantity: 5, price: 100 },
        { id: 'lot_2', quantity: 10, price: 110 },
      ];

      // Exit 6 units LIFO: consumes 6 units from lot_2 first
      const result = service.matchLots(entryLots, 6, 120, 'LIFO');
      expect(result.totalMatchedQuantity).toBe(6);
      expect(result.matchedLots[0].lotId).toBe('lot_2');
      expect(result.matchedLots[0].matchedQuantity).toBe(6);

      // Remaining lots: lot_1 (5) and lot_2 (4)
      expect(result.remainingLots).toHaveLength(2);
      expect(result.remainingLots[0].id).toBe('lot_1');
      expect(result.remainingLots[0].quantity).toBe(5);
      expect(result.remainingLots[1].id).toBe('lot_2');
      expect(result.remainingLots[1].quantity).toBe(4);
    });

    it('rejects invalid lot matching inputs', () => {
      expect(() => service.matchLots([], -1, 100)).toThrow(BadRequestException);
      expect(() => service.matchLots([], 10, 0)).toThrow(BadRequestException);
    });
  });

  describe('Multi-Asset Realized PnL Calculation', () => {
    it('calculates Spot Long Win with explicit loss semantics', () => {
      const pnl = service.calculateRealizedPnL({
        direction: Direction.BULLISH,
        entryPrice: 100,
        exitPrice: 115,
        quantity: 10,
        contractSize: 1,
        entryFees: 5,
        exitFees: 5,
        initialRiskAccount: 50, // 50 INR risked
      });

      // Gross = (115 - 100) * 10 = 150
      expect(pnl.grossPnLAccount).toBe(150);
      expect(pnl.totalCharges).toBe(10);
      expect(pnl.netPnLAccount).toBe(140);
      expect(pnl.cashDelta).toBe(145); // 150 - 5 exit fee
      expect(pnl.outcomeClassification).toBe('WIN');
      expect(pnl.realizedR).toBe(2.8); // 140 / 50 = 2.8R
    });

    it('calculates Spot Long Loss with explicit loss semantics', () => {
      const pnl = service.calculateRealizedPnL({
        direction: Direction.BULLISH,
        entryPrice: 100,
        exitPrice: 90,
        quantity: 10,
        contractSize: 1,
        entryFees: 5,
        exitFees: 5,
        initialRiskAccount: 100,
      });

      // Gross = (90 - 100) * 10 = -100
      expect(pnl.grossPnLAccount).toBe(-100);
      expect(pnl.totalCharges).toBe(10);
      expect(pnl.netPnLAccount).toBe(-110);
      expect(pnl.cashDelta).toBe(-105);
      expect(pnl.outcomeClassification).toBe('LOSS');
      expect(pnl.realizedR).toBe(-1.1); // -110 / 100 = -1.1R
    });

    it('calculates Spot Breakeven when net PnL is 0', () => {
      const pnl = service.calculateRealizedPnL({
        direction: Direction.BULLISH,
        entryPrice: 100,
        exitPrice: 101,
        quantity: 10,
        contractSize: 1,
        entryFees: 5,
        exitFees: 5,
      });

      // Gross = (101 - 100) * 10 = 10, Charges = 10 -> Net = 0
      expect(pnl.grossPnLAccount).toBe(10);
      expect(pnl.totalCharges).toBe(10);
      expect(pnl.netPnLAccount).toBe(0);
      expect(pnl.outcomeClassification).toBe('BREAKEVEN');
      expect(pnl.realizedR).toBe(0);
    });

    it('calculates Perpetual Short Win including funding fees', () => {
      const pnl = service.calculateRealizedPnL({
        direction: Direction.BEARISH,
        entryPrice: 50000,
        exitPrice: 48000,
        quantity: 0.1,
        contractSize: 1,
        funding: 10, // funding payment deducted
        entryFees: 2,
        exitFees: 2,
      });

      // Short: (50000 - 48000) * 0.1 = 200 quote PnL. Minus 10 funding = 190.
      expect(pnl.grossPnLAccount).toBe(190);
      expect(pnl.totalCharges).toBe(4);
      expect(pnl.netPnLAccount).toBe(186);
      expect(pnl.outcomeClassification).toBe('WIN');
    });

    it('calculates Option Long Put (PE) buyer profit when premium rises', () => {
      const pnl = service.calculateRealizedPnL({
        instrumentType: 'OPTION',
        optionType: 'PE',
        direction: 'BUY',
        entryPrice: 50, // bought PE at 50 premium
        exitPrice: 90,  // sold PE at 90 premium
        quantity: 50,   // NIFTY lot
        contractSize: 1,
        entryFees: 20,
        exitFees: 20,
      });

      // Premium gain: (90 - 50) * 50 = 2000
      expect(pnl.grossPnLAccount).toBe(2000);
      expect(pnl.totalCharges).toBe(40);
      expect(pnl.netPnLAccount).toBe(1960);
      expect(pnl.outcomeClassification).toBe('WIN');
    });

    it('locks in historical FX snapshot rate for cross-currency accounting', () => {
      const snapshot: FxRateSnapshot = {
        sourceCurrency: 'USD',
        targetCurrency: 'INR',
        rate: 85.0,
        rateTimestamp: Date.now(),
        rateSource: 'RESERVE_BANK',
        pair: 'USD/INR',
        snapshotHash: 'mock_hash',
      };

      const pnl = service.calculateRealizedPnL({
        direction: Direction.BULLISH,
        entryPrice: 100,
        exitPrice: 110,
        quantity: 1,
        fxSnapshot: snapshot, // Uses 85.0 instead of default 1.0
      });

      // Gross Quote = $10. In INR at 85 = 850 INR
      expect(pnl.grossPnLQuote).toBe(10);
      expect(pnl.grossPnLAccount).toBe(850);
      expect(pnl.fxSnapshot).toEqual(snapshot);
    });

    it('derives realizedR from initialStopLoss if initialRiskAccount is not explicitly supplied', () => {
      const pnl = service.calculateRealizedPnL({
        direction: Direction.BULLISH,
        entryPrice: 100,
        exitPrice: 110,
        quantity: 10,
        initialStopLoss: 95, // Risk per unit = 5, total risk = 50
        entryFees: 5,
        exitFees: 5,
      });

      // Net PnL = 100 - 10 = 90. Derived risk = 50. Realized R = 90 / 50 = 1.8R
      expect(pnl.netPnLAccount).toBe(90);
      expect(pnl.realizedR).toBe(1.8);
    });

    it('deducts unpriced slippage when slippageIncludedInPrices is false', () => {
      const pnl = service.calculateRealizedPnL({
        direction: Direction.BULLISH,
        entryPrice: 100,
        exitPrice: 110,
        quantity: 10,
        slippage: 15,
        slippageIncludedInPrices: false,
        entryFees: 5,
        exitFees: 5,
      });

      // Gross = 100, Charges = 10, Unpriced Slippage = 15 -> Net = 75
      expect(pnl.grossPnLAccount).toBe(100);
      expect(pnl.netPnLAccount).toBe(75);
      expect(pnl.cashDelta).toBe(80); // 100 - 5 (exit fee) - 15 (slippage) = 80
      expect(pnl.slippage).toBe(15);
    });

    it('rejects non-positive inputs to calculateRealizedPnL', () => {
      expect(() =>
        service.calculateRealizedPnL({
          direction: Direction.BULLISH,
          entryPrice: -100,
          exitPrice: 110,
          quantity: 1,
        }),
      ).toThrow(BadRequestException);
    });
  });

  describe('Unrealized PnL Calculation', () => {
    it('calculates unrealized mark-to-market PnL for Long and Short', () => {
      const longU = service.calculateUnrealizedPnL(Direction.BULLISH, 100, 105, 10);
      expect(longU).toBe(50);

      const shortU = service.calculateUnrealizedPnL(Direction.BEARISH, 100, 105, 10);
      expect(shortU).toBe(-50);
    });
  });

  describe('Position Leg Settlement', () => {
    beforeEach(() => {
      mockAccounts.push({
        id: 'acc_settle_1',
        cashBalance: new Decimal(100000),
        usedMargin: new Decimal(0),
        realizedPnL: new Decimal(0),
        totalChargesPaid: new Decimal(0),
      });
    });

    it('settles an ENTRY leg: encumbers margin and debits entry fee from cash', async () => {
      const result = await service.settlePositionLeg({
        accountId: 'acc_settle_1',
        positionId: 'pos_1',
        role: 'ENTRY',
        direction: Direction.BULLISH,
        entryPrice: 100,
        exitPrice: 100,
        quantity: 10,
        releasedMargin: 1000, // required initial margin encumbered
        entryFees: 20,
        applyToAccount: true,
      });

      expect(result.ledgerDelta.cashBalanceDelta).toBe(-20);
      expect(result.ledgerDelta.usedMarginDelta).toBe(1000);
      expect(result.ledgerDelta.realizedPnLDelta).toBe(-20);
      expect(result.ledgerDelta.chargesDelta).toBe(20);

      // DB verification
      const acc = mockAccounts[0];
      expect(Number(acc.cashBalance)).toBe(99980);
      expect(Number(acc.usedMargin)).toBe(1000);
      expect(Number(acc.realizedPnL)).toBe(-20);
      expect(Number(acc.totalChargesPaid)).toBe(20);
    });

    it('settles a FINAL_EXIT leg: releases margin and credits cash balance', async () => {
      // Setup position already open with 1000 used margin
      mockAccounts[0].usedMargin = new Decimal(1000);
      mockAccounts[0].cashBalance = new Decimal(99980);
      mockAccounts[0].realizedPnL = new Decimal(-20);
      mockAccounts[0].totalChargesPaid = new Decimal(20);

      const result = await service.settlePositionLeg({
        accountId: 'acc_settle_1',
        positionId: 'pos_1',
        role: 'FINAL_EXIT',
        direction: Direction.BULLISH,
        entryPrice: 100,
        exitPrice: 120,
        quantity: 10,
        releasedMargin: 1000, // release 1000 margin
        entryFees: 0,
        exitFees: 15,
        applyToAccount: true,
      });

      // Gross = (120 - 100) * 10 = 200. Cash delta = 200 - 15 = 185.
      expect(result.pnlResult.netPnLAccount).toBe(185);
      expect(result.ledgerDelta.cashBalanceDelta).toBe(185);
      expect(result.ledgerDelta.usedMarginDelta).toBe(-1000);

      // DB verification
      const acc = mockAccounts[0];
      expect(Number(acc.cashBalance)).toBe(99980 + 185);
      expect(Number(acc.usedMargin)).toBe(0); // Margin returned!
      expect(Number(acc.realizedPnL)).toBe(-20 + 185); // 165
      expect(Number(acc.totalChargesPaid)).toBe(20 + 15); // 35
    });
  });

  describe('Ledger Invariant Enforcement', () => {
    it('rejects NaN, Infinity, and negative usedMargin', () => {
      expect(() => {
        service.assertFinancialInvariants({
          cashBalance: NaN,
          usedMargin: 0,
          realizedPnL: 0,
          totalChargesPaid: 0,
        });
      }).toThrow(/FINANCIAL_INVARIANT_BREACH/);

      expect(() => {
        service.assertFinancialInvariants({
          cashBalance: 1000,
          usedMargin: -10,
          realizedPnL: 0,
          totalChargesPaid: 0,
        });
      }).toThrow(/usedMargin cannot be negative/);

      expect(() => {
        service.assertFinancialInvariants({
          cashBalance: 1000,
          usedMargin: 10,
          realizedPnL: 0,
          totalChargesPaid: -5,
        });
      }).toThrow(/totalChargesPaid cannot be negative/);
    });
  });
});
