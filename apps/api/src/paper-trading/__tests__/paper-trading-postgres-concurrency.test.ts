import { PrismaClient } from '@prisma/client';
import { PaperPositionMonitorService } from '../paper-position-monitor.service';
import { PaperTradingService } from '../paper-trading.service';
import { RealMarketStreamerService } from '../../market-data/real-market-streamer.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  PointInTimeCurrencyConverter,
  buildAccountingSnapshot,
  getAuthoritativeInstrument,
  resolveMarginModel,
} from '@quant/shared';

/**
 * Makes `model.method` throw INSIDE interactive transactions on this client. The service writes through the
 * transaction's own client (`tx`), so patching the top-level delegate (as these tests used to) never reached the
 * code under test and the "rollback" was never exercised. Returns a function that restores the original.
 */
function forceFailureInsideTransaction(prisma: any, model: string, method: string, message: string): () => void {
  const original = prisma.$transaction;
  prisma.$transaction = (arg: any, opts?: any) => {
    if (typeof arg !== 'function') return original.call(prisma, arg, opts);
    return original.call(
      prisma,
      (tx: any) =>
        arg(
          new Proxy(tx, {
            get(target, key) {
              if (key !== model) return target[key];
              return new Proxy(target[key], {
                get(delegate, m) {
                  return m === method
                    ? () => {
                        throw new Error(message);
                      }
                    : delegate[m];
                },
              });
            },
          }),
        ),
      opts,
    );
  };
  return () => {
    prisma.$transaction = original;
  };
}

