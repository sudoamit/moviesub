import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../../common/prisma/prisma.service';
import { JournalService } from '../journal.service';
import { Direction } from '@quant/shared';
import { Decimal } from '@prisma/client/runtime/library';

describe('JournalService', () => {
  let service: JournalService;
  let mockTrades: any[] = [];

  const mockPrisma: any = {
    paperTrade: {
      findFirst: jest.fn(({ where }) => {
        if (where.positionId) {
          return mockTrades.find((t) => t.positionId === where.positionId) || null;
        }
        return mockTrades[0] || null;
      }),
      findUnique: jest.fn(({ where }) => {
        if (where.id) {
          return mockTrades.find((t) => t.id === where.id) || null;
        }
        return null;
      }),
      create: jest.fn(({ data }) => {
        // Enforce mock uniqueness on positionId
        const existing = mockTrades.find((t) => t.positionId === data.positionId);
        if (existing) {
          const error: any = new Error('Unique constraint failed on the constraint: `paper_trades_positionId_key`');
          error.code = 'P2002';
          throw error;
        }

        const record = {
          id: `trade_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
          ...data,
          createdAt: new Date(),
        };
        mockTrades.push(record);
        return record;
      }),
      findMany: jest.fn(({ where, take, skip, orderBy }) => {
        let list = [...mockTrades];
        if (where?.accountId) {
          list = list.filter((t) => t.accountId === where.accountId);
        }
        if (where?.symbol) {
          list = list.filter((t) => t.symbol === where.symbol);
        }
        if (where?.outcomeClassification) {
          list = list.filter((t) => t.outcomeClassification === where.outcomeClassification);
        }
        if (where?.exitTime?.gte) {
          list = list.filter((t) => new Date(t.exitTime) >= new Date(where.exitTime.gte));
        }
        if (where?.exitTime?.lte) {
          list = list.filter((t) => new Date(t.exitTime) <= new Date(where.exitTime.lte));
        }

        if (orderBy?.exitTime === 'desc') {
          list.sort((a, b) => new Date(b.exitTime).getTime() - new Date(a.exitTime).getTime());
        }

        const start = skip || 0;
        const limit = take !== undefined ? take : list.length;
        return list.slice(start, start + limit);
      }),
      count: jest.fn(({ where }) => {
        let list = [...mockTrades];
        if (where?.positionId) {
          list = list.filter((t) => t.positionId === where.positionId);
        }
        if (where?.accountId) {
          list = list.filter((t) => t.accountId === where.accountId);
        }
        return list.length;
      }),
    },
  };

  beforeEach(async () => {
    mockTrades = [];
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        JournalService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get<JournalService>(JournalService);
  });

  describe('Canonical Journal Entry Creation & Deduplication', () => {
    it('creates exactly one canonical journal entry with full snapshot persistence', async () => {
      const entryTime = new Date(Date.now() - 3600000); // 1 hour ago
      const exitTime = new Date();

      const created = await service.createJournalEntry({
        accountId: 'acc_1',
        positionId: 'pos_1',
        symbol: 'BTCUSDT',
        contractSymbol: 'BTCUSDT',
        instrumentType: 'SPOT',
        direction: Direction.BULLISH,
        quantity: 1.5,
        entryPrice: 60000,
        exitPrice: 63000,
        realizedPnL: 4500,
        realizedR: 2.5,
        fees: 20,
        maxFavorableExcursion: 3200,
        maxAdverseExcursion: 200,
        entryTime,
        exitTime,
        exitReason: 'TAKE_PROFIT_1',
        chargesJson: { brokerage: 15, exchangeFees: 5 },
        signalSnapshotJson: { rsi: 35, macdCross: true },
        featureSnapshotJson: { atr: 150, volatilityRegime: 'NORMAL' },
        outcomeSnapshotJson: { mfePrice: 63200, maePrice: 59800 },
        entryFillAggregationJson: [{ fillId: 'f1', price: 60000, qty: 1.5 }],
        exitFillAggregationJson: [{ fillId: 'f2', price: 63000, qty: 1.5 }],
        outcomeClassification: 'WIN',
        correlationId: 'corr_test_1',
      });

      expect(created.id).toBeDefined();
      expect(created.positionId).toBe('pos_1');
      expect(Number(created.realizedPnL)).toBe(4500);
      expect(Number(created.realizedR)).toBe(2.5);
      expect(created.holdingDurationSeconds).toBe(3600);
      expect(created.chargesJson).toEqual({ brokerage: 15, exchangeFees: 5 });
      expect(created.signalSnapshotJson).toEqual({ rsi: 35, macdCross: true });
      expect(created.outcomeClassification).toBe('WIN');
      expect(mockTrades).toHaveLength(1);
    });

    it('suppresses duplicate journal creation idempotently for the same positionId', async () => {
      const payload = {
        accountId: 'acc_1',
        positionId: 'pos_idem_test',
        symbol: 'NIFTY_SPOT',
        contractSymbol: 'NIFTY_SPOT',
        instrumentType: 'SPOT',
        direction: Direction.BULLISH,
        quantity: 50,
        entryPrice: 24000,
        exitPrice: 24200,
        realizedPnL: 9900,
        fees: 100,
        exitReason: 'TARGET_REACHED',
        correlationId: 'corr_idem',
      };

      const first = await service.createJournalEntry(payload);
      expect(first.id).toBeDefined();

      // Second call should return the exact same record without inserting
      const second = await service.createJournalEntry({
        ...payload,
        realizedPnL: 99999, // Attempts mutation on duplicate call
      });

      expect(second.id).toBe(first.id);
      expect(Number(second.realizedPnL)).toBe(9900); // Unchanged!
      expect(mockTrades).toHaveLength(1);
    });

    it('handles concurrency race condition if parallel threads attempt simultaneous creation', async () => {
      // Simulate parallel race: findFirst initially returns null, but create throws duplicate constraint P2002
      let callCount = 0;
      mockPrisma.paperTrade.findFirst.mockImplementation(({ where }: any) => {
        callCount++;
        // First check in createJournalEntry returns null (not found yet)
        if (callCount === 1) return null;
        // Subsequent checks (inside catch block) find the created record
        return mockTrades.find((t) => t.positionId === where.positionId) || null;
      });

      mockPrisma.paperTrade.create.mockImplementationOnce(() => {
        // Parallel thread inserted just before this thread
        const winner = {
          id: 'trade_winner_parallel',
          positionId: 'pos_race',
          accountId: 'acc_race',
          realizedPnL: new Decimal(500),
          exitTime: new Date(),
        };
        mockTrades.push(winner);
        const error: any = new Error('Unique constraint failed');
        error.code = 'P2002';
        throw error;
      });

      const result = await service.createJournalEntry({
        accountId: 'acc_race',
        positionId: 'pos_race',
        symbol: 'ETHUSDT',
        contractSymbol: 'ETHUSDT',
        instrumentType: 'SPOT',
        direction: Direction.BULLISH,
        quantity: 1,
        entryPrice: 3000,
        exitPrice: 3500,
        realizedPnL: 500,
        fees: 5,
        exitReason: 'RACE_TEST',
        correlationId: 'corr_race',
      });

      expect(result.id).toBe('trade_winner_parallel');
    });
  });

  describe('Journal Queries & Filtering', () => {
    beforeEach(async () => {
      mockTrades.push(
        {
          id: 'trade_q1',
          accountId: 'acc_filter',
          positionId: 'pos_q1',
          symbol: 'BTCUSDT',
          outcomeClassification: 'WIN',
          realizedPnL: new Decimal(1000),
          realizedR: new Decimal(2.0),
          exitTime: new Date('2026-09-10T10:00:00Z'),
        },
        {
          id: 'trade_q2',
          accountId: 'acc_filter',
          positionId: 'pos_q2',
          symbol: 'BTCUSDT',
          outcomeClassification: 'LOSS',
          realizedPnL: new Decimal(-500),
          realizedR: new Decimal(-1.0),
          exitTime: new Date('2026-09-15T12:00:00Z'),
        },
        {
          id: 'trade_q3',
          accountId: 'acc_filter',
          positionId: 'pos_q3',
          symbol: 'ETHUSDT',
          outcomeClassification: 'WIN',
          realizedPnL: new Decimal(300),
          realizedR: new Decimal(1.5),
          exitTime: new Date('2026-09-20T14:00:00Z'),
        },
      );
    });

    it('queries journal by ID and by Position ID', async () => {
      const byId = await service.getJournalById('trade_q1');
      expect(byId?.symbol).toBe('BTCUSDT');

      const byPos = await service.getJournalByPositionId('pos_q2');
      expect(Number(byPos?.realizedPnL)).toBe(-500);

      const notFound = await service.getJournalById('does_not_exist');
      expect(notFound).toBeNull();
    });

    it('filters journals by symbol, outcome, and date ranges', async () => {
      const btcOnly = await service.getJournalsByAccountId('acc_filter', { symbol: 'BTCUSDT' });
      expect(btcOnly).toHaveLength(2);

      const winsOnly = await service.getJournalsByAccountId('acc_filter', { outcomeClassification: 'WIN' });
      expect(winsOnly).toHaveLength(2);

      const dateFiltered = await service.getJournalsByAccountId('acc_filter', {
        startDate: new Date('2026-09-12T00:00:00Z'),
        endDate: new Date('2026-09-18T00:00:00Z'),
      });
      expect(dateFiltered).toHaveLength(1);
      expect(dateFiltered[0].id).toBe('trade_q2');
    });

    it('verifies journal finalization state', async () => {
      expect(await service.isJournalFinalized('pos_q1')).toBe(true);
      expect(await service.isJournalFinalized('pos_open_not_closed')).toBe(false);
    });
  });

  describe('Performance Statistics Aggregation', () => {
    it('handles accounts with zero trades', async () => {
      const stats = await service.getJournalStats('empty_acc');
      expect(stats.totalTrades).toBe(0);
      expect(stats.winRate).toBe(0);
      expect(stats.totalPnlAccount).toBe(0);
      expect(stats.profitFactor).toBe(0);
      expect(stats.averageR).toBe(0);
    });

    it('calculates win rate, profit factor, total PnL, and average R accurately', async () => {
      mockTrades.push(
        {
          id: 't1',
          accountId: 'acc_stats',
          realizedPnL: new Decimal(200),
          realizedR: new Decimal(2.0),
        },
        {
          id: 't2',
          accountId: 'acc_stats',
          realizedPnL: new Decimal(100),
          realizedR: new Decimal(1.0),
        },
        {
          id: 't3',
          accountId: 'acc_stats',
          realizedPnL: new Decimal(-100),
          realizedR: new Decimal(-1.0),
        },
        {
          id: 't4',
          accountId: 'acc_stats',
          realizedPnL: new Decimal(0),
          realizedR: new Decimal(0.0),
        },
      );

      const stats = await service.getJournalStats('acc_stats');
      expect(stats.totalTrades).toBe(4);
      expect(stats.winningTrades).toBe(2);
      expect(stats.losingTrades).toBe(1);
      expect(stats.breakevenTrades).toBe(1);

      // Win rate: 2 / 4 = 50.0%
      expect(stats.winRate).toBe(50.0);

      // Total PnL: 200 + 100 - 100 + 0 = 200
      expect(stats.totalPnlAccount).toBe(200);

      // Profit Factor: Gross Profits (300) / Gross Losses (100) = 3.0
      expect(stats.profitFactor).toBe(3.0);

      // Average R: (2.0 + 1.0 - 1.0 + 0.0) / 4 = 0.5R
      expect(stats.averageR).toBe(0.5);
    });
  });
});
