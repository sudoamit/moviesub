import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { PositionService } from '../position.service';
import { Direction, PositionState } from '@quant/shared';

describe('PositionService', () => {
  let positionService: PositionService;
  let mockPositions: any[] = [];
  let mockFills: any[] = [];

  const mockPrisma: any = {
    paperPosition: {
      create: jest.fn(({ data }) => {
        const p = {
          id: `pos_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
          ...data,
          status: data.status || PositionState.OPEN,
          createdAt: new Date(),
          updatedAt: new Date(),
          fills: [],
        };
        mockPositions.push(p);
        return p;
      }),
      findUnique: jest.fn(({ where, include }) => {
        const p = mockPositions.find((pos) => pos.id === where.id) || null;
        if (!p) return null;
        const copy = { ...p };
        if (include?.fills) {
          copy.fills = mockFills.filter((f) => f.positionId === p.id);
        }
        return copy;
      }),
      findMany: jest.fn(({ where }) => {
        let list = [...mockPositions];
        if (where?.accountId) list = list.filter((p) => p.accountId === where.accountId);
        if (where?.status?.in) list = list.filter((p) => where.status.in.includes(p.status));
        else if (where?.status) list = list.filter((p) => p.status === where.status);
        return list;
      }),
      update: jest.fn(({ where, data }) => {
        const p = mockPositions.find((pos) => pos.id === where.id);
        if (!p) throw new NotFoundException(`Position '${where.id}' not found`);
        Object.assign(p, data, { updatedAt: new Date() });
        return p;
      }),
    },
  };

  beforeEach(async () => {
    mockPositions = [];
    mockFills = [];
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PositionService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    positionService = module.get<PositionService>(PositionService);
  });

  describe('Position Creation & Validation', () => {
    it('creates a position with OPEN status and full parameters', async () => {
      const pos = await positionService.createPosition({
        accountId: 'acc_pos_1',
        symbol: 'BTCUSDT_PERP',
        contractSymbol: 'BTCUSDT_PERP',
        direction: Direction.BULLISH,
        quantity: 2,
        entryPrice: 50000,
        stopLoss: 48000,
        target1: 52000,
        target2: 55000,
        leverage: 10,
        usedMargin: 10000,
        correlationId: 'corr_pos_101',
      });

      expect(pos.id).toMatch(/^pos_/);
      expect(pos.status).toBe(PositionState.OPEN);
      expect(pos.quantity).toBe(2);
      expect(pos.entryPrice).toBe(50000);
      expect(pos.stopLoss).toBe(48000);
      expect(pos.target1).toBe(52000);
      expect(pos.target2).toBe(55000);
    });

    it('rejects position with non-positive quantity or price', async () => {
      await expect(
        positionService.createPosition({
          accountId: 'acc_pos_1',
          symbol: 'BTCUSDT',
          contractSymbol: 'BTCUSDT',
          direction: Direction.BULLISH,
          quantity: 0,
          entryPrice: 50000,
          correlationId: 'c_bad_q',
        }),
      ).rejects.toThrow(BadRequestException);

      await expect(
        positionService.createPosition({
          accountId: 'acc_pos_1',
          symbol: 'BTCUSDT',
          contractSymbol: 'BTCUSDT',
          direction: Direction.BULLISH,
          quantity: 1,
          entryPrice: -100,
          correlationId: 'c_bad_p',
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('Authoritative Fill Projection', () => {
    it('projects position quantities and weighted entry price strictly from fills', async () => {
      const pos = await positionService.createPosition({
        accountId: 'acc_pos_1',
        symbol: 'ETHUSDT',
        contractSymbol: 'ETHUSDT',
        direction: Direction.BULLISH,
        quantity: 2.0,
        entryPrice: 3000,
        correlationId: 'corr_eth',
      });

      // Entry 1: 1.0 ETH @ 3000
      mockFills.push({
        positionId: pos.id,
        executionRole: 'ENTRY',
        fillPrice: 3000,
        fillQuantity: 1.0,
      });

      // Entry 2: 1.0 ETH @ 3200 (Total notional = 6200, VWAP = 3100)
      mockFills.push({
        positionId: pos.id,
        executionRole: 'ENTRY',
        fillPrice: 3200,
        fillQuantity: 1.0,
      });

      // Partial exit: 0.5 ETH @ 3400 (TP1)
      mockFills.push({
        positionId: pos.id,
        executionRole: 'TP1_PARTIAL',
        fillPrice: 3400,
        fillQuantity: 0.5,
      });

      const projection = await positionService.recalculatePositionFromFills(pos.id);
      expect(projection.totalEntryQuantity).toBe(2.0);
      expect(projection.totalExitQuantity).toBe(0.5);
      expect(projection.currentProjectedQuantity).toBe(1.5);
      expect(projection.weightedEntryPrice).toBe(3100);
      expect(projection.isFullyClosed).toBe(false);
    });

    it('detects full closure when cumulative exit fills match entry quantity', async () => {
      const pos = await positionService.createPosition({
        accountId: 'acc_pos_1',
        symbol: 'SOLUSDT',
        contractSymbol: 'SOLUSDT',
        direction: Direction.BULLISH,
        quantity: 10,
        entryPrice: 150,
        correlationId: 'corr_sol',
      });

      mockFills.push({
        positionId: pos.id,
        executionRole: 'ENTRY',
        fillPrice: 150,
        fillQuantity: 10,
      });

      mockFills.push({
        positionId: pos.id,
        executionRole: 'FINAL_EXIT',
        fillPrice: 160,
        fillQuantity: 10,
      });

      const projection = await positionService.recalculatePositionFromFills(pos.id);
      expect(projection.currentProjectedQuantity).toBe(0);
      expect(projection.isFullyClosed).toBe(true);
    });
  });

  describe('Position Synchronization with Fills', () => {
    it('syncs cached position quantity, entryPrice, and PARTIALLY_CLOSED status', async () => {
      const pos = await positionService.createPosition({
        accountId: 'acc_pos_1',
        symbol: 'BTCUSDT',
        contractSymbol: 'BTCUSDT',
        direction: Direction.BULLISH,
        quantity: 1.0,
        entryPrice: 50000,
        correlationId: 'c_sync_1',
      });

      mockFills.push({
        positionId: pos.id,
        executionRole: 'ENTRY',
        fillPrice: 50000,
        fillQuantity: 1.0,
      });

      mockFills.push({
        positionId: pos.id,
        executionRole: 'TP1_PARTIAL',
        fillPrice: 53000,
        fillQuantity: 0.4,
      });

      const synced = await positionService.syncPositionWithFills(pos.id);
      expect(synced.quantity).toBe(0.6);
      expect(synced.status).toBe(PositionState.PARTIALLY_CLOSED);
    });

    it('syncs position to CLOSED status when fills indicate 100% exit', async () => {
      const pos = await positionService.createPosition({
        accountId: 'acc_pos_1',
        symbol: 'BTCUSDT',
        contractSymbol: 'BTCUSDT',
        direction: Direction.BULLISH,
        quantity: 1.0,
        entryPrice: 50000,
        correlationId: 'c_sync_2',
      });

      mockFills.push({
        positionId: pos.id,
        executionRole: 'ENTRY',
        fillPrice: 50000,
        fillQuantity: 1.0,
      });

      mockFills.push({
        positionId: pos.id,
        executionRole: 'FINAL_EXIT',
        fillPrice: 55000,
        fillQuantity: 1.0,
      });

      const synced = await positionService.syncPositionWithFills(pos.id);
      expect(synced.quantity).toBe(0);
      expect(synced.status).toBe(PositionState.CLOSED);
      expect(synced.closedAt).toBeDefined();
    });
  });

  describe('Risk & Target Adjustments', () => {
    it('updates stop loss on open position and rejects non-positive value', async () => {
      const pos = await positionService.createPosition({
        accountId: 'acc_pos_1',
        symbol: 'BTCUSDT',
        contractSymbol: 'BTCUSDT',
        direction: Direction.BULLISH,
        quantity: 1,
        entryPrice: 50000,
        stopLoss: 48000,
        correlationId: 'c_sl',
      });

      const updated = await positionService.updateStopLoss(pos.id, 49000);
      expect(updated.stopLoss).toBe(49000);

      await expect(positionService.updateStopLoss(pos.id, 0)).rejects.toThrow(BadRequestException);
    });

    it('updates take profit targets on open position', async () => {
      const pos = await positionService.createPosition({
        accountId: 'acc_pos_1',
        symbol: 'BTCUSDT',
        contractSymbol: 'BTCUSDT',
        direction: Direction.BULLISH,
        quantity: 1,
        entryPrice: 50000,
        correlationId: 'c_tp',
      });

      const updated = await positionService.updateTargets(pos.id, {
        target1: 52000,
        target2: 55000,
        target3: 60000,
      });

      expect(updated.target1).toBe(52000);
      expect(updated.target2).toBe(55000);
      expect(updated.target3).toBe(60000);
    });

    it('rejects target and stop-loss updates on CLOSED position', async () => {
      const pos = await positionService.createPosition({
        accountId: 'acc_pos_1',
        symbol: 'BTCUSDT',
        contractSymbol: 'BTCUSDT',
        direction: Direction.BULLISH,
        quantity: 1,
        entryPrice: 50000,
        correlationId: 'c_close',
      });

      await positionService.closePosition(pos.id);

      await expect(positionService.updateStopLoss(pos.id, 49000)).rejects.toThrow(ConflictException);
      await expect(
        positionService.updateTargets(pos.id, { target1: 55000 }),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('Authoritative Position Queries', () => {
    it('returns only active positions when calling getActivePositions', async () => {
      const p1 = await positionService.createPosition({
        accountId: 'acc_query_pos',
        symbol: 'BTCUSDT',
        contractSymbol: 'BTCUSDT',
        direction: Direction.BULLISH,
        quantity: 1,
        entryPrice: 50000,
        correlationId: 'c_q1',
      });

      const p2 = await positionService.createPosition({
        accountId: 'acc_query_pos',
        symbol: 'ETHUSDT',
        contractSymbol: 'ETHUSDT',
        direction: Direction.BULLISH,
        quantity: 5,
        entryPrice: 3000,
        correlationId: 'c_q2',
      });

      await positionService.closePosition(p2.id);

      const active = await positionService.getActivePositions('acc_query_pos');
      expect(active.length).toBe(1);
      expect(active[0].id).toBe(p1.id);

      const all = await positionService.getPositionsByAccountId('acc_query_pos');
      expect(all.length).toBe(2);
    });
  });
});
