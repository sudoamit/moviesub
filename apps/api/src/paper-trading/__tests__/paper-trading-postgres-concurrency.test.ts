import { PrismaClient } from '@prisma/client';
import { PaperPositionMonitorService } from '../paper-position-monitor.service';
import { PaperTradingService } from '../paper-trading.service';
import { RealMarketStreamerService } from '../../market-data/real-market-streamer.service';
import { PrismaService } from '../../common/prisma/prisma.service';

describe('AI FIX 142 — True PostgreSQL Concurrency & Idempotency Integration Test Suite', () => {
  let prismaA: PrismaClient;
  let prismaB: PrismaClient;
  let paperTradingA: PaperTradingService;
  let paperTradingB: PaperTradingService;
  let serviceA: PaperPositionMonitorService;
  let serviceB: PaperPositionMonitorService;

  const DB_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;

  beforeAll(async () => {
    if (!DB_URL) {
      console.warn('⚠️ [INTEGRATION TEST SKIPPED] Neither TEST_DATABASE_URL nor DATABASE_URL environment variable is set.');
      return;
    }

    prismaA = new PrismaClient({ datasources: { db: { url: DB_URL } } });
    prismaB = new PrismaClient({ datasources: { db: { url: DB_URL } } });

    await prismaA.$connect();
    await prismaB.$connect();

    const mockStreamer = {
      getValidatedTicker: (symbol: string) => ({
        symbol,
        price: 52000.0,
        provenance: 'LIVE_PROVIDER' as const,
        marketEventTime: Date.now(),
        lastUpdated: Date.now(),
      }),
      updateTicker: () => {},
    };

    paperTradingA = new PaperTradingService(
      prismaA as unknown as PrismaService,
      null as any,
      mockStreamer as unknown as RealMarketStreamerService,
    );

    paperTradingB = new PaperTradingService(
      prismaB as unknown as PrismaService,
      null as any,
      mockStreamer as unknown as RealMarketStreamerService,
    );

    serviceA = new PaperPositionMonitorService(
      prismaA as unknown as PrismaService,
      paperTradingA,
      mockStreamer as unknown as RealMarketStreamerService,
    );

    serviceB = new PaperPositionMonitorService(
      prismaB as unknown as PrismaService,
      paperTradingB,
      mockStreamer as unknown as RealMarketStreamerService,
    );
  });

  afterAll(async () => {
    if (prismaA) await prismaA.$disconnect();
    if (prismaB) await prismaB.$disconnect();
  });

  it('Requirement 6: Fail-Fast Test Database Configuration — verified TEST_DATABASE_URL / DATABASE_URL presence', () => {
    expect(DB_URL).toBeDefined();
    expect(DB_URL!.length).toBeGreaterThan(0);
  });

  it('Requirement 3 & 10: True TP1 Scale-Out Concurrency — concurrent TP1 scale-out produces exactly 1 order, 1 fill, and 1 accounting settlement via real P2002 constraint', async () => {
    if (!DB_URL) return;

    const testId = `pg_conc_tp1_${Date.now()}`;
    const account = await prismaA.paperAccount.create({
      data: {
        name: `Postgres Concurrency Test Account ${testId}`,
        cashBalance: 500000.0,
        usedMargin: 50000.0,
        realizedPnL: 0.0,
        totalChargesPaid: 0.0,
      },
    });

    const position = await prismaA.paperPosition.create({
      data: {
        accountId: account.id,
        symbol: 'BTCUSDT',
        contractSymbol: 'BTCUSDT',
        instrumentType: 'SPOT',
        direction: 'BULLISH',
        quantity: 10.0,
        entryPrice: 50000.0,
        currentPrice: 50000.0,
        stopLoss: 48000.0,
        target1: 52000.0,
        target2: 55000.0,
        target3: 58000.0,
        status: 'OPEN',
        usedMargin: 50000.0,
        leverage: 1.0,
        correlationId: `corr_${testId}`,
      },
    });

    const target1 = 52000.0;
    const livePrice = 52100.0;
    const marketEventTime = new Date();

    // Execute concurrently across two independent Prisma clients connected to real PostgreSQL
    await Promise.all([
      (serviceA as any).executePartialScaleOut(position, target1, livePrice, marketEventTime),
      (serviceB as any).executePartialScaleOut(position, target1, livePrice, marketEventTime),
    ]);

    const idempotencyKey = `tp1_partial_${position.id}`;

    // 1. Assert exactly 1 TP1 PaperOrder in PostgreSQL
    const orders = await prismaA.paperOrder.findMany({
      where: { idempotencyKey },
    });
    expect(orders.length).toBe(1);

    // 2. Assert exactly 1 TP1 PaperFill in PostgreSQL
    const fills = await prismaA.paperFill.findMany({
      where: { orderId: orders[0].id },
    });
    expect(fills.length).toBe(1);

    // 3. Assert PaperPosition status, quantity, and used margin in PostgreSQL
    const updatedPosition = await prismaA.paperPosition.findUnique({
      where: { id: position.id },
    });
    expect(updatedPosition).not.toBeNull();
    expect(updatedPosition!.status).toBe('PARTIALLY_CLOSED');
    expect(Number(updatedPosition!.quantity)).toBe(5.0);
    expect(Number(updatedPosition!.usedMargin)).toBe(25000.0);

    // Clean up test data
    await prismaA.paperFill.deleteMany({ where: { orderId: orders[0].id } });
    await prismaA.paperOrder.deleteMany({ where: { id: orders[0].id } });
    await prismaA.paperPosition.delete({ where: { id: position.id } });
    await prismaA.paperAccount.delete({ where: { id: account.id } });
  });

  it('Requirement 4 & 7: True Final-Close PostgreSQL Concurrency — concurrent closePosition() calls produce exactly 1 exit order, 1 fill, 1 PaperTrade, and 1 accounting settlement via CLOSING atomic state transition', async () => {
    if (!DB_URL) return;

    const testId = `pg_conc_close_${Date.now()}`;
    const account = await prismaA.paperAccount.create({
      data: {
        name: `Postgres Final Close Concurrency Account ${testId}`,
        cashBalance: 500000.0,
        usedMargin: 50000.0,
        realizedPnL: 0.0,
        totalChargesPaid: 0.0,
      },
    });

    const position = await prismaA.paperPosition.create({
      data: {
        accountId: account.id,
        symbol: 'BTCUSDT',
        contractSymbol: 'BTCUSDT',
        instrumentType: 'SPOT',
        direction: 'BULLISH',
        quantity: 10.0,
        entryPrice: 50000.0,
        currentPrice: 50000.0,
        stopLoss: 48000.0,
        target1: 52000.0,
        status: 'OPEN',
        usedMargin: 50000.0,
        leverage: 1.0,
        correlationId: `corr_${testId}`,
      },
    });

    // Execute closePosition(position.id) concurrently from worker A and worker B against real PostgreSQL
    const results = await Promise.allSettled([
      paperTradingA.closePosition(position.id, 'TP2 Hit'),
      paperTradingB.closePosition(position.id, 'TP2 Hit'),
    ]);

    expect(results.some((r) => r.status === 'fulfilled')).toBe(true);

    // 1. Assert exactly 1 exit order in PostgreSQL
    const exitOrders = await prismaA.paperOrder.findMany({
      where: { accountId: account.id, orderType: 'MARKET' },
    });
    expect(exitOrders.length).toBe(1);

    // 2. Assert exactly 1 exit fill in PostgreSQL
    const exitFills = await prismaA.paperFill.findMany({
      where: { orderId: exitOrders[0].id },
    });
    expect(exitFills.length).toBe(1);

    // 3. Assert exactly 1 PaperTrade in PostgreSQL
    const trades = await prismaA.paperTrade.findMany({
      where: { positionId: position.id },
    });
    expect(trades.length).toBe(1);

    // 4. Assert position status CLOSED and usedMargin 0 in PostgreSQL
    const finalPosition = await prismaA.paperPosition.findUnique({
      where: { id: position.id },
    });
    expect(finalPosition!.status).toBe('CLOSED');

    const finalAccount = await prismaA.paperAccount.findUnique({
      where: { id: account.id },
    });
    expect(Number(finalAccount!.usedMargin)).toBe(0.0);

    // Clean up test data
    await prismaA.paperTrade.deleteMany({ where: { positionId: position.id } });
    await prismaA.paperFill.deleteMany({ where: { orderId: exitOrders[0].id } });
    await prismaA.paperOrder.deleteMany({ where: { id: exitOrders[0].id } });
    await prismaA.paperPosition.delete({ where: { id: position.id } });
    await prismaA.paperAccount.delete({ where: { id: account.id } });
  });

  it('Requirement 4 & 10: PostgreSQL PaperOrder.idempotencyKey UNIQUE constraint — raw duplicate insert throws P2002 exception directly from database', async () => {
    if (!DB_URL) return;

    const testId = `pg_uniq_${Date.now()}`;
    const account = await prismaA.paperAccount.create({
      data: {
        name: `Postgres Uniq Constraint Account ${testId}`,
        cashBalance: 100000.0,
      },
    });

    const idempotencyKey = `raw_dup_${testId}`;

    // First insert succeeds
    await prismaA.paperOrder.create({
      data: {
        accountId: account.id,
        symbol: 'BTCUSDT',
        contractSymbol: 'BTCUSDT',
        direction: 'BULLISH',
        orderType: 'MARKET',
        requestedQuantity: 1.0,
        idempotencyKey,
        correlationId: `corr_${testId}`,
      },
    });

    // Duplicate insert with identical idempotencyKey MUST fail with PostgreSQL P2002 error
    await expect(
      prismaA.paperOrder.create({
        data: {
          accountId: account.id,
          symbol: 'BTCUSDT',
          contractSymbol: 'BTCUSDT',
          direction: 'BULLISH',
          orderType: 'MARKET',
          requestedQuantity: 1.0,
          idempotencyKey,
          correlationId: `corr_${testId}`,
        },
      }),
    ).rejects.toThrow(/P2002/);

    await prismaA.paperOrder.deleteMany({ where: { idempotencyKey } });
    await prismaA.paperAccount.delete({ where: { id: account.id } });
  });
});
