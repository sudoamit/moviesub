import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { OrderService } from '../order.service';
import { Direction, OrderState } from '@quant/shared';

describe('OrderService', () => {
  let orderService: OrderService;
  let mockOrders: any[] = [];

  const mockPrisma: any = {
    paperOrder: {
      create: jest.fn(({ data }) => {
        const order = {
          id: `ord_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
          ...data,
          status: data.status || OrderState.SUBMITTED,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        mockOrders.push(order);
        return order;
      }),
      findUnique: jest.fn(({ where }) => {
        if (where.id) return mockOrders.find((o) => o.id === where.id) || null;
        if (where.idempotencyKey) return mockOrders.find((o) => o.idempotencyKey === where.idempotencyKey) || null;
        return null;
      }),
      findFirst: jest.fn(({ where }) => {
        if (where?.OR) {
          for (const clause of where.OR) {
            if (clause.correlationId) {
              const found = mockOrders.find((o) => o.correlationId === clause.correlationId);
              if (found) return found;
            }
            if (clause.idempotencyKey) {
              const found = mockOrders.find((o) => o.idempotencyKey === clause.idempotencyKey);
              if (found) return found;
            }
          }
        }
        return mockOrders[0] || null;
      }),
      findMany: jest.fn(({ where }) => {
        let list = [...mockOrders];
        if (where?.accountId) list = list.filter((o) => o.accountId === where.accountId);
        if (where?.status?.in) list = list.filter((o) => where.status.in.includes(o.status));
        else if (where?.status) list = list.filter((o) => o.status === where.status);
        return list;
      }),
      update: jest.fn(({ where, data }) => {
        const o = mockOrders.find((ord) => ord.id === where.id);
        if (!o) throw new NotFoundException(`Order '${where.id}' not found`);
        Object.assign(o, data, { updatedAt: new Date() });
        return o;
      }),
    },
  };

  beforeEach(async () => {
    mockOrders = [];
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OrderService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    orderService = module.get<OrderService>(OrderService);
  });

  describe('Order Creation & Validation', () => {
    it('creates an order with full metadata and default SUBMITTED state', async () => {
      const order = await orderService.createOrder({
        accountId: 'acc_order_1',
        symbol: 'BTCUSDT_PERP',
        direction: Direction.BULLISH,
        orderType: 'LIMIT',
        requestedQuantity: 0.5,
        price: 60000,
        leverage: 10,
        idempotencyKey: 'client_ord_101',
        correlationId: 'corr_101',
      });

      expect(order.id).toMatch(/^ord_/);
      expect(order.symbol).toBe('BTCUSDT_PERP');
      expect(order.status).toBe(OrderState.SUBMITTED);
      expect(order.requestedQuantity).toBe(0.5);
      expect(order.price).toBe(60000);
      expect(order.leverage).toBe(10);
      expect(order.idempotencyKey).toBe('client_ord_101');
    });

    it('rejects order with non-positive quantity', async () => {
      await expect(
        orderService.createOrder({
          accountId: 'acc_order_1',
          symbol: 'BTCUSDT',
          direction: Direction.BULLISH,
          requestedQuantity: 0,
          idempotencyKey: 'key_invalid_qty',
          correlationId: 'corr_inv_qty',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects LIMIT order with missing or non-positive price', async () => {
      await expect(
        orderService.createOrder({
          accountId: 'acc_order_1',
          symbol: 'BTCUSDT',
          direction: Direction.BULLISH,
          orderType: 'LIMIT',
          requestedQuantity: 1,
          price: 0,
          idempotencyKey: 'key_zero_price',
          correlationId: 'corr_zp',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('returns existing order idempotently when identical idempotencyKey is submitted', async () => {
      const first = await orderService.createOrder({
        accountId: 'acc_order_1',
        symbol: 'NIFTY_SPOT',
        direction: Direction.BULLISH,
        requestedQuantity: 50,
        idempotencyKey: 'client_ord_dup',
        correlationId: 'corr_dup',
      });

      const second = await orderService.createOrder({
        accountId: 'acc_order_1',
        symbol: 'NIFTY_SPOT',
        direction: Direction.BULLISH,
        requestedQuantity: 50,
        idempotencyKey: 'client_ord_dup',
        correlationId: 'corr_dup',
      });

      expect(second.id).toBe(first.id);
      expect(mockOrders.length).toBe(1); // No duplicate DB row
    });
  });

  describe('Lifecycle State Machine Transitions', () => {
    it('transitions SUBMITTED -> ACKNOWLEDGED -> PARTIALLY_FILLED -> FILLED', async () => {
      const order = await orderService.createOrder({
        accountId: 'acc_order_1',
        symbol: 'BANKNIFTY',
        direction: Direction.BULLISH,
        requestedQuantity: 30,
        idempotencyKey: 'client_ord_flow',
        correlationId: 'corr_flow',
      });

      // 1. Acknowledged
      const ack = await orderService.updateOrderStatus(order.id, OrderState.ACKNOWLEDGED);
      expect(ack.status).toBe(OrderState.ACKNOWLEDGED);

      // 2. Partial Fill (15 of 30)
      const partial = await orderService.updateOrderStatus(order.id, OrderState.PARTIALLY_FILLED, {
        filledQuantity: 15,
      });
      expect(partial.status).toBe(OrderState.PARTIALLY_FILLED);
      expect(partial.filledQuantity).toBe(15);
      expect(partial.firstFillAt).toBeDefined();

      // 3. Complete Fill (30 of 30)
      const filled = await orderService.updateOrderStatus(order.id, OrderState.FILLED, {
        filledQuantity: 30,
      });
      expect(filled.status).toBe(OrderState.FILLED);
      expect(filled.filledQuantity).toBe(30);
    });

    it('is idempotent on repeated status updates to the same state', async () => {
      const order = await orderService.createOrder({
        accountId: 'acc_order_1',
        symbol: 'BTCUSDT',
        direction: Direction.BULLISH,
        requestedQuantity: 1,
        idempotencyKey: 'client_ord_idem',
        correlationId: 'corr_idem',
      });

      await orderService.updateOrderStatus(order.id, OrderState.ACKNOWLEDGED);
      const repeat = await orderService.updateOrderStatus(order.id, OrderState.ACKNOWLEDGED);
      expect(repeat.status).toBe(OrderState.ACKNOWLEDGED);
    });

    it('rejects illegal order transitions with ConflictException', async () => {
      const order = await orderService.createOrder({
        accountId: 'acc_order_1',
        symbol: 'ETHUSDT',
        direction: Direction.BULLISH,
        requestedQuantity: 2,
        idempotencyKey: 'client_ord_illegal',
        correlationId: 'corr_ill',
      });

      await orderService.updateOrderStatus(order.id, OrderState.FILLED, { filledQuantity: 2 });

      // Illegal: FILLED order cannot be cancelled
      await expect(orderService.cancelOrder(order.id)).rejects.toThrow(ConflictException);

      // Illegal: FILLED order cannot transition to SUBMITTED
      await expect(orderService.updateOrderStatus(order.id, OrderState.SUBMITTED)).rejects.toThrow(
        ConflictException,
      );
    });
  });

  describe('Order Cancellation', () => {
    it('cancels active order and records cancelledAt timestamp', async () => {
      const order = await orderService.createOrder({
        accountId: 'acc_order_1',
        symbol: 'SOLUSDT',
        direction: Direction.BULLISH,
        requestedQuantity: 10,
        idempotencyKey: 'client_ord_cancel',
        correlationId: 'corr_cancel',
      });

      const cancelled = await orderService.cancelOrder(order.id, 'USER_REQUESTED_CANCEL');
      expect(cancelled.status).toBe(OrderState.CANCELLED);
      expect(cancelled.cancelledAt).toBeDefined();

      // Repeated cancel is idempotent
      const repeat = await orderService.cancelOrder(order.id);
      expect(repeat.status).toBe(OrderState.CANCELLED);
    });
  });

  describe('Authoritative Order Queries', () => {
    it('queries active orders and filters completed ones', async () => {
      // Create 1 active order and 1 filled order
      const ord1 = await orderService.createOrder({
        accountId: 'acc_query_test',
        symbol: 'BTCUSDT',
        direction: Direction.BULLISH,
        requestedQuantity: 1,
        idempotencyKey: 'q_ord_1',
        correlationId: 'c_q1',
      });

      const ord2 = await orderService.createOrder({
        accountId: 'acc_query_test',
        symbol: 'ETHUSDT',
        direction: Direction.BEARISH,
        requestedQuantity: 5,
        idempotencyKey: 'q_ord_2',
        correlationId: 'c_q2',
      });

      await orderService.updateOrderStatus(ord2.id, OrderState.FILLED, { filledQuantity: 5 });

      const activeOrders = await orderService.getActiveOrdersForAccount('acc_query_test');
      expect(activeOrders.length).toBe(1);
      expect(activeOrders[0].id).toBe(ord1.id);

      const allOrders = await orderService.getOrdersByAccountId('acc_query_test');
      expect(allOrders.length).toBe(2);

      const byClient = await orderService.getOrderByClientOrderId('q_ord_1');
      expect(byClient?.id).toBe(ord1.id);

      const byBroker = await orderService.getOrderByBrokerOrderId('c_q1');
      expect(byBroker?.id).toBe(ord1.id);
    });
  });
});
