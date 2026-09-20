import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  PositionSizingService,
  MarginService,
  RiskService,
  ReservationService,
  ExecutionService,
  OrderService,
  FillService,
  PositionService,
  TradeLifecycleService,
  AccountingService,
  JournalService,
  ReconciliationService,
  DomainTradeDecisionService,
} from '../index';
import {
  Direction,
  OrderState,
  PositionState,
  TradeLifecycleState,
} from '@quant/shared';

describe('Phase 1 — Financial Domain Services Suite', () => {
  let positionSizingService: PositionSizingService;
  let marginService: MarginService;
  let riskService: RiskService;
  let reservationService: ReservationService;
  let executionService: ExecutionService;
  let orderService: OrderService;
  let fillService: FillService;
  let positionService: PositionService;
  let tradeLifecycleService: TradeLifecycleService;
  let accountingService: AccountingService;
  let journalService: JournalService;
  let reconciliationService: ReconciliationService;
  let tradeDecisionService: DomainTradeDecisionService;

  // Mock Prisma state
  const mockOrders: any[] = [];
  const mockFills: any[] = [];
  const mockPositions: any[] = [];
  const mockTrades: any[] = [];
  const mockDecisions: any[] = [];
  const mockExecutions: any[] = [];
  const mockAccounts: any[] = [
    {
      id: 'acc_test_1',
      cashBalance: 1000000,
      usedMargin: 0,
      realizedPnL: 0,
      totalChargesPaid: 0,
      initialCapital: 1000000,
    },
  ];

  const mockPrisma: any = {
    paperAccount: {
      findUnique: jest.fn(({ where }) => mockAccounts.find((a) => a.id === where.id) || null),
      findMany: jest.fn(() => mockAccounts),
      update: jest.fn(({ where, data }) => {
        const acc = mockAccounts.find((a) => a.id === where.id);
        if (acc) {
          if (data.cashBalance?.increment) acc.cashBalance += Number(data.cashBalance.increment);
          if (data.usedMargin?.increment) acc.usedMargin += Number(data.usedMargin.increment);
          if (data.usedMargin?.decrement) acc.usedMargin -= Number(data.usedMargin.decrement);
          if (data.realizedPnL?.increment) acc.realizedPnL += Number(data.realizedPnL.increment);
          if (data.totalChargesPaid?.increment) acc.totalChargesPaid += Number(data.totalChargesPaid.increment);
        }
        return acc;
      }),
    },
    paperPosition: {
      create: jest.fn(({ data }) => {
        const p = { id: `pos_${Date.now()}_${Math.random()}`, ...data, fills: [], trades: [] };
        mockPositions.push(p);
        return p;
      }),
      findUnique: jest.fn(({ where, include }) => {
        const p = mockPositions.find((pos) => pos.id === where.id);
        if (!p) return null;
        if (include?.fills) p.fills = mockFills.filter((f) => f.positionId === p.id);
        if (include?.trades) p.trades = mockTrades.filter((t) => t.positionId === p.id);
        return p;
      }),
      findMany: jest.fn(({ where }) => {
        let res = [...mockPositions];
        if (where?.accountId) res = res.filter((p) => p.accountId === where.accountId);
        if (where?.status?.in) res = res.filter((p) => where.status.in.includes(p.status));
        return res;
      }),
      update: jest.fn(({ where, data }) => {
        const p = mockPositions.find((pos) => pos.id === where.id);
        if (p) Object.assign(p, data);
        return p;
      }),
      count: jest.fn(({ where }) => {
        let res = [...mockPositions];
        if (where?.accountId) res = res.filter((p) => p.accountId === where.accountId);
        if (where?.status?.in) res = res.filter((p) => where.status.in.includes(p.status));
        return res.length;
      }),
    },
    paperOrder: {
      create: jest.fn(({ data }) => {
        const o = { id: `ord_${Date.now()}_${Math.random()}`, ...data };
        mockOrders.push(o);
        return o;
      }),
      findUnique: jest.fn(({ where }) => mockOrders.find((o) => o.id === where.id || o.idempotencyKey === where.idempotencyKey) || null),
      findFirst: jest.fn(() => mockOrders[0] || null),
      findMany: jest.fn(() => mockOrders),
      update: jest.fn(({ where, data }) => {
        const o = mockOrders.find((ord) => ord.id === where.id);
        if (o) Object.assign(o, data);
        return o;
      }),
      count: jest.fn(() => mockOrders.length),
    },
    paperFill: {
      create: jest.fn(({ data }) => {
        const f = { id: `fill_${Date.now()}_${Math.random()}`, ...data };
        mockFills.push(f);
        return f;
      }),
      findMany: jest.fn(({ where }) => {
        let res = [...mockFills];
        if (where?.orderId) res = res.filter((f) => f.orderId === where.orderId);
        if (where?.positionId) res = res.filter((f) => f.positionId === where.positionId);
        if (where?.executionRole) {
          if (typeof where.executionRole === 'string') {
            res = res.filter((f) => f.executionRole === where.executionRole);
          } else if (where.executionRole.in) {
            res = res.filter((f) => where.executionRole.in.includes(f.executionRole));
          }
        }
        return res;
      }),
    },
    paperTrade: {
      create: jest.fn(({ data }) => {
        const t = { id: `tr_${Date.now()}_${Math.random()}`, ...data };
        mockTrades.push(t);
        return t;
      }),
      findFirst: jest.fn(({ where }) => mockTrades.find((t) => t.positionId === where.positionId) || null),
      findMany: jest.fn(() => mockTrades),
      count: jest.fn(({ where }) => mockTrades.filter((t) => t.positionId === where.positionId).length),
    },
    tradeDecision: {
      create: jest.fn(({ data }) => {
        const d = { id: `dec_${Date.now()}_${Math.random()}`, ...data };
        mockDecisions.push(d);
        return d;
      }),
      findUnique: jest.fn(({ where }) => mockDecisions.find((d) => d.id === where.id || d.fingerprint === where.fingerprint) || null),
      update: jest.fn(({ where, data }) => {
        const d = mockDecisions.find((dec) => dec.id === where.id);
        if (d) Object.assign(d, data);
        return d;
      }),
    },
    algoBotExecution: {
      create: jest.fn(({ data }) => {
        const e = { id: `exec_${Date.now()}_${Math.random()}`, ...data };
        mockExecutions.push(e);
        return e;
      }),
      findUnique: jest.fn(({ where }) => mockExecutions.find((e) => e.id === where.id) || null),
      update: jest.fn(({ where, data }) => {
        const e = mockExecutions.find((ex) => ex.id === where.id);
        if (e) Object.assign(e, data);
        return e;
      }),
    },
    tradingSystemConfig: {
      findUnique: jest.fn(() => ({
        id: 'SYSTEM_DEFAULT',
        maxOpenPositions: 5,
        maxTradesPerDay: 20,
        maxConsecutiveLosses: 3,
        maxPositionRiskPercent: 1.0,
        maxDailyLossPercent: 3.0,
        maxTotalExposurePercent: 20.0,
        emergencyStop: false,
      })),
    },
    $transaction: jest.fn(async (callback) => callback(mockPrisma)),
  };

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PositionSizingService,
        MarginService,
        RiskService,
        ReservationService,
        ExecutionService,
        OrderService,
        FillService,
        PositionService,
        TradeLifecycleService,
        AccountingService,
        JournalService,
        ReconciliationService,
        DomainTradeDecisionService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    positionSizingService = module.get(PositionSizingService);
    marginService = module.get(MarginService);
    riskService = module.get(RiskService);
    reservationService = module.get(ReservationService);
    executionService = module.get(ExecutionService);
    orderService = module.get(OrderService);
    fillService = module.get(FillService);
    positionService = module.get(PositionService);
    tradeLifecycleService = module.get(TradeLifecycleService);
    accountingService = module.get(AccountingService);
    journalService = module.get(JournalService);
    reconciliationService = module.get(ReconciliationService);
    tradeDecisionService = module.get(DomainTradeDecisionService);
  });

  beforeEach(() => {
    mockOrders.length = 0;
    mockFills.length = 0;
    mockPositions.length = 0;
    mockTrades.length = 0;
    mockDecisions.length = 0;
    mockExecutions.length = 0;
  });

  // ---------------------------------------------------------------------------
  // 1. Position Sizing Service Tests
  // ---------------------------------------------------------------------------
  describe('PositionSizingService', () => {
    it('floorToStep floors strictly downward and never rounds upward', () => {
      expect(positionSizingService.floorToStep(0.00189, 0.001)).toBe(0.001);
      expect(positionSizingService.floorToStep(1.99, 1)).toBe(1);
      expect(positionSizingService.floorToStep(50.8, 25)).toBe(50);
      expect(positionSizingService.floorToStep(64.9, 65)).toBe(0);
    });

    it('normalizePriceToTick aligns price to exact tick size', () => {
      expect(positionSizingService.normalizePriceToTick(24150.03, 0.05)).toBe(24150.05);
      expect(positionSizingService.normalizePriceToTick(24150.01, 0.05)).toBe(24150.0);
    });

    it('validateQuantity strictly rejects below minQuantity rather than bumping up', () => {
      const res = positionSizingService.validateQuantity(0.0005, 0.001, 0.001);
      expect(res.isValid).toBe(false);
      expect(res.code).toBe('BELOW_MIN_QUANTITY');
      expect(res.normalizedQuantity).toBe(0);
    });

    it('calculates sizing for FIXED_LOTS respecting lotSize', () => {
      const sizing = positionSizingService.calculateSizing({
        sizingModel: 'FIXED_LOTS',
        accountBalance: 1000000,
        entryPrice: 24000,
        stopLoss: 23900,
        symbol: 'NIFTY',
        instrument: { lotSize: 65, minimumQuantity: 65, contractSize: 1, marginMode: 'SPOT' } as any,
        lots: 2,
      });

      expect(sizing.isValid).toBe(true);
      expect(sizing.quantity).toBe(130);
      expect(sizing.lotCount).toBe(2);
    });
  });

  // ---------------------------------------------------------------------------
  // 2. Margin Service Tests
  // ---------------------------------------------------------------------------
  describe('MarginService', () => {
    it('separates notional exposure from margin for leveraged instruments', () => {
      const margin = marginService.calculateMargin({
        instrument: { contractSize: 1, maxLeverage: 5, marginMode: 'ISOLATED' } as any,
        quantity: 10,
        price: 1000,
        leverage: 5,
      });

      expect(margin.notionalAccount).toBe(10000);
      expect(margin.initialMarginRequired).toBe(2000); // 10000 / 5
      expect(margin.effectiveLeverage).toBe(5);
    });

    it('enforces leverage=1 and 100% margin for SPOT instruments', () => {
      const margin = marginService.calculateMargin({
        instrument: { contractSize: 1, marginMode: 'SPOT', symbol: 'BTCUSDT_SPOT' } as any,
        quantity: 1,
        price: 50000,
        leverage: 10, // Attempted 10x leverage
      });

      expect(margin.effectiveLeverage).toBe(1);
      expect(margin.initialMarginRequired).toBe(50000); // 100% notional
      expect(margin.marginMode).toBe('SPOT');
    });

    it('validates margin sufficiency including fee buffer', () => {
      const check = marginService.validateMarginSufficiency(5000, 4800, 300);
      expect(check.sufficient).toBe(false);
      expect(check.deficit).toBe(100);
    });
  });

  // ---------------------------------------------------------------------------
  // 3. Risk Service Tests
  // ---------------------------------------------------------------------------
  describe('RiskService', () => {
    it('breakeven trades (PnL = 0) do not trigger consecutive losses', async () => {
      mockTrades.push(
        { id: 't1', accountId: 'acc_test_1', realizedPnL: -500, exitTime: new Date() },
        { id: 't2', accountId: 'acc_test_1', realizedPnL: 0, exitTime: new Date() }, // Breakeven
        { id: 't3', accountId: 'acc_test_1', realizedPnL: -300, exitTime: new Date() },
      );

      const check = await riskService.checkMaxConsecutiveLosses('acc_test_1', 3);
      expect(check.allowed).toBe(true); // 0 is not a loss
    });

    it('consecutive losses triggered when all trades are negative', async () => {
      mockTrades.push(
        { id: 't1', accountId: 'acc_test_1', realizedPnL: -500, exitTime: new Date() },
        { id: 't2', accountId: 'acc_test_1', realizedPnL: -100, exitTime: new Date() },
        { id: 't3', accountId: 'acc_test_1', realizedPnL: -300, exitTime: new Date() },
      );

      const check = await riskService.checkMaxConsecutiveLosses('acc_test_1', 3);
      expect(check.allowed).toBe(false);
      expect(check.reasonCode).toBe('MAX_CONSECUTIVE_LOSSES');
    });
  });

  // ---------------------------------------------------------------------------
  // 4. Reservation Service Tests
  // ---------------------------------------------------------------------------
  describe('ReservationService', () => {
    it('creates an atomic reservation with finite expiration', async () => {
      const res = await reservationService.reserveResources({
        accountId: 'acc_test_1',
        botId: 'bot_test',
        tradeDecisionId: 'dec_1',
        fingerprint: 'fp_res_1',
        riskAmount: 1000,
        marginAmount: 20000,
        exposureAmount: 50000,
        currency: 'INR',
        expiresInSeconds: 60,
      });

      expect(res.reservationId).toBeDefined();
      expect(res.status).toBe('RESERVED');
      expect(res.expiresAt.getTime()).toBeGreaterThan(Date.now());
    });

    it('rejects duplicate concurrent reservation for identical fingerprint', async () => {
      await reservationService.reserveResources({
        accountId: 'acc_test_1',
        botId: 'bot_test',
        tradeDecisionId: 'dec_1',
        fingerprint: 'fp_dup_1',
        riskAmount: 1000,
        marginAmount: 10000,
        exposureAmount: 20000,
        currency: 'INR',
      });

      await expect(
        reservationService.reserveResources({
          accountId: 'acc_test_1',
          botId: 'bot_test',
          tradeDecisionId: 'dec_2',
          fingerprint: 'fp_dup_1',
          riskAmount: 1000,
          marginAmount: 10000,
          exposureAmount: 20000,
          currency: 'INR',
        }),
      ).rejects.toThrow(/RESERVATION_CONFLICT/);
    });
  });

  // ---------------------------------------------------------------------------
  // 5. Execution Service Tests
  // ---------------------------------------------------------------------------
  describe('ExecutionService', () => {
    it('manages execution state machine and flags RECONCILIATION_REQUIRED', async () => {
      const exec = await executionService.createExecution({
        fingerprint: 'fp_exec_test',
        botId: 'bot_test',
        symbol: 'BTCUSDT_SPOT',
        timeframe: '15m',
        direction: Direction.BULLISH,
        signalTimestamp: new Date(),
        correlationId: 'corr_exec_1',
      });

      expect(exec.state).toBe('RESERVED');

      await executionService.markStarted(exec.id);
      let updated = await executionService.getExecutionById(exec.id);
      expect(updated?.state).toBe('EXECUTING');

      // Critical invariant: uncertain execution must flag RECONCILIATION_REQUIRED
      await executionService.markReconciliationRequired(exec.id, 'Broker socket dropped after submission');
      updated = await executionService.getExecutionById(exec.id);
      expect(updated?.failureReasonCode).toBe('RECONCILIATION_REQUIRED');
    });
  });

  // ---------------------------------------------------------------------------
  // 6. Order & Fill Service Tests
  // ---------------------------------------------------------------------------
  describe('OrderService & FillService', () => {
    it('persists order with clientOrderId and records immutable fill', async () => {
      const order = await orderService.createOrder({
        accountId: 'acc_test_1',
        symbol: 'NIFTY_SPOT',
        direction: Direction.BULLISH,
        requestedQuantity: 50,
        price: 24000,
        idempotencyKey: 'client_order_001',
        correlationId: 'corr_ord_1',
      });

      expect(order.status).toBe(OrderState.SUBMITTED);

      const fill = await fillService.recordFill({
        orderId: order.id,
        positionId: 'pos_sample_1',
        executionRole: 'ENTRY',
        fillPrice: 24005,
        fillQuantity: 50,
        fee: 35.5,
        slippage: 5,
        sourceTimestamp: new Date(),
        correlationId: 'corr_ord_1',
      });

      expect(fill.fillPrice).toBe(24005);
      expect(fill.fillQuantity).toBe(50);
      expect(fill.executionRole).toBe('ENTRY');

      const entryFills = await fillService.getEntryFillsForPosition('pos_sample_1');
      expect(entryFills.length).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // 7. Position Service & Invariant Tests
  // ---------------------------------------------------------------------------
  describe('PositionService', () => {
    it('recalculates position projection strictly from fills: entry - exit', async () => {
      const pos = await positionService.createPosition({
        accountId: 'acc_test_1',
        symbol: 'BTCUSDT_SPOT',
        contractSymbol: 'BTCUSDT_SPOT',
        direction: Direction.BULLISH,
        quantity: 1.0,
        entryPrice: 50000,
        correlationId: 'corr_pos_1',
      });

      // Add entry fill: 1.0 BTC @ 50000
      mockFills.push({
        id: 'f_entry_1',
        orderId: 'ord_1',
        positionId: pos.id,
        executionRole: 'ENTRY',
        fillPrice: 50000,
        fillQuantity: 1.0,
      });

      // Add partial exit fill: 0.4 BTC @ 52000
      mockFills.push({
        id: 'f_exit_1',
        orderId: 'ord_2',
        positionId: pos.id,
        executionRole: 'TP1_PARTIAL',
        fillPrice: 52000,
        fillQuantity: 0.4,
      });

      const projection = await positionService.recalculatePositionFromFills(pos.id);

      expect(projection.totalEntryQuantity).toBe(1.0);
      expect(projection.totalExitQuantity).toBe(0.4);
      expect(projection.currentProjectedQuantity).toBe(0.6); // 1.0 - 0.4
      expect(projection.isFullyClosed).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // 8. Trade Lifecycle Service Tests
  // ---------------------------------------------------------------------------
  describe('TradeLifecycleService', () => {
    it('enforces valid lifecycle DAG transitions and rejects illegal transitions', async () => {
      mockDecisions.push({
        id: 'dec_fsm_1',
        lifecycleState: TradeLifecycleState.SIGNAL_DETECTED,
      });

      // Valid: SIGNAL_DETECTED -> SIGNAL_VALIDATED
      const res1 = await tradeLifecycleService.transition({
        tradeDecisionId: 'dec_fsm_1',
        expectedState: TradeLifecycleState.SIGNAL_DETECTED,
        newState: TradeLifecycleState.SIGNAL_VALIDATED,
        event: 'SIGNAL_PASS',
        correlationId: 'corr_fsm_1',
      });
      expect(res1.currentState).toBe(TradeLifecycleState.SIGNAL_VALIDATED);

      // Illegal: SIGNAL_VALIDATED -> ORDER_FILLED directly (bypassing RISK, APPROVAL, ORDER_SUBMITTED)
      await expect(
        tradeLifecycleService.transition({
          tradeDecisionId: 'dec_fsm_1',
          newState: TradeLifecycleState.ORDER_FILLED,
          event: 'SKIP_GATE',
          correlationId: 'corr_fsm_2',
        }),
      ).rejects.toThrow(/INVALID_LIFECYCLE_TRANSITION/);
    });
  });

  // ---------------------------------------------------------------------------
  // 9. Accounting & Financial Invariant Tests
  // ---------------------------------------------------------------------------
  describe('AccountingService', () => {
    it('calculates realized P&L from actual fills and charges', () => {
      const pnl = accountingService.calculateRealizedPnL({
        direction: Direction.BULLISH,
        entryPrice: 100,
        exitPrice: 110,
        quantity: 10,
        contractSize: 1,
        fxRate: 1.0,
        entryFees: 5,
        exitFees: 5,
      });

      expect(pnl.grossPnLAccount).toBe(100); // (110 - 100) * 10
      expect(pnl.totalCharges).toBe(10);
      expect(pnl.netPnLAccount).toBe(90); // 100 - 10
      expect(pnl.cashDelta).toBe(95); // 100 - 5 (exit fee only)
    });

    it('rejects financial invariant breaches: NaN and negative margin', () => {
      expect(() => {
        accountingService.assertFinancialInvariants({
          cashBalance: NaN,
          usedMargin: 100,
          realizedPnL: 0,
          totalChargesPaid: 0,
        });
      }).toThrow(/FINANCIAL_INVARIANT_BREACH/);

      expect(() => {
        accountingService.assertFinancialInvariants({
          cashBalance: 1000,
          usedMargin: -50,
          realizedPnL: 0,
          totalChargesPaid: 0,
        });
      }).toThrow(/usedMargin cannot be negative/);
    });
  });

  // ---------------------------------------------------------------------------
  // 10. Journal & Reconciliation Tests
  // ---------------------------------------------------------------------------
  describe('JournalService & ReconciliationService', () => {
    it('creates canonical journal entry and enforces uniqueness per position', async () => {
      const journal1 = await journalService.createJournalEntry({
        accountId: 'acc_test_1',
        positionId: 'pos_journal_test',
        symbol: 'NIFTY_SPOT',
        contractSymbol: 'NIFTY_SPOT',
        instrumentType: 'SPOT',
        direction: Direction.BULLISH,
        quantity: 50,
        entryPrice: 24000,
        exitPrice: 24200,
        realizedPnL: 9900,
        fees: 100,
        exitReason: 'Target 1 Completed',
        correlationId: 'corr_j_1',
      });

      expect(journal1.id).toBeDefined();

      // Duplicate attempt should return existing journal without inserting second record
      const journal2 = await journalService.createJournalEntry({
        accountId: 'acc_test_1',
        positionId: 'pos_journal_test',
        symbol: 'NIFTY_SPOT',
        contractSymbol: 'NIFTY_SPOT',
        instrumentType: 'SPOT',
        direction: Direction.BULLISH,
        quantity: 50,
        entryPrice: 24000,
        exitPrice: 24200,
        realizedPnL: 9900,
        fees: 100,
        exitReason: 'Target 1 Completed',
        correlationId: 'corr_j_2',
      });

      expect(journal2.id).toBe(journal1.id);
      expect(mockTrades.length).toBe(1);
    });

    it('detects position reconciliation anomalies between stored qty and fill projection', async () => {
      mockPositions.push({
        id: 'pos_corrupt_1',
        accountId: 'acc_test_1',
        quantity: 100, // Stored quantity says 100
        status: PositionState.OPEN,
      });

      // But fills only record 50 entry
      mockFills.push({
        id: 'f_corrupt_entry',
        positionId: 'pos_corrupt_1',
        executionRole: 'ENTRY',
        fillQuantity: 50,
      });

      const report = await reconciliationService.reconcilePosition('pos_corrupt_1');
      expect(report.isConsistent).toBe(false);
      expect(report.anomalies.length).toBeGreaterThan(0);
      expect(report.anomalies[0]).toContain('Quantity discrepancy');
    });
  });
});
