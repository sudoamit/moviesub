import { Direction, PositionState } from '@quant/shared';
import { PaperTradingService } from '../paper-trading.service';

/**
 * - UI orders carry a per-setup idempotency key: a repeated request returns the SAME position (no duplicate).
 * - The breakeven action moves the stop on the SERVER to a fee-adjusted breakeven, tighten-only.
 */
describe('Order idempotency and server-side breakeven', () => {
  let btc = 60000;
  const account = { id: 'acc-idem', currency: 'INR', initialCapital: 1000000, cashBalance: 1000000, usedMargin: 0 };

  const buildService = (prisma: any) => {
    const streamer = {
      getValidatedTicker: () => ({ price: btc, marketEventTime: Date.now() }),
    } as any;
    const service = new PaperTradingService(prisma, {} as any, streamer);
    jest.spyOn(service as any, 'getOrCreateAccount').mockResolvedValue(account);
    jest.spyOn(service as any, 'getSystemConfig').mockResolvedValue({
      emergencyStop: false, maxOpenPositions: 5, maxTradesPerDay: 20, maxConsecutiveLosses: 3,
      maxPositionRiskPercent: 1.0, maxDailyLossPercent: 3.0, maxTotalExposurePercent: 100.0,
      maxLeverage: 5, maxSlippageBps: 0, maxMarketDataAgeSeconds: 5,
    });
    jest.spyOn(service as any, 'rejectOrder').mockResolvedValue(undefined as any);
    jest.spyOn(service as any, 'recordAudit').mockResolvedValue(undefined as any);
    return service;
  };

  describe('duplicate UI order', () => {
    it('a repeated request with the same idempotency key returns the existing position and opens no second one', async () => {
      const orders = new Map<string, any>();
      const prisma: any = {
        paperOrder: {
          findUnique: jest.fn(async ({ where }: any) => orders.get(where.idempotencyKey) ?? null),
          count: jest.fn().mockResolvedValue(0),
          create: jest.fn(async ({ data }: any) => {
            const o = { id: `ord-${orders.size + 1}`, ...data, positions: [] as any[] };
            orders.set(data.idempotencyKey, o);
            return o;
          }),
        },
        paperPosition: {
          count: jest.fn().mockResolvedValue(0),
          findMany: jest.fn().mockResolvedValue([]),
          create: jest.fn(async ({ data }: any) => {
            const p = { id: 'pos-1', ...data };
            orders.get(data.idempotencyKey ?? [...orders.keys()].pop()!)?.positions.push(p);
            return p;
          }),
        },
        paperTrade: { findMany: jest.fn().mockResolvedValue([]) },
        paperFill: { create: jest.fn(async ({ data }: any) => ({ id: 'fill-1', ...data })) },
        paperAccount: { findUnique: jest.fn().mockResolvedValue(account), update: jest.fn() },
        auditEvent: { createMany: jest.fn() },
        $transaction: jest.fn(async (cb: any) => cb(prisma)),
      };
      const service = buildService(prisma);
      const req = {
        symbol: 'BTCUSDT_SPOT', direction: 'BUY' as const, quantity: 0.01, orderType: 'MARKET' as const,
        stopLoss: 59500, target1: 61000, idempotencyKey: 'ui:BTCUSDT_SPOT_BULLISH_sig1:spot:a1',
      };

      const first = await service.placeOrder(req);
      const second = await service.placeOrder(req);

      expect(prisma.paperPosition.create).toHaveBeenCalledTimes(1);
      expect(second.id).toBe(first.id);
    });

    it('two CONCURRENT requests with the same key open one position; the loser replays the winner (no DB error)', async () => {
      const orders = new Map<string, any>();
      const prisma: any = {
        paperOrder: {
          findUnique: jest.fn(async ({ where }: any) => orders.get(where.idempotencyKey) ?? null),
          count: jest.fn().mockResolvedValue(0),
          // the unique index on idempotencyKey: a second insert fails like Postgres/Prisma does
          create: jest.fn(async ({ data }: any) => {
            if (orders.has(data.idempotencyKey)) {
              throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002', meta: { target: ['idempotencyKey'] } });
            }
            const o = { id: `ord-${orders.size + 1}`, ...data, positions: [] as any[] };
            orders.set(data.idempotencyKey, o);
            return o;
          }),
        },
        paperPosition: {
          count: jest.fn().mockResolvedValue(0),
          findMany: jest.fn().mockResolvedValue([]),
          create: jest.fn(async ({ data }: any) => {
            const p = { id: 'pos-race', ...data };
            [...orders.values()].pop()!.positions.push(p);
            return p;
          }),
        },
        paperTrade: { findMany: jest.fn().mockResolvedValue([]) },
        paperFill: { create: jest.fn(async ({ data }: any) => ({ id: 'fill-1', ...data })) },
        paperAccount: { findUnique: jest.fn().mockResolvedValue(account), update: jest.fn() },
        auditEvent: { createMany: jest.fn() },
        $transaction: jest.fn(async (cb: any) => cb(prisma)),
      };
      const service = buildService(prisma);
      const req = {
        symbol: 'BTCUSDT_SPOT', direction: 'BUY' as const, quantity: 0.01, orderType: 'MARKET' as const,
        stopLoss: 59500, target1: 61000, idempotencyKey: 'ui:race:1',
      };

      const [a, b] = await Promise.all([service.placeOrder(req), service.placeOrder(req)]);

      // both passed the pre-check (no order existed yet), the unique key admitted one
      expect(prisma.paperOrder.create).toHaveBeenCalledTimes(2);
      expect(prisma.paperPosition.create).toHaveBeenCalledTimes(1);
      expect(a.id).toBe('pos-race');
      expect(b.id).toBe('pos-race');
    });
  });

  describe('moveStopToBreakeven', () => {
    const openPosition = (overrides: Record<string, any> = {}) => ({
      id: 'pos-be',
      symbol: 'BTCUSDT_SPOT',
      contractSymbol: 'BTCUSDT_SPOT',
      instrumentType: 'SPOT',
      direction: Direction.BULLISH,
      status: PositionState.OPEN,
      quantity: 0.01,
      entryPrice: 60000,
      stopLoss: 59500,
      initialStopLoss: 59500,
      currentPrice: 60000,
      leverage: 1,
      usedMargin: 55500,
      unrealizedPnL: 0,
      unrealizedR: 0,
      maxFavorableExcursion: 0,
      maxAdverseExcursion: 0,
      openedAt: new Date(),
      entryTime: new Date(),
      correlationId: 'corr-be',
      // Entry fee ₹55.50 on 0.01 BTC at fx 92.5 -> 60 USDT per BTC per side -> 120 round trip
      chargesJson: { totalCharges: 55.5 },
      executionEventsJson: { initialQuantity: 0.01, accountingSnapshot: { fxRate: 92.5, contractSize: 1 } },
      ...overrides,
    });

    const prismaFor = (pos: any) => {
      const prisma: any = {
        paperPosition: {
          findUnique: jest.fn().mockResolvedValue(pos),
          update: jest.fn(async ({ data }: any) => ({ ...pos, ...data })),
        },
      };
      return prisma;
    };

    it('moves the stop to entry + per-unit round-trip fees when price is beyond it', async () => {
      const prisma = prismaFor(openPosition());
      const service = buildService(prisma);
      btc = 60500;

      const res = await service.moveStopToBreakeven('pos-be');

      // 2 x 55.5 / (0.01 x 1 x 92.5) = 120 -> breakeven 60,120
      expect(res.stopLoss).toBe(60120);
      expect(prisma.paperPosition.update).toHaveBeenCalledTimes(1);
    });

    it('refuses when the live price has not moved beyond breakeven (stop would trigger immediately)', async () => {
      const prisma = prismaFor(openPosition());
      const service = buildService(prisma);
      btc = 60100; // below the 60,120 breakeven

      await expect(service.moveStopToBreakeven('pos-be')).rejects.toThrow(/has not moved beyond/);
      expect(prisma.paperPosition.update).not.toHaveBeenCalled();
    });

    it('never loosens a stop that is already above breakeven', async () => {
      const prisma = prismaFor(openPosition({ stopLoss: 61000 }));
      const service = buildService(prisma);
      btc = 62000;

      const res = await service.moveStopToBreakeven('pos-be');

      expect(res.stopLoss).toBe(61000);
      expect(prisma.paperPosition.update).not.toHaveBeenCalled();
    });

    it('rejects closed positions', async () => {
      const prisma = prismaFor(openPosition({ status: PositionState.CLOSED }));
      const service = buildService(prisma);
      await expect(service.moveStopToBreakeven('pos-be')).rejects.toThrow(/not found/);
    });
  });

});
