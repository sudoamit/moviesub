import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { FillService } from '../fill.service';
import { OrderState, Direction } from '@quant/shared';

describe('FillService', () => {
  let fillService: FillService;
  let mockFills: any[] = [];
  let mockOrders: any[] = [];

  const mockPrisma: any = {
    paperOrder: {
      findUnique: jest.fn(({ where }) => mockOrders.find((o) => o.id === where.id) || null),
      update: jest.fn(({ where, data }) => {
        const o = mockOrders.find((ord) => ord.id === where.id);
        if (!o) throw new NotFoundException(`Order '${where.id}' not found`);
        Object.assign(o, data, { updatedAt: new Date() });
        return o;
      }),
    },
    paperFill: {
      create: jest.fn(({ data }) => {
        const fill = {
          id: `fill_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
          ...data,
          createdAt: new Date(),
        };
        mockFills.push(fill);
        return fill;
      }),
      findMany: jest.fn(({ where }) => {
        let list = [...mockFills];
        if (where?.orderId) list = list.filter((f) => f.orderId === where.orderId);
        if (where?.positionId) list = list.filter((f) => f.positionId === where.positionId);
        if (where?.executionRole) {
          if (typeof where.executionRole === 'string') {
            list = list.filter((f) => f.executionRole === where.executionRole);
          } else if (where.executionRole.in) {
            list = list.filter((f) => where.executionRole.in.includes(f.executionRole));
          }
        }
        return list;
      }),
    },
    $transaction: jest.fn(async (cb) => cb(mockPrisma)),
  };

  beforeEach(async () => {
    mockFills = [];
    mockOrders = [];
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FillService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    fillService = module.get<FillService>(FillService);
  });

  describe('Fill Recording & Validation', () => {
    it('records an immutable fill and validates parameters', async () => {
      mockOrders.push({
        id: 'ord_1',
        symbol: 'BTCUSDT',
        direction: Direction.BULLISH,
        requestedQuantity: 1,
        filledQuantity: 0,
        price: 50000,
        status: OrderState.SUBMITTED,
      });

      const fill = await fillService.recordFill({
        orderId: 'ord_1',
        positionId: 'pos_1',
        executionRole: 'ENTRY',
        fillPrice: 50010,
        fillQuantity: 1,
        fee: 15.5,
        sourceTimestamp: new Date(),
        correlationId: 'corr_fill_1',
      });

      expect(fill.id).toMatch(/^fill_/);
      expect(fill.fillPrice).toBe(50010);
      expect(fill.fillQuantity).toBe(1);
      expect(fill.fee).toBe(15.5);
      expect(fill.executionRole).toBe('ENTRY');
      expect(mockFills.length).toBe(1);
    });

    it('rejects fill with non-positive price or quantity', async () => {
      await expect(
        fillService.recordFill({
          orderId: 'ord_1',
          fillPrice: 0,
          fillQuantity: 1,
          sourceTimestamp: new Date(),
          correlationId: 'corr_bad_price',
        }),
      ).rejects.toThrow(BadRequestException);

      await expect(
        fillService.recordFill({
          orderId: 'ord_1',
          fillPrice: 50000,
          fillQuantity: -2,
          sourceTimestamp: new Date(),
          correlationId: 'corr_bad_qty',
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('Atomic Order Synchronization', () => {
    it('updates parent order filledQuantity and advances status to PARTIALLY_FILLED and FILLED', async () => {
      const order = {
        id: 'ord_sync_test',
        symbol: 'NIFTY_SPOT',
        direction: Direction.BULLISH,
        requestedQuantity: 100,
        filledQuantity: 0,
        price: 24000,
        status: OrderState.SUBMITTED,
        firstFillAt: null,
      };
      mockOrders.push(order);

      // Fill 1: 40 units
      await fillService.recordFill({
        orderId: 'ord_sync_test',
        positionId: 'pos_sync_1',
        executionRole: 'ENTRY',
        fillPrice: 24002,
        fillQuantity: 40,
        sourceTimestamp: new Date(),
        correlationId: 'corr_f1',
      });

      expect(Number(order.filledQuantity)).toBe(40);
      expect(order.status).toBe(OrderState.PARTIALLY_FILLED);
      expect(order.firstFillAt).toBeDefined();

      // Fill 2: 60 units (remaining)
      await fillService.recordFill({
        orderId: 'ord_sync_test',
        positionId: 'pos_sync_1',
        executionRole: 'ENTRY',
        fillPrice: 24004,
        fillQuantity: 60,
        sourceTimestamp: new Date(),
        correlationId: 'corr_f2',
      });

      expect(Number(order.filledQuantity)).toBe(100);
      expect(order.status).toBe(OrderState.FILLED);
    });

    it('rejects overfills when cumulative fill exceeds requested order quantity', async () => {
      const order = {
        id: 'ord_overfill',
        symbol: 'BANKNIFTY',
        direction: Direction.BULLISH,
        requestedQuantity: 50,
        filledQuantity: 30,
        price: 50000,
        status: OrderState.PARTIALLY_FILLED,
      };
      mockOrders.push(order);

      // Attempting to fill 25 more units (30 + 25 = 55 > 50)
      await expect(
        fillService.recordFill({
          orderId: 'ord_overfill',
          fillPrice: 50000,
          fillQuantity: 25,
          sourceTimestamp: new Date(),
          correlationId: 'corr_overfill',
        }),
      ).rejects.toThrow(ConflictException);

      // Order filledQuantity remains 30
      expect(Number(order.filledQuantity)).toBe(30);
    });
  });

  describe('Slippage Calculation', () => {
    it('calculates slippage against expected/order price taking direction into account', async () => {
      // Long order @ 100, filled @ 102 -> +2 unfavorable slippage
      mockOrders.push({
        id: 'ord_buy_slip',
        symbol: 'ABC',
        direction: Direction.BULLISH,
        requestedQuantity: 10,
        filledQuantity: 0,
        price: 100,
        status: OrderState.SUBMITTED,
      });

      const fillBuy = await fillService.recordFill({
        orderId: 'ord_buy_slip',
        fillPrice: 102,
        fillQuantity: 10,
        sourceTimestamp: new Date(),
        correlationId: 'corr_slip_buy',
      });
      expect(fillBuy.slippage).toBe(2);

      // Short order @ 200, filled @ 197 -> +3 unfavorable slippage
      mockOrders.push({
        id: 'ord_sell_slip',
        symbol: 'XYZ',
        direction: Direction.BEARISH,
        requestedQuantity: 10,
        filledQuantity: 0,
        price: 200,
        status: OrderState.SUBMITTED,
      });

      const fillSell = await fillService.recordFill({
        orderId: 'ord_sell_slip',
        fillPrice: 197,
        fillQuantity: 10,
        sourceTimestamp: new Date(),
        correlationId: 'corr_slip_sell',
      });
      expect(fillSell.slippage).toBe(3);
    });
  });

  describe('Execution Role Attribution & Aggregations', () => {
    it('separates entry and exit fills for a position', async () => {
      mockOrders.push({
        id: 'ord_pos_fills',
        symbol: 'BTCUSDT',
        direction: Direction.BULLISH,
        requestedQuantity: 100,
        filledQuantity: 0,
        price: 60000,
        status: OrderState.SUBMITTED,
      });

      // 1. Entry fill
      await fillService.recordFill({
        orderId: 'ord_pos_fills',
        positionId: 'pos_multi',
        executionRole: 'ENTRY',
        fillPrice: 60000,
        fillQuantity: 50,
        fee: 10,
        sourceTimestamp: new Date(),
        correlationId: 'c_entry',
      });

      // 2. TP1 Partial Exit
      await fillService.recordFill({
        orderId: 'ord_pos_fills',
        positionId: 'pos_multi',
        executionRole: 'TP1_PARTIAL',
        fillPrice: 61000,
        fillQuantity: 25,
        fee: 5,
        sourceTimestamp: new Date(),
        correlationId: 'c_tp1',
      });

      const entryFills = await fillService.getEntryFillsForPosition('pos_multi');
      const exitFills = await fillService.getExitFillsForPosition('pos_multi');

      expect(entryFills.length).toBe(1);
      expect(entryFills[0].executionRole).toBe('ENTRY');

      expect(exitFills.length).toBe(1);
      expect(exitFills[0].executionRole).toBe('TP1_PARTIAL');
    });

    it('calculates VWAP, total quantity, and total fees across fills', () => {
      const fills: any[] = [
        { fillPrice: 100, fillQuantity: 10, fee: 5 },  // 1000
        { fillPrice: 110, fillQuantity: 20, fee: 10 }, // 2200
        { fillPrice: 120, fillQuantity: 30, fee: 15 }, // 3600
      ]; // Total notional: 6800, Total quantity: 60 -> VWAP: 6800/60 = 113.3333

      const vwap = fillService.calculateWeightedAveragePrice(fills);
      expect(vwap).toBe(113.3333);

      const totalQty = fillService.getTotalFillQuantity(fills);
      expect(totalQty).toBe(60);

      const totalFees = fillService.getTotalFillFees(fills);
      expect(totalFees).toBe(30);
    });
  });
});
