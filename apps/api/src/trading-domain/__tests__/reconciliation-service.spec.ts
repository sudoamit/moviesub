import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ReconciliationService } from '../reconciliation.service';
import { PositionState, OrderState } from '@quant/shared';
import { Decimal } from '@prisma/client/runtime/library';

describe('ReconciliationService', () => {
  let service: ReconciliationService;
  let mockPositions: any[] = [];
  let mockAccounts: any[] = [];
  let mockOrders: any[] = [];
  let mockFills: any[] = [];
  let mockExecutions: any[] = [];
  let mockTrades: any[] = [];

  const mockPrisma: any = {
    $transaction: jest.fn((cb) => cb(mockPrisma)),
    paperPosition: {
      findUnique: jest.fn(({ where, include }) => {
        const pos = mockPositions.find((p) => p.id === where.id);
        if (!pos) return null;
        const res = { ...pos };
        if (include?.fills) {
          res.fills = mockFills.filter((f) => f.positionId === pos.id);
        }
        if (include?.trades) {
          res.trades = (pos.trades && pos.trades.length > 0) ? pos.trades : mockTrades.filter((t) => t.positionId === pos.id);
        }
        return res;
      }),
      findFirst: jest.fn(({ where }) => {
        return mockPositions.find((p) => !where?.orderId || p.orderId === where.orderId) || null;
      }),
      findMany: jest.fn(({ where, select, include }) => {
        let list = [...mockPositions];
        if (where?.accountId) list = list.filter((p) => p.accountId === where.accountId);
        if (where?.status?.in) list = list.filter((p) => where.status.in.includes(p.status));
        else if (where?.status) list = list.filter((p) => p.status === where.status);

        return list.map((pos) => {
          const res: any = { ...pos };
          if (include?.fills) {
            res.fills = mockFills.filter((f) => f.positionId === pos.id);
          }
          if (include?.trades) {
            res.trades = (pos.trades && pos.trades.length > 0) ? pos.trades : mockTrades.filter((t) => t.positionId === pos.id);
          }
          return res;
        });
      }),
      update: jest.fn(({ where, data }) => {
        const pos = mockPositions.find((p) => p.id === where.id);
        if (!pos) throw new Error('Position not found');
        Object.assign(pos, data);
        return pos;
      }),
    },
    paperAccount: {
      findUnique: jest.fn(({ where }) => {
        return mockAccounts.find((a) => a.id === where.id) || null;
      }),
      findMany: jest.fn(() => [...mockAccounts]),
      update: jest.fn(({ where, data }) => {
        const acc = mockAccounts.find((a) => a.id === where.id);
        if (!acc) throw new Error('Account not found');
        Object.assign(acc, data);
        return acc;
      }),
    },
    paperOrder: {
      findUnique: jest.fn(({ where, include }) => {
        const ord = mockOrders.find((o) => o.id === where.id);
        if (!ord) return null;
        const res = { ...ord };
        if (include?.fills) {
          res.fills = mockFills.filter((f) => f.orderId === ord.id);
        }
        if (include?.positions) {
          res.positions = mockPositions.filter((p) => p.orderId === ord.id);
        }
        return res;
      }),
      findFirst: jest.fn(({ where, include }) => {
        const ord = mockOrders.find((o) => {
          if (where?.OR) {
            return where.OR.some((cond: any) =>
              (cond.idempotencyKey && o.idempotencyKey === cond.idempotencyKey) ||
              (cond.correlationId && o.correlationId === cond.correlationId)
            );
          }
          return false;
        });
        if (!ord) return null;
        const res = { ...ord };
        if (include?.fills) {
          res.fills = mockFills.filter((f) => f.orderId === ord.id);
        }
        if (include?.positions) {
          res.positions = mockPositions.filter((p) => p.orderId === ord.id);
        }
        return res;
      }),
      findMany: jest.fn(({ where, include }) => {
        let list = [...mockOrders];
        if (where?.accountId) list = list.filter((o) => o.accountId === where.accountId);
        if (where?.status?.in) list = list.filter((o) => where.status.in.includes(o.status));
        return list.map((o) => {
          const res = { ...o };
          if (include?.fills) res.fills = mockFills.filter((f) => f.orderId === o.id);
          return res;
        });
      }),
      update: jest.fn(({ where, data }) => {
        const ord = mockOrders.find((o) => o.id === where.id);
        if (!ord) throw new Error('Order not found');
        Object.assign(ord, data);
        return ord;
      }),
    },
    paperFill: {
      create: jest.fn(({ data }) => {
        const fill = { id: data.id || `f_${Date.now()}_${Math.random()}`, ...data };
        mockFills.push(fill);
        return fill;
      }),
      findMany: jest.fn(({ where }) => {
        let list = [...mockFills];
        if (where?.orderId) list = list.filter((f) => f.orderId === where.orderId);
        if (where?.positionId) list = list.filter((f) => f.positionId === where.positionId);
        return list;
      }),
    },
    paperTrade: {
      create: jest.fn(({ data }) => {
        const trade = { id: data.id || `trade_${Date.now()}_${Math.random()}`, ...data };
        mockTrades.push(trade);
        return trade;
      }),
      findMany: jest.fn(() => [...mockTrades]),
    },
    algoBotExecution: {
      findMany: jest.fn(({ where }) => {
        let list = [...mockExecutions];
        if (where?.failureReasonCode) {
          list = list.filter((e) => e.failureReasonCode === where.failureReasonCode);
        }
        return list;
      }),
      updateMany: jest.fn(({ where, data }) => {
        const matched = mockExecutions.filter((e) => !where?.id || e.id === where.id);
        matched.forEach((e) => Object.assign(e, data));
        return { count: matched.length };
      }),
    },
    tradeDecision: {
      updateMany: jest.fn(() => ({ count: 1 })),
    },
  };

  beforeEach(async () => {
    mockPositions = [];
    mockAccounts = [];
    mockOrders = [];
    mockFills = [];
    mockExecutions = [];
    mockTrades = [];
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReconciliationService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get<ReconciliationService>(ReconciliationService);
  });

  describe('Position Reconciliation', () => {
    it('reconciles a clean, consistent position', async () => {
      mockPositions.push({
        id: 'pos_clean',
        accountId: 'acc_1',
        quantity: new Decimal(10),
        status: PositionState.OPEN,
      });
      mockFills.push({
        id: 'f1',
        positionId: 'pos_clean',
        fillQuantity: 10,
        executionRole: 'ENTRY',
      });

      const res = await service.reconcilePosition('pos_clean');
      expect(res.isConsistent).toBe(true);
      expect(res.storedQuantity).toBe(10);
      expect(res.projectedQuantityFromFills).toBe(10);
      expect(res.anomalies).toHaveLength(0);
    });

    it('detects discrepancy between stored quantity and fills ledger projection', async () => {
      mockPositions.push({
        id: 'pos_discrepant',
        accountId: 'acc_1',
        quantity: new Decimal(50), // Stored says 50
        status: PositionState.OPEN,
      });
      mockFills.push(
        { id: 'f1', positionId: 'pos_discrepant', fillQuantity: 100, executionRole: 'ENTRY' },
        { id: 'f2', positionId: 'pos_discrepant', fillQuantity: 80, executionRole: 'TP1_PARTIAL' },
      ); // 100 entry - 80 exit = 20 projected!

      const res = await service.reconcilePosition('pos_discrepant');
      expect(res.isConsistent).toBe(false);
      expect(res.storedQuantity).toBe(50);
      expect(res.projectedQuantityFromFills).toBe(20);
      expect(res.anomalies[0]).toMatch(/Quantity discrepancy/);
    });

    it('detects a closed position lacking a canonical PaperTrade journal entry', async () => {
      mockPositions.push({
        id: 'pos_no_journal',
        accountId: 'acc_1',
        quantity: new Decimal(0),
        status: PositionState.CLOSED,
        trades: [], // No journal record!
      });

      const res = await service.reconcilePosition('pos_no_journal');
      expect(res.isConsistent).toBe(false);
      expect(res.hasJournal).toBe(false);
      expect(res.anomalies[0]).toMatch(/lacks a canonical PaperTrade journal entry/);
    });
  });

  describe('Account Reconciliation', () => {
    it('reconciles a clean account with exact margin synchronization', async () => {
      mockAccounts.push({
        id: 'acc_clean',
        cashBalance: new Decimal(100000),
        usedMargin: new Decimal(2000),
      });
      mockPositions.push({
        id: 'p1',
        accountId: 'acc_clean',
        status: PositionState.OPEN,
        usedMargin: new Decimal(2000),
      });

      const res = await service.reconcileAccount('acc_clean');
      expect(res.isConsistent).toBe(true);
      expect(res.marginDiscrepancy).toBe(0);
      expect(res.anomalies).toHaveLength(0);
    });

    it('detects margin lock drift between account and active positions', async () => {
      mockAccounts.push({
        id: 'acc_drift',
        cashBalance: new Decimal(100000),
        usedMargin: new Decimal(5000), // Stored says 5000
      });
      mockPositions.push({
        id: 'p1',
        accountId: 'acc_drift',
        status: PositionState.OPEN,
        usedMargin: new Decimal(2000), // Active sum is only 2000!
      });

      const res = await service.reconcileAccount('acc_drift');
      expect(res.isConsistent).toBe(false);
      expect(res.marginDiscrepancy).toBe(3000);
      expect(res.anomalies[0]).toMatch(/Margin lock drift/);
    });
  });

  describe('Order Reconciliation', () => {
    it('reconciles a consistent filled order', async () => {
      mockOrders.push({
        id: 'ord_clean',
        requestedQuantity: new Decimal(10),
        filledQuantity: new Decimal(10),
        status: OrderState.FILLED,
      });
      mockFills.push({
        id: 'f1',
        orderId: 'ord_clean',
        fillQuantity: 10,
      });

      const res = await service.reconcileOrder('ord_clean');
      expect(res.isConsistent).toBe(true);
      expect(res.storedFilledQuantity).toBe(10);
      expect(res.actualFillQuantitySum).toBe(10);
      expect(res.anomalies).toHaveLength(0);
    });

    it('detects overfill anomaly', async () => {
      mockOrders.push({
        id: 'ord_overfill',
        requestedQuantity: new Decimal(10),
        filledQuantity: new Decimal(12),
        status: OrderState.FILLED,
      });
      mockFills.push(
        { id: 'f1', orderId: 'ord_overfill', fillQuantity: 10 },
        { id: 'f2', orderId: 'ord_overfill', fillQuantity: 2 },
      ); // 12 fills on 10 requested!

      const res = await service.reconcileOrder('ord_overfill');
      expect(res.isConsistent).toBe(false);
      expect(res.anomalies.some((a) => a.includes('Overfill detected'))).toBe(true);
    });
  });

  describe('Full Account Audit & Health Score', () => {
    it('returns 100% health score for pristine account', async () => {
      mockAccounts.push({
        id: 'acc_pristine',
        cashBalance: new Decimal(500000),
        usedMargin: new Decimal(0),
      });

      const audit = await service.performFullAudit('acc_pristine');
      expect(audit.isHealthy).toBe(true);
      expect(audit.healthScore).toBe(100);
      expect(audit.anomaliesCount).toBe(0);
      expect(audit.remediationSuggestions).toHaveLength(0);
    });

    it('degrades health score and generates remediation suggestions when anomalies exist', async () => {
      mockAccounts.push({
        id: 'acc_degraded',
        cashBalance: new Decimal(500000),
        usedMargin: new Decimal(5000), // Drifting margin
      });
      mockPositions.push({
        id: 'pos_corrupt',
        accountId: 'acc_degraded',
        quantity: new Decimal(100),
        status: PositionState.OPEN,
        usedMargin: new Decimal(1000),
      });
      mockFills.push({
        id: 'f1',
        positionId: 'pos_corrupt',
        fillQuantity: 80, // Fills sum is 80 != 100
        executionRole: 'ENTRY',
      });
      mockExecutions.push({
        id: 'exec_stranded',
        failureReasonCode: 'RECONCILIATION_REQUIRED',
      });

      const audit = await service.performFullAudit('acc_degraded');
      expect(audit.isHealthy).toBe(false);
      expect(audit.healthScore).toBeLessThan(100);
      expect(audit.anomaliesCount).toBeGreaterThanOrEqual(2);
      expect(audit.remediationSuggestions.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('Automated Remediation (autoRemediateAccount)', () => {
    it('automatically recalibrates drifting margin and position quantities', async () => {
      const accountId = 'acc_healing';
      mockAccounts.push({
        id: accountId,
        cashBalance: new Decimal(100000),
        usedMargin: new Decimal(8000), // Drifting margin: stored 8000 vs actual 2000
      });
      mockPositions.push({
        id: 'pos_heal',
        accountId,
        quantity: new Decimal(100), // Corrupt quantity: stored 100 vs actual fills 50
        status: PositionState.OPEN,
        usedMargin: new Decimal(2000),
      });
      mockFills.push({
        id: 'f_heal',
        positionId: 'pos_heal',
        fillQuantity: 50,
        executionRole: 'ENTRY',
      });

      const remediation = await service.autoRemediateAccount(accountId);
      expect(remediation.success).toBe(true);
      expect(remediation.remediatedMarginDrift).toBe(true);
      expect(remediation.remediatedPositions).toBe(1);

      // Verify DB updates
      const healedAccount = mockAccounts[0];
      expect(Number(healedAccount.usedMargin)).toBe(2000);

      const healedPosition = mockPositions[0];
      expect(Number(healedPosition.quantity)).toBe(50);
    });
  });

  describe('Startup Reconciliation Sweep', () => {
    it('runs startup sweep over active positions and accounts', async () => {
      mockAccounts.push({
        id: 'acc_sweep',
        cashBalance: new Decimal(100000),
        usedMargin: new Decimal(0),
      });
      mockPositions.push({
        id: 'pos_sweep',
        accountId: 'acc_sweep',
        quantity: new Decimal(10),
        status: PositionState.OPEN,
        trades: [],
      });
      mockFills.push({
        id: 'f_sweep',
        positionId: 'pos_sweep',
        fillQuantity: 10,
        executionRole: 'ENTRY',
      });

      const sweep = await service.runStartupReconciliation();
      expect(sweep.reconciledPositions).toBe(1);
    });
  });

  describe('Journal Reconciliation', () => {
    it('detects CLOSED position missing a PaperTrade journal record and automatically reconstructs it', async () => {
      const posId = 'pos_closed_no_journal';
      mockPositions.push({
        id: posId,
        accountId: 'acc_journal',
        symbol: 'NIFTY_SPOT',
        contractSymbol: 'NIFTY_SPOT',
        instrumentType: 'SPOT',
        direction: 'BULLISH',
        quantity: new Decimal(0),
        entryPrice: new Decimal(24000),
        status: PositionState.CLOSED,
        createdAt: new Date(Date.now() - 60000),
        closedAt: new Date(),
        trades: [],
      });
      mockFills.push(
        {
          id: 'fill_entry',
          positionId: posId,
          executionRole: 'ENTRY',
          fillPrice: 24000,
          fillQuantity: 10,
          fee: 20,
        },
        {
          id: 'fill_exit',
          positionId: posId,
          executionRole: 'FINAL_EXIT',
          fillPrice: 24200,
          fillQuantity: 10,
          fee: 25,
        },
      );

      const result = await service.reconcileJournal('acc_journal');
      expect(result.auditedPositions).toBe(1);
      expect(result.missingJournalCount).toBe(1);
      expect(result.reconstructedJournals).toBe(1);
      expect(mockTrades.length).toBe(1);

      const createdTrade = mockTrades[0];
      expect(createdTrade.positionId).toBe(posId);
      expect(Number(createdTrade.quantity)).toBe(10);
      expect(Number(createdTrade.entryPrice)).toBe(24000);
      expect(Number(createdTrade.exitPrice)).toBe(24200);
      // Net PnL = (24200 - 24000)*10 - 45 = 1955
      expect(Number(createdTrade.realizedPnL)).toBe(1955);
      expect(createdTrade.exitReason).toBe('Reconciliation Backfill');
    });

    it('detects duplicate PaperTrade records for a position and flags anomaly', async () => {
      const posId = 'pos_dup_journal';
      mockPositions.push({
        id: posId,
        accountId: 'acc_dup',
        symbol: 'BTCUSDT_SPOT',
        contractSymbol: 'BTCUSDT_SPOT',
        direction: 'BULLISH',
        quantity: new Decimal(0),
        status: PositionState.CLOSED,
        trades: [
          { id: 'trade_1', positionId: posId },
          { id: 'trade_2', positionId: posId },
        ],
      });

      const result = await service.reconcileJournal('acc_dup');
      expect(result.duplicateJournals).toBe(1);
      expect(result.anomalies.some((a) => a.includes('duplicate PaperTrade records'))).toBe(true);
    });
  });

  describe('Authoritative Broker Reconciliation', () => {
    it('authoritatively reconciles local SUBMITTED order when broker reports FILLED — updates order and position without resending', async () => {
      const orderId = 'ord_broker_1';
      const execId = 'exec_bot_1';
      mockOrders.push({
        id: orderId,
        accountId: 'acc_broker',
        executionId: execId,
        tradeDecisionId: 'decision_1',
        symbol: 'NIFTY_SPOT',
        status: OrderState.SUBMITTED,
        requestedQuantity: new Decimal(50),
        filledQuantity: new Decimal(0),
        price: new Decimal(24100),
        idempotencyKey: 'idemp_broker_1',
        correlationId: 'corr_broker_1',
      });

      mockPositions.push({
        id: 'pos_broker_1',
        accountId: 'acc_broker',
        orderId,
        symbol: 'NIFTY_SPOT',
        quantity: new Decimal(0),
        entryPrice: new Decimal(24100),
        status: PositionState.PENDING,
      });

      mockExecutions.push({
        id: execId,
        state: 'EXECUTING',
        failureReasonCode: 'RECONCILIATION_REQUIRED',
      });

      const brokerReport = {
        brokerOrderId: 'BROKER_EX_998877',
        orderId,
        symbol: 'NIFTY_SPOT',
        status: 'FILLED' as const,
        filledQuantity: 50,
        averagePrice: 24105.5,
        executedFills: [
          {
            fillId: 'bfill_1',
            price: 24105.5,
            quantity: 50,
            fee: 35.0,
          },
        ],
      };

      const reconResult = await service.reconcileWithBroker(brokerReport);
      expect(reconResult.actionTaken).toBe('UPDATED_LOCAL_STATE');
      expect(reconResult.orderStatus).toBe(OrderState.FILLED);
      expect(reconResult.fillsCreated).toBe(1);
      expect(reconResult.positionUpdated).toBe(true);

      // Verify DB order state updated
      const localOrder = mockOrders.find((o) => o.id === orderId);
      expect(localOrder.status).toBe(OrderState.FILLED);
      expect(Number(localOrder.filledQuantity)).toBe(50);
      expect(Number(localOrder.price)).toBe(24105.5);

      // Verify linked position opened
      const localPos = mockPositions.find((p) => p.orderId === orderId);
      expect(localPos.status).toBe(PositionState.OPEN);
      expect(Number(localPos.quantity)).toBe(50);
      expect(Number(localPos.entryPrice)).toBe(24105.5);

      // Verify execution state resolved from RECONCILIATION_REQUIRED to EXECUTED
      const localExec = mockExecutions.find((e) => e.id === execId);
      expect(localExec.state).toBe('EXECUTED');
      expect(localExec.failureReasonCode).toBeNull();

      // Verify fill record created
      expect(mockFills.length).toBe(1);
      expect(mockFills[0].fillPrice.toNumber()).toBe(24105.5);
    });

    it('returns NO_OP when order and fills are already synchronized with broker', async () => {
      const orderId = 'ord_already_synced';
      mockOrders.push({
        id: orderId,
        status: OrderState.FILLED,
        requestedQuantity: new Decimal(20),
        filledQuantity: new Decimal(20),
        price: new Decimal(100),
      });
      mockFills.push({
        id: 'f_synced',
        orderId,
        fillQuantity: 20,
        fillPrice: 100,
      });

      const brokerReport = {
        brokerOrderId: 'BROKER_SYNC_1',
        orderId,
        symbol: 'BTCUSDT_SPOT',
        status: 'FILLED' as const,
        filledQuantity: 20,
        averagePrice: 100,
      };

      const reconResult = await service.reconcileWithBroker(brokerReport);
      expect(reconResult.actionTaken).toBe('NO_OP');
      expect(reconResult.message).toContain('already synchronized');
    });

    it('reconciles CANCELLED broker status and updates local order', async () => {
      const orderId = 'ord_cancel_sync';
      mockOrders.push({
        id: orderId,
        status: OrderState.SUBMITTED,
        requestedQuantity: new Decimal(10),
        filledQuantity: new Decimal(0),
      });

      const brokerReport = {
        brokerOrderId: 'BROKER_CANCEL_1',
        orderId,
        symbol: 'NIFTY_SPOT',
        status: 'CANCELLED' as const,
        filledQuantity: 0,
      };

      const reconResult = await service.reconcileWithBroker(brokerReport);
      expect(reconResult.actionTaken).toBe('CANCELLED_LOCAL');
      expect(reconResult.orderStatus).toBe(OrderState.CANCELLED);

      const localOrder = mockOrders.find((o) => o.id === orderId);
      expect(localOrder.status).toBe(OrderState.CANCELLED);
    });

    it('reconciles REJECTED broker status and updates local order', async () => {
      const orderId = 'ord_reject_sync';
      mockOrders.push({
        id: orderId,
        status: OrderState.SUBMITTED,
        requestedQuantity: new Decimal(10),
        filledQuantity: new Decimal(0),
      });

      const brokerReport = {
        brokerOrderId: 'BROKER_REJECT_1',
        orderId,
        symbol: 'NIFTY_SPOT',
        status: 'REJECTED' as const,
        filledQuantity: 0,
      };

      const reconResult = await service.reconcileWithBroker(brokerReport);
      expect(reconResult.actionTaken).toBe('REJECTED_LOCAL');
      expect(reconResult.orderStatus).toBe(OrderState.REJECTED);

      const localOrder = mockOrders.find((o) => o.id === orderId);
      expect(localOrder.status).toBe(OrderState.REJECTED);
    });
  });

  describe('Periodic Reconciliation Sweep', () => {
    it('runs periodic audit and self-healing across active accounts and journals', async () => {
      mockAccounts.push({
        id: 'acc_periodic',
        cashBalance: new Decimal(100000),
        usedMargin: new Decimal(500), // Drifting margin vs 0 active positions
        isActive: true,
      });

      const result = await service.runPeriodicReconciliation();
      expect(result.auditedAccounts).toBe(1);
      expect(result.remediated).toBe(true);

      const healedAcc = mockAccounts.find((a) => a.id === 'acc_periodic');
      expect(Number(healedAcc.usedMargin)).toBe(0);
    });
  });

  describe('After Broker Reconnect Sweep', () => {
    it('checks in-flight orders after reconnect and marks fully filled orders as FILLED', async () => {
      const orderId = 'ord_reconnect_1';
      mockOrders.push({
        id: orderId,
        status: OrderState.SUBMITTED,
        requestedQuantity: new Decimal(100),
        filledQuantity: new Decimal(0),
      });
      mockFills.push({
        id: 'fill_rec_1',
        orderId,
        fillQuantity: 100,
        fillPrice: 24000,
      });

      const result = await service.afterBrokerReconnect('ZERODHA');
      expect(result.inFlightOrdersChecked).toBe(1);
      expect(result.reconciled).toBe(1);

      const localOrder = mockOrders.find((o) => o.id === orderId);
      expect(localOrder.status).toBe(OrderState.FILLED);
      expect(Number(localOrder.filledQuantity)).toBe(100);
    });
  });

  describe('After Uncertain Execution', () => {
    it('flags execution as RECONCILIATION_REQUIRED when broker report is not yet available', async () => {
      const execId = 'exec_uncertain_1';
      mockExecutions.push({
        id: execId,
        state: 'EXECUTING',
      });

      const result = await service.afterUncertainExecution(execId);
      expect(result.actionTaken).toBe('UPDATED_LOCAL_STATE');
      expect(result.orderStatus).toBe('RECONCILIATION_REQUIRED');

      const localExec = mockExecutions.find((e) => e.id === execId);
      expect(localExec.failureReasonCode).toBe('RECONCILIATION_REQUIRED');
    });

    it('resolves execution immediately when broker report is provided', async () => {
      const orderId = 'ord_uncertain_resolved';
      mockOrders.push({
        id: orderId,
        status: OrderState.SUBMITTED,
        requestedQuantity: new Decimal(10),
        filledQuantity: new Decimal(0),
        price: new Decimal(100),
      });

      const result = await service.afterUncertainExecution('exec_temp', {
        brokerOrderId: 'BROKER_UNCERTAIN_1',
        orderId,
        symbol: 'BTCUSDT_SPOT',
        status: 'FILLED',
        filledQuantity: 10,
        averagePrice: 100,
      });

      expect(result.actionTaken).toBe('UPDATED_LOCAL_STATE');
      expect(result.orderStatus).toBe(OrderState.FILLED);
    });
  });

  describe('After Worker Recovery Sweep', () => {
    it('recovers stuck CLOSING position to CLOSED if trade record exists', async () => {
      const posId = 'pos_stuck_closing';
      mockPositions.push({
        id: posId,
        status: PositionState.CLOSING,
        trades: [{ id: 'trade_existing', exitTime: new Date() }],
      });

      const result = await service.afterWorkerRecovery('WORKER_1');
      expect(result.positionsChecked).toBe(1);
      expect(result.recovered).toBe(1);

      const recoveredPos = mockPositions.find((p) => p.id === posId);
      expect(recoveredPos.status).toBe(PositionState.CLOSED);
    });

    it('reverts stuck CLOSING position to OPEN if no trade record exists', async () => {
      const posId = 'pos_stuck_revert';
      mockPositions.push({
        id: posId,
        status: PositionState.CLOSING,
        trades: [],
      });

      const result = await service.afterWorkerRecovery('WORKER_1');
      expect(result.positionsChecked).toBe(1);
      expect(result.recovered).toBe(1);

      const recoveredPos = mockPositions.find((p) => p.id === posId);
      expect(recoveredPos.status).toBe(PositionState.OPEN);
    });
  });
});