describe('AI FIX 143 — True PostgreSQL Concurrency & Idempotency Integration Test Suite', () => {
  let prismaA: PrismaClient;
  let prismaB: PrismaClient;
  let paperTradingA: PaperTradingService;
  let paperTradingB: PaperTradingService;
  let serviceA: PaperPositionMonitorService;
  let serviceB: PaperPositionMonitorService;

  const DB_URL = process.env.TEST_DATABASE_URL;

  beforeAll(async () => {
    if (process.env.CI && !DB_URL) {
      throw new Error(
        '❌ [FAIL-FAST CI CONFIG] TEST_DATABASE_URL environment variable is required for integration tests in CI environment.',
      );
    }

    if (!DB_URL) {
      console.warn(
        '⚠️ [INTEGRATION TEST SKIPPED] TEST_DATABASE_URL environment variable is not set. Skipped PostgreSQL integration suite.',
      );
      return;
    }

    PointInTimeCurrencyConverter.getInstance().seedFixtureRates([
      { pair: 'USDT/INR', rate: 92.0, timestamp: 0, source: 'TEST_FIXTURE', version: '1.0' },
      { pair: 'USD/INR', rate: 87.0, timestamp: 0, source: 'TEST_FIXTURE', version: '1.0' },
    ]);

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

  it('Requirement 6 & 14: Test Database Execution Guarantee — verified TEST_DATABASE_URL / DATABASE_URL presence', () => {
    if (process.env.CI) {
      expect(DB_URL).toBeDefined();
      expect(DB_URL!.length).toBeGreaterThan(0);
    }
  });

  it('Requirement 5 & 12: True TP1 Scale-Out Concurrency — concurrent TP1 scale-out produces exactly 1 order, 1 fill, and 1 accounting settlement via real P2002 constraint with try/finally cleanup', async () => {
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

    const inst1 = getAuthoritativeInstrument('BTCUSDT');
    const entryTime1 = new Date();
    const snap1 = buildAccountingSnapshot({
      accountCurrency: 'INR',
      quoteCurrency: 'USDT',
      fxResult: PointInTimeCurrencyConverter.getInstance().getRate(
        'USDT',
        'INR',
        entryTime1.getTime(),
      ),
      contractSize: 1,
      lotSize: 10.0,
      resolvedMarginModel: resolveMarginModel(inst1, { requestedLeverage: 1 }),
      calculatedAt: entryTime1.getTime(),
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
        executionEventsJson: { accountingSnapshot: snap1 as any },
        featureSnapshotJson: { accountingSnapshot: snap1 as any },
      },
    });

    const target1 = 52000.0;
    const livePrice = 52100.0;
    const marketEventTime = new Date();
    // Current policy: TP1 takes 30% (DEFAULT_PARTIAL_EXIT_POLICY 30/30/40) under the key `tp1_partial:<id>`.
    // (This test was written for a 50% TP1 and the key `tp1_partial_<id>`; both changed since.)
    const idempotencyKey = `tp1_partial:${position.id}`;

    try {
      // Execute concurrently across two independent Prisma clients connected to real PostgreSQL
      await Promise.all([
        (serviceA as any).executePartialScaleOut(position, 'TP1', target1, livePrice, marketEventTime),
        (serviceB as any).executePartialScaleOut(position, 'TP1', target1, livePrice, marketEventTime),
      ]);

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
      expect(Number(updatedPosition!.quantity)).toBe(7.0); // 10 - 30%
      expect(Number(updatedPosition!.usedMargin)).toBe(35000.0); // 70% of 50,000

      // 4. Assert PaperAccount balance, realized P&L, and charges mutated exactly ONCE
      const updatedAccount = await prismaA.paperAccount.findUnique({
        where: { id: account.id },
      });
      const exitTurnover = 52100.0 * 3.0; // USDT
      const btcFxRate = PointInTimeCurrencyConverter.getInstance().getRate(
        'USDT',
        'INR',
        Date.now(),
      ).fxRate;
      // Charges in INR from the canonical schedule: 0.1% spot fee on the USDT turnover, converted at the FX rate.
      // (The old legacy call calculateCharges(turnover, true) skipped the USDT->INR conversion and expected Rs 156.30
      // instead of Rs 14,379.60.)
      const exitCharges = paperTradingA.calculateCharges(exitTurnover, 'CRYPTO', btcFxRate, Date.now(), 'EXIT', 'BTCUSDT_SPOT');
      const expectedPartialNetPnL = Number(
        ((52100 - 50000) * btcFxRate * 3.0 - exitCharges.totalCharges).toFixed(2),
      );

      expect(Number(updatedAccount!.realizedPnL)).toBeCloseTo(expectedPartialNetPnL, 2);
      expect(Number(updatedAccount!.cashBalance) - 500000.0).toBeCloseTo(expectedPartialNetPnL, 2);
      expect(Number(updatedAccount!.usedMargin)).toBe(35000.0);
      expect(Number(updatedAccount!.totalChargesPaid)).toBeCloseTo(exitCharges.totalCharges, 2);
    } finally {
      // Cleanup in FK dependency order: PaperFill -> PaperOrder -> PaperPosition -> PaperAccount
      await prismaA.paperFill.deleteMany({
        where: {
          orderId: {
            in: (await prismaA.paperOrder.findMany({ where: { accountId: account.id } })).map(
              (o) => o.id,
            ),
          },
        },
      });
      await prismaA.paperOrder.deleteMany({ where: { accountId: account.id } });
      await prismaA.paperPosition.deleteMany({ where: { accountId: account.id } });
      await prismaA.paperAccount.delete({ where: { id: account.id } });
    }
  });

  it('Requirement 4, 10, 11: True Final-Close PostgreSQL Concurrency — concurrent closePosition() calls produce exactly 1 exit order, 1 fill, 1 PaperTrade, same canonical trade return, and zero duplicate ledger mutation', async () => {
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

    const inst2 = getAuthoritativeInstrument('BTCUSDT');
    const entryTime2 = new Date();
    const snap2 = buildAccountingSnapshot({
      accountCurrency: 'INR',
      quoteCurrency: 'USDT',
      fxResult: PointInTimeCurrencyConverter.getInstance().getRate(
        'USDT',
        'INR',
        entryTime2.getTime(),
      ),
      contractSize: 1,
      lotSize: 10.0,
      resolvedMarginModel: resolveMarginModel(inst2, { requestedLeverage: 1 }),
      calculatedAt: entryTime2.getTime(),
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
        executionEventsJson: { accountingSnapshot: snap2 as any },
        featureSnapshotJson: { accountingSnapshot: snap2 as any },
      },
    });

    try {
      // Execute closePosition(position.id) concurrently from worker A and worker B against real PostgreSQL
      const results = await Promise.allSettled([
        paperTradingA.closePosition(position.id, 'TP2 Hit'),
        paperTradingB.closePosition(position.id, 'TP2 Hit'),
      ]);

      const fulfilled = results.filter(
        (r): r is PromiseFulfilledResult<any> => r.status === 'fulfilled',
      );
      expect(fulfilled.length).toBeGreaterThanOrEqual(1);

      if (fulfilled.length === 2) {
        // Both workers returned canonical PaperTrade
        expect(fulfilled[0].value.id).toBe(fulfilled[1].value.id);
      }

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
    } finally {
      // Cleanup in FK dependency order: PaperTrade -> PaperFill -> PaperOrder -> PaperPosition -> PaperAccount
      await prismaA.paperTrade.deleteMany({ where: { positionId: position.id } });
      await prismaA.paperFill.deleteMany({
        where: {
          orderId: {
            in: (await prismaA.paperOrder.findMany({ where: { accountId: account.id } })).map(
              (o) => o.id,
            ),
          },
        },
      });
      await prismaA.paperOrder.deleteMany({ where: { accountId: account.id } });
      await prismaA.paperPosition.deleteMany({ where: { accountId: account.id } });
      await prismaA.paperAccount.delete({ where: { id: account.id } });
    }
  });

  it('Requirement 4 & 13: PostgreSQL PaperOrder.idempotencyKey UNIQUE constraint — raw duplicate insert throws P2002 exception directly from database with try/finally cleanup', async () => {
    if (!DB_URL) return;

    const testId = `pg_uniq_${Date.now()}`;
    const account = await prismaA.paperAccount.create({
      data: {
        name: `Postgres Uniq Constraint Account ${testId}`,
        cashBalance: 100000.0,
      },
    });

    const idempotencyKey = `raw_dup_${testId}`;

    try {
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
    } finally {
      await prismaA.paperOrder.deleteMany({ where: { idempotencyKey } });
      await prismaA.paperAccount.delete({ where: { id: account.id } });
    }
  });

  it('Requirement 3, 15: True Real PostgreSQL Transaction Rollback — Entry failure rolls back all mutated account/order/fill/position state byte-for-byte in Postgres', async () => {
    if (!DB_URL) return;

    const testId = `pg_entry_rollback_${Date.now()}`;
    const account = await prismaA.paperAccount.create({
      data: {
        name: `Postgres Entry Rollback Account ${testId}`,
        cashBalance: 1000000.0,
        usedMargin: 0.0,
        realizedPnL: 0.0,
        totalChargesPaid: 0.0,
      },
    });

    const initCash = 1000000.0;

    try {
      // Execute production placeOrder() with an intercepted error inside transaction to verify atomic rollback
      const restore = forceFailureInsideTransaction(prismaA, 'auditEvent', 'createMany', '[FORCED_POSTGRES_ENTRY_TRANSACTION_FAILURE]');

      try {
        await expect(
          paperTradingA.placeOrder({
            symbol: 'BTCUSDT',
            contractSymbol: 'BTCUSDT',
            direction: 'BUY',
            orderType: 'MARKET',
            // A valid order, so execution reaches the forced failure inside the transaction. (The old one, 2 BTC
            // with TP1 52,000 against a 52,000 quote, was correctly rejected before the transaction as
            // INVALID_TAKE_PROFIT, so the rollback was never exercised.)
            quantity: 0.01,
            stopLoss: 51900.0,
            target1: 52300.0,
          }),
        ).rejects.toThrow('[FORCED_POSTGRES_ENTRY_TRANSACTION_FAILURE]');
      } finally {
        restore();
      }

      // Assert 100% atomic rollback in real PostgreSQL database via independent client prismaB
      const finalAccountB = await prismaB.paperAccount.findUnique({ where: { id: account.id } });
      expect(Number(finalAccountB!.cashBalance)).toBe(initCash);
      expect(Number(finalAccountB!.realizedPnL)).toBe(0.0);
      expect(Number(finalAccountB!.usedMargin)).toBe(0.0);
      expect(Number(finalAccountB!.totalChargesPaid)).toBe(0.0);

      const ordersB = await prismaB.paperOrder.findMany({ where: { accountId: account.id } });
      expect(ordersB.length).toBe(0);

      const fillsB = await prismaB.paperFill.findMany({
        where: { orderId: { in: ordersB.map((o) => o.id) } },
      });
      expect(fillsB.length).toBe(0);

      const positionsB = await prismaB.paperPosition.findMany({ where: { accountId: account.id } });
      expect(positionsB.length).toBe(0);

      const tradesB = await prismaB.paperTrade.findMany({ where: { accountId: account.id } });
      expect(tradesB.length).toBe(0);

      const auditsB = await prismaB.auditEvent.findMany({ where: { entityId: account.id } });
      expect(auditsB.length).toBe(0);
    } finally {
      await prismaA.paperAccount.delete({ where: { id: account.id } });
    }
  });

  it('Requirement 3, 16: True Real PostgreSQL Final-Close Transaction Rollback — Close failure rolls back fill, trade creation, and account mutation byte-for-byte in Postgres', async () => {
    if (!DB_URL) return;

    const testId = `pg_close_rollback_${Date.now()}`;
    const account = await prismaA.paperAccount.create({
      data: {
        name: `Postgres Close Rollback Account ${testId}`,
        cashBalance: 999900.0,
        usedMargin: 20000.0,
        realizedPnL: -100.0,
        totalChargesPaid: 100.0,
      },
    });

    const inst3 = getAuthoritativeInstrument('BTCUSDT_PERP');
    const entryTime3 = new Date();
    const snap3 = buildAccountingSnapshot({
      accountCurrency: 'INR',
      quoteCurrency: 'USDT',
      fxResult: PointInTimeCurrencyConverter.getInstance().getRate(
        'USDT',
        'INR',
        entryTime3.getTime(),
      ),
      contractSize: 1,
      lotSize: 2.0,
      resolvedMarginModel: resolveMarginModel(inst3, { requestedLeverage: 5 }),
      calculatedAt: entryTime3.getTime(),
    });

    const position = await prismaA.paperPosition.create({
      data: {
        accountId: account.id,
        symbol: 'BTCUSDT_PERP',
        contractSymbol: 'BTCUSDT_PERP',
        instrumentType: 'SPOT',
        direction: 'BULLISH',
        quantity: 2.0,
        entryPrice: 50000.0,
        currentPrice: 50000.0,
        stopLoss: 48000.0,
        target1: 52000.0,
        status: 'OPEN',
        usedMargin: 20000.0,
        leverage: 5.0,
        correlationId: `corr_${testId}`,
        executionEventsJson: { accountingSnapshot: snap3 as any },
        featureSnapshotJson: { accountingSnapshot: snap3 as any },
      },
    });

    try {
      // 5x leverage exists only on the explicit perpetual; legacy 'BTCUSDT' now resolves to 1x spot
      // Execute production closePosition() with an intercepted error inside transaction to verify atomic rollback
      const restore = forceFailureInsideTransaction(prismaA, 'paperTrade', 'create', '[FORCED_POSTGRES_CLOSE_TRANSACTION_FAILURE]');

      try {
        await expect(
          paperTradingA.closePosition(position.id, 'MANUAL_CLOSE', 55000.0),
        ).rejects.toThrow('[FORCED_POSTGRES_CLOSE_TRANSACTION_FAILURE]');
      } finally {
        restore();
      }

      // Assert 100% atomic rollback via independent client prismaB: position remains OPEN, balance/margin/charges/realizedPnL unchanged
      const finalPositionB = await prismaB.paperPosition.findUnique({ where: { id: position.id } });
      expect(finalPositionB!.status).toBe('OPEN');
      expect(Number(finalPositionB!.usedMargin)).toBe(20000.0);

      const finalAccountB = await prismaB.paperAccount.findUnique({ where: { id: account.id } });
      expect(Number(finalAccountB!.cashBalance)).toBe(999900.0);
      expect(Number(finalAccountB!.usedMargin)).toBe(20000.0);
      expect(Number(finalAccountB!.realizedPnL)).toBe(-100.0);
      expect(Number(finalAccountB!.totalChargesPaid)).toBe(100.0);

      const tradesB = await prismaB.paperTrade.findMany({ where: { positionId: position.id } });
      expect(tradesB.length).toBe(0);
    } finally {
      await prismaA.paperOrder.deleteMany({ where: { accountId: account.id } });
      await prismaA.paperPosition.deleteMany({ where: { accountId: account.id } });
      await prismaA.paperAccount.delete({ where: { id: account.id } });
    }
  });

  it('Requirement 15: Real Market Streamer Reconnection Lifecycle with Production PaperTradingService against Real PostgreSQL', async () => {
    if (!DB_URL) return;

    const realStreamer = new RealMarketStreamerService({} as any);
    const prodService = new PaperTradingService(
      prismaA as unknown as PrismaService,
      null as any,
      realStreamer,
    );

    const testId = `pg_streamer_reconnect_${Date.now()}`;
    const account = await prismaA.paperAccount.create({
      data: {
        name: `Postgres Reconnect Test Account ${testId}`,
        cashBalance: 500000.0,
        usedMargin: 50000.0,
        realizedPnL: 0.0,
        totalChargesPaid: 0.0,
      },
    });

    const inst = getAuthoritativeInstrument('BTCUSDT');
    const entryTime = new Date();
    const snap = buildAccountingSnapshot({
      accountCurrency: 'INR',
      quoteCurrency: 'USDT',
      fxResult: PointInTimeCurrencyConverter.getInstance().getRate(
        'USDT',
        'INR',
        entryTime.getTime(),
      ),
      contractSize: 1,
      lotSize: 1.0,
      resolvedMarginModel: resolveMarginModel(inst, { requestedLeverage: 1 }),
      calculatedAt: entryTime.getTime(),
    });

    const pos = await prismaA.paperPosition.create({
      data: {
        accountId: account.id,
        symbol: 'BTCUSDT',
        contractSymbol: 'BTCUSDT',
        instrumentType: 'SPOT',
        direction: 'BULLISH',
        quantity: 1.0,
        entryPrice: 50000.0,
        currentPrice: 50000.0,
        stopLoss: 48000.0,
        target1: 52000.0,
        status: 'OPEN',
        usedMargin: 50000.0,
        leverage: 1.0,
        correlationId: `corr_${testId}`,
        executionEventsJson: { accountingSnapshot: snap as any },
        featureSnapshotJson: { accountingSnapshot: snap as any },
      },
    });

    try {
      // 1. Ingest initial quote then disconnect streamer -> closePosition rejected
      const t0 = Date.now();
      realStreamer.ingestBinanceTickerData({
        symbol: 'BTCUSDT',
        lastPrice: '51000.00',
        closeTime: t0,
      });

      realStreamer.setProviderConnected(false);

      await expect(
        prodService.closePosition(pos.id, 'Disconnect Exit', {
          executionMode: 'LIVE_MARKET' as any,
        }),
      ).rejects.toThrow(/\[MARKET_DATA_UNAVAILABLE\]/);

      // 2. Reconnect provider -> cached tick rejected
      realStreamer.setProviderConnected(true);

      await expect(
        prodService.closePosition(pos.id, 'Cached Quote Exit', {
          executionMode: 'LIVE_MARKET' as any,
        }),
        // The pre-reconnection tick is rejected; the connection-epoch check now catches it before the
        // cached-tick check, so either message proves the same property.
      ).rejects.toThrow(/cached tick from before provider reconnection|from connection epoch \d+ \(active connection epoch: \d+\)/);

      // 3. Ingest fresh valid tick -> closePosition against real PostgreSQL succeeds
      const tFresh = Date.now() + 1000;
      realStreamer.ingestBinanceTickerData({
        symbol: 'BTCUSDT',
        lastPrice: '53000.00',
        closeTime: tFresh,
      });

      const trade = await prodService.closePosition(pos.id, 'Reconnected Valid Exit', {
        executionMode: 'LIVE_MARKET' as any,
      });
      expect(trade).toBeDefined();
      // Filled at the fresh 53,000 quote less the paper engine's simulated exit slippage for a market SELL. That
      // slippage is random (ExecutionPriceResolver.calculateSlippage draws 2-10 bps), so the fill is checked
      // against the model's range; the old expectation of exactly 53,000 ignored slippage.
      const exit = Number(trade.exitPrice);
      expect(exit).toBeLessThanOrEqual(53000.0 * (1 - 2 / 10000) + 0.05);
      expect(exit).toBeGreaterThanOrEqual(53000.0 * (1 - 10 / 10000) - 0.05);

      // Verify PostgreSQL database state
      const dbPos = await prismaA.paperPosition.findUnique({ where: { id: pos.id } });
      expect(dbPos?.status).toBe('CLOSED');

      const dbTrades = await prismaA.paperTrade.findMany({ where: { positionId: pos.id } });
      expect(dbTrades.length).toBe(1);
    } finally {
      await prismaA.paperTrade.deleteMany({ where: { positionId: pos.id } }).catch(() => {});
      await prismaA.paperOrder.deleteMany({ where: { accountId: account.id } }).catch(() => {});
      await prismaA.paperPosition.delete({ where: { id: pos.id } }).catch(() => {});
      await prismaA.paperAccount.delete({ where: { id: account.id } }).catch(() => {});
    }
  });
});
