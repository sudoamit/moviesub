import { Test, TestingModule } from '@nestjs/testing';
import { PaperTradingService } from '../paper-trading.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CandlesService } from '../../candles/candles.service';
import { RealMarketStreamerService } from '../../market-data/real-market-streamer.service';
import { Direction, PositionState, OrderState, MarketDataUnavailableError } from '@quant/shared';
import { Decimal } from '@prisma/client/runtime/library';

describe('PaperTradingService Persistent Execution & Safety', () => {
  let service: PaperTradingService;
  let mockPrisma: any;
  let mockCandlesService: any;
  let mockRealMarketStreamer: any;

  // In-memory mock database state
  let dbAccounts: any[] = [];
  let dbOrders: any[] = [];
  let dbFills: any[] = [];
  let dbPositions: any[] = [];
  let dbTrades: any[] = [];
  let dbAudits: any[] = [];

  beforeEach(async () => {
    dbAccounts = [
      {
        id: 'acc-1',
        name: 'Primary Paper Account',
        currency: 'INR',
        initialCapital: new Decimal(1000000.0),
        cashBalance: new Decimal(1000000.0),
        usedMargin: new Decimal(0.0),
        realizedPnL: new Decimal(0.0),
        totalChargesPaid: new Decimal(0.0),
        tradingMode: 'PAPER',
        isActive: true,
      },
    ];
    let entitySeq = 1;
    dbOrders = [];
    dbFills = [];
    dbPositions = [];
    dbTrades = [];
    dbAudits = [];

    mockPrisma = {
      paperAccount: {
        findFirst: jest.fn().mockImplementation(() => Promise.resolve(dbAccounts[0])),
        findUnique: jest.fn().mockImplementation((args) => {
          const acc = dbAccounts.find((a) => a.id === args?.where?.id);
          return Promise.resolve(acc || dbAccounts[0]);
        }),
        create: jest.fn().mockImplementation((args) => {
          const acc = { id: `acc_${Date.now()}_${entitySeq++}`, ...args.data };
          dbAccounts.push(acc);
          return Promise.resolve(acc);
        }),
        update: jest.fn().mockImplementation((args) => {
          const acc = dbAccounts.find((a) => a.id === args.where.id) || dbAccounts[0];
          if (acc) {
            if (args.data.cashBalance?.decrement) {
              acc.cashBalance = new Decimal(
                Number(acc.cashBalance) - Number(args.data.cashBalance.decrement),
              );
            }
            if (args.data.cashBalance?.increment) {
              acc.cashBalance = new Decimal(
                Number(acc.cashBalance) + Number(args.data.cashBalance.increment),
              );
            }
            if (args.data.usedMargin?.increment) {
              acc.usedMargin = new Decimal(
                Number(acc.usedMargin) + Number(args.data.usedMargin.increment),
              );
            }
            if (args.data.usedMargin?.decrement) {
              acc.usedMargin = new Decimal(
                Number(acc.usedMargin) - Number(args.data.usedMargin.decrement),
              );
            }
            if (args.data.realizedPnL?.increment) {
              acc.realizedPnL = new Decimal(
                Number(acc.realizedPnL) + Number(args.data.realizedPnL.increment),
              );
            }
            if (args.data.totalChargesPaid?.increment) {
              acc.totalChargesPaid = new Decimal(
                Number(acc.totalChargesPaid) + Number(args.data.totalChargesPaid.increment),
              );
            }
          }
          return Promise.resolve(acc);
        }),
      },
      tradingSystemConfig: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'SYSTEM_DEFAULT',
          paperTradingEnabled: true,
          liveTradingEnabled: false,
          emergencyStop: false,
          maxDailyLossPercent: new Decimal(3.0),
          maxLeverage: new Decimal(5.0),
          maxMarketDataAgeSeconds: 5,
          maxSlippageBps: 50,
        }),
        create: jest
          .fn()
          .mockImplementation((args) => Promise.resolve({ id: 'SYSTEM_DEFAULT', ...args.data })),
      },
      paperOrder: {
        findUnique: jest.fn().mockImplementation((args) => {
          const order = dbOrders.find((o) => o.idempotencyKey === args.where.idempotencyKey);
          if (order) {
            const positions = dbPositions.filter((p) => p.orderId === order.id);
            return Promise.resolve({ ...order, positions });
          }
          return Promise.resolve(null);
        }),
        create: jest.fn().mockImplementation((args) => {
          const order = { id: `order_${Date.now()}_${entitySeq++}`, ...args.data };
          dbOrders.push(order);
          return Promise.resolve(order);
        }),
        count: jest.fn().mockImplementation(() => Promise.resolve(dbOrders.length)),
      },
      paperFill: {
        create: jest.fn().mockImplementation((args) => {
          const fill = { id: `fill_${Date.now()}_${entitySeq++}`, ...args.data };
          dbFills.push(fill);
          return Promise.resolve(fill);
        }),
        findMany: jest.fn().mockImplementation((args) => {
          let list = dbFills;
          if (args?.where?.orderId) {
            list = list.filter((f) => f.orderId === args.where.orderId);
          }
          return Promise.resolve(list);
        }),
      },
      paperPosition: {
        findUnique: jest.fn().mockImplementation((args) => {
          const pos = dbPositions.find((p) => p.id === args.where.id);
          return Promise.resolve(pos ? { ...pos, account: dbAccounts[0] } : null);
        }),
        findMany: jest.fn().mockImplementation((args) => {
          let list = dbPositions;
          if (args.where?.status?.in) {
            list = list.filter((p) => args.where.status.in.includes(p.status));
          }
          return Promise.resolve(list);
        }),
        create: jest.fn().mockImplementation((args) => {
          const pos = { id: `pos_${Date.now()}_${entitySeq++}`, ...args.data };
          dbPositions.push(pos);
          return Promise.resolve(pos);
        }),
        update: jest.fn().mockImplementation((args) => {
          const pos = dbPositions.find((p) => p.id === args.where.id);
          if (pos) {
            Object.assign(pos, args.data);
          }
          return Promise.resolve(pos);
        }),
        updateMany: jest.fn().mockImplementation((args) => {
          let count = 0;
          for (const pos of dbPositions) {
            const matchesId = !args.where?.id || pos.id === args.where.id;
            const matchesStatus =
              !args.where?.status?.in || args.where.status.in.includes(pos.status);
            if (matchesId && matchesStatus) {
              Object.assign(pos, args.data);
              count++;
            }
          }
          return Promise.resolve({ count });
        }),
        count: jest.fn().mockImplementation(() => Promise.resolve(dbPositions.length)),
      },
      paperTrade: {
        findMany: jest.fn().mockImplementation(() => Promise.resolve(dbTrades)),
        findFirst: jest.fn().mockImplementation((args) => {
          const trade = dbTrades.find((t) => !args?.where?.positionId || t.positionId === args.where.positionId);
          return Promise.resolve(trade || null);
        }),
        create: jest.fn().mockImplementation((args) => {
          const trade = { id: `trade_${Date.now()}_${entitySeq++}`, ...args.data };
          dbTrades.push(trade);
          return Promise.resolve(trade);
        }),
        count: jest.fn().mockImplementation(() => Promise.resolve(dbTrades.length)),
      },
      auditEvent: {
        create: jest.fn().mockImplementation((args) => {
          const audit = { id: `audit_${Date.now()}_${entitySeq++}`, ...args.data };
          dbAudits.push(audit);
          return Promise.resolve(audit);
        }),
        createMany: jest.fn().mockImplementation((args) => {
          const audits = args.data.map((d: any) => ({ id: `audit_${Date.now()}_${entitySeq++}`, ...d }));
          dbAudits.push(...audits);
          return Promise.resolve({ count: audits.length });
        }),
      },
      $transaction: jest.fn().mockImplementation((callback) => callback(mockPrisma)),
    };

    mockCandlesService = {
      getLatestCandle: jest.fn().mockResolvedValue({
        close: 24150.0,
        timestamp: new Date(),
      }),
    };

    mockRealMarketStreamer = {
      getTicker: jest.fn().mockReturnValue({
        symbol: 'NIFTY',
        price: 24180.0,
        lastUpdated: Date.now(),
      }),
      getValidatedTicker: jest.fn().mockReturnValue({
        symbol: 'NIFTY',
        price: 24180.0,
        lastUpdated: Date.now(),
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaperTradingService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: CandlesService, useValue: mockCandlesService },
        { provide: RealMarketStreamerService, useValue: mockRealMarketStreamer },
      ],
    }).compile();

    service = module.get<PaperTradingService>(PaperTradingService);
  });

  it('should place an order, persist to database and return valid position', async () => {
    const order = await service.placeOrder({
      symbol: 'NIFTY',
      direction: 'BUY',
      quantity: 65,
      orderType: 'MARKET',
      price: 24100.0,
      stopLoss: 24050.0,
      target1: 24175.0,
      target2: 24225.0,
      leverage: 5,
    });

    expect(order.entryPrice).toBeGreaterThanOrEqual(24100.0);
    expect(order.entryTime).toBeDefined();
    expect(order.symbol).toBe('NIFTY');
    expect(dbPositions.length).toBe(1);
    expect(dbOrders.length).toBe(1);
    expect(dbFills.length).toBe(1);
    expect(dbAudits.length).toBeGreaterThanOrEqual(2);
  });

  it('should prevent duplicate orders via idempotencyKey', async () => {
    const req = {
      symbol: 'NIFTY',
      direction: 'BUY' as const,
      quantity: 65,
      orderType: 'MARKET' as const,
      price: 24100.0,
      stopLoss: 24050.0,
      target1: 24175.0,
      idempotencyKey: 'idempotent_test_key_123',
    };

    const firstPos = await service.placeOrder(req);
    expect(firstPos).toBeDefined();

    // Re-submitting with identical idempotencyKey returns existing position without creating new orders
    const duplicatePos = await service.placeOrder(req);
    expect(duplicatePos.id).toBe(firstPos.id);
    expect(dbOrders.length).toBe(1);
  });

  it('should reject order if live market data is unavailable and NO fake price or candle fallback exists', async () => {
    mockCandlesService.getLatestCandle.mockClear();
    mockRealMarketStreamer.getValidatedTicker.mockImplementation(() => {
      throw new MarketDataUnavailableError('UNKNOWN_SYM', 'No stream');
    });

    await expect(
      service.placeOrder({
        symbol: 'UNKNOWN_SYM',
        direction: 'BUY',
        quantity: 10,
        orderType: 'MARKET',
        stopLoss: 90.0,
        target1: 110.0,
      }),
    ).rejects.toThrow();

    // Verify order was recorded as REJECTED in database
    const rejectedOrder = dbOrders.find((o) => o.symbol === 'UNKNOWN_SYM');
    expect(rejectedOrder).toBeDefined();
    expect(rejectedOrder.status).toBe(OrderState.REJECTED);
    expect(mockCandlesService.getLatestCandle).not.toHaveBeenCalled();
  });

  it('should reject order if stopLoss is missing or invalid (P0-4)', async () => {
    // Missing stopLoss
    await expect(
      service.placeOrder({
        symbol: 'NIFTY',
        direction: 'BUY',
        quantity: 25,
        orderType: 'MARKET',
        price: 24100.0,
        target1: 24200.0,
      } as any),
    ).rejects.toThrow('MISSING_STOP_LOSS');

    // Invalid stopLoss for BUY (stopLoss >= price)
    await expect(
      service.placeOrder({
        symbol: 'NIFTY',
        direction: 'BUY',
        quantity: 25,
        orderType: 'MARKET',
        price: 24100.0,
        stopLoss: 24150.0,
        target1: 24200.0,
      }),
    ).rejects.toThrow('INVALID_STOP_LOSS');

    // Invalid stopLoss for SELL (stopLoss <= price)
    await expect(
      service.placeOrder({
        symbol: 'NIFTY',
        direction: 'SELL',
        quantity: 25,
        orderType: 'MARKET',
        price: 24100.0,
        stopLoss: 24050.0,
        target1: 24000.0,
      }),
    ).rejects.toThrow('INVALID_STOP_LOSS');
  });

  it('should reject order if target1 (takeProfit) is missing or invalid (P0-4)', async () => {
    // Missing target1
    await expect(
      service.placeOrder({
        symbol: 'NIFTY',
        direction: 'BUY',
        quantity: 25,
        orderType: 'MARKET',
        price: 24100.0,
        stopLoss: 24050.0,
      } as any),
    ).rejects.toThrow('MISSING_TAKE_PROFIT');

    // Invalid target1 for BUY (target1 <= price)
    await expect(
      service.placeOrder({
        symbol: 'NIFTY',
        direction: 'BUY',
        quantity: 25,
        orderType: 'MARKET',
        price: 24100.0,
        stopLoss: 24050.0,
        target1: 24080.0,
      }),
    ).rejects.toThrow('INVALID_TAKE_PROFIT');

    // Invalid target1 for SELL (target1 >= price)
    await expect(
      service.placeOrder({
        symbol: 'NIFTY',
        direction: 'SELL',
        quantity: 25,
        orderType: 'MARKET',
        price: 24100.0,
        stopLoss: 24150.0,
        target1: 24120.0,
      }),
    ).rejects.toThrow('INVALID_TAKE_PROFIT');
  });

  it('should reject order when emergencyStop is activated (P0-10)', async () => {
    mockPrisma.tradingSystemConfig.findUnique.mockResolvedValue({
      id: 'SYSTEM_DEFAULT',
      paperTradingEnabled: true,
      liveTradingEnabled: false,
      emergencyStop: true,
      maxDailyLossPercent: new Decimal(3.0),
      maxLeverage: new Decimal(5.0),
      maxMarketDataAgeSeconds: 5,
    });

    await expect(
      service.placeOrder({
        symbol: 'NIFTY',
        direction: 'BUY',
        quantity: 25,
        orderType: 'MARKET',
        price: 24100.0,
        stopLoss: 24050.0,
        target1: 24200.0,
      }),
    ).rejects.toThrow('Emergency Stop');
  });

  it('should ensure getPortfolio() is strictly read-only without modifying database', async () => {
    await service.placeOrder({
      symbol: 'NIFTY',
      direction: 'BUY',
      quantity: 65,
      orderType: 'MARKET',
      price: 24100.0,
      stopLoss: 24050.0,
      target1: 24175.0,
    });

    const positionsCountBefore = dbPositions.length;
    const tradesCountBefore = dbTrades.length;

    const portfolio = await service.getPortfolio();
    expect(portfolio.openPositions.length).toBe(1);

    // Verify no writes occurred on getPortfolio
    expect(dbPositions.length).toBe(positionsCountBefore);
    expect(dbTrades.length).toBe(tradesCountBefore);
  });

  it('should close position, book realized PnL and persist PaperTrade', async () => {
    mockRealMarketStreamer.getValidatedTicker.mockReturnValue({
      symbol: 'NIFTY',
      price: 24200.0,
      timestamp: Date.now(),
      lastUpdated: Date.now(),
    });

    const pos = await service.placeOrder({
      symbol: 'NIFTY',
      direction: 'BUY',
      quantity: 65,
      orderType: 'MARKET',
      price: 24100.0,
      stopLoss: 24050.0,
      target1: 24175.0,
    });

    const trade = await service.closePosition(pos.id, 'Target Achieved');

    expect(trade.entryPrice).toBeGreaterThanOrEqual(24100.0);
    expect(trade.exitPrice).toBeLessThanOrEqual(24200.0);
    expect(trade.realizedPnL).toBeGreaterThan(0);
    expect(trade.realizedR).toBeGreaterThan(0);
    expect(dbTrades.length).toBe(1);
    expect(dbPositions[0].status).toBe(PositionState.CLOSED);
  });

  it('should support idempotent retry: calling closePosition sequentially returns existing closed trade without creating duplicate', async () => {
    mockRealMarketStreamer.getValidatedTicker.mockReturnValue({
      symbol: 'NIFTY',
      price: 24200.0,
      timestamp: Date.now(),
      lastUpdated: Date.now(),
    });

    const pos = await service.placeOrder({
      symbol: 'NIFTY',
      direction: 'BUY',
      quantity: 50,
      orderType: 'MARKET',
      price: 24100.0,
      stopLoss: 24050.0,
      target1: 24200.0,
    });

    // First close call creates the trade
    const trade1 = await service.closePosition(pos.id, 'Target Achieved');
    expect(dbTrades.length).toBe(1);
    expect(dbPositions[0].status).toBe(PositionState.CLOSED);

    // Second close call recognizes existing closed state and returns existing trade without creating duplicate
    const trade2 = await service.closePosition(pos.id, 'Target Achieved');
    expect(dbTrades.length).toBe(1);
    expect(trade2.id).toBe(trade1.id);
    expect(trade2.realizedPnL).toBe(trade1.realizedPnL);
  });

  it('should protect closePosition against arbitrary exit prices in normal PAPER mode and enforce LIVE_TICK provenance', async () => {
    // Mock streamer returning live market price 24220.0
    mockRealMarketStreamer.getValidatedTicker.mockReturnValue({
      symbol: 'NIFTY',
      price: 24220.0,
      timestamp: Date.now(),
      lastUpdated: Date.now(),
    });

    const pos = await service.placeOrder({
      symbol: 'NIFTY',
      direction: 'BUY',
      quantity: 50,
      orderType: 'MARKET',
      price: 24100.0,
      stopLoss: 24050.0,
      target1: 24200.0,
    });

    // Pass arbitrary price 99999.0 without allowPriceOverride -> must be ignored in normal PAPER mode
    const trade = await service.closePosition(pos.id, 'TP Hit', 99999.0);

    // Verify it used the streamer price (24220.0) with simulated slippage, NOT 99999.0
    expect(trade.exitPrice).toBeLessThanOrEqual(24220.0);
    expect(trade.exitPrice).toBeGreaterThan(24100.0);
    expect(trade.outcomeSnapshotJson.executionPriceSource).toBe('LIVE_TICK');
    expect(trade.outcomeSnapshotJson.livePrice).toBe(24220.0);
    expect(dbTrades.length).toBe(1);
  });

  it('should permit exitPriceOverride only when allowPriceOverride: true is explicitly provided', async () => {
    const pos = await service.placeOrder({
      symbol: 'NIFTY',
      direction: 'BUY',
      quantity: 50,
      orderType: 'MARKET',
      price: 24100.0,
      stopLoss: 24050.0,
      target1: 24200.0,
    });

    const trade = await service.closePosition(pos.id, 'Backtest Close', {
      exitPriceOverride: 24250.0,
      allowPriceOverride: true,
    });

    expect(trade.outcomeSnapshotJson.executionPriceSource).toBe('SIMULATED_FILL');
    expect(trade.outcomeSnapshotJson.livePrice).toBe(24250.0);
    expect(trade.exitPrice).toBeLessThanOrEqual(24250.0);
  });

  it('should persist feature and outcome snapshots without data distortion', async () => {
    mockRealMarketStreamer.getValidatedTicker.mockReturnValue({
      symbol: 'NIFTY',
      price: 24200.0,
      timestamp: Date.now(),
      lastUpdated: Date.now(),
    });

    const featureSnapshot = {
      htfTrendAlignment: 1,
      trend4H: 1,
      trend1H: 1,
      structure15M: 1,
      bosChochQuality: 0.85,
    };

    const pos = await service.placeOrder({
      symbol: 'NIFTY',
      direction: 'BUY',
      quantity: 50,
      orderType: 'MARKET',
      price: 24100.0,
      stopLoss: 24050.0,
      target1: 24200.0,
      featureSnapshotJson: featureSnapshot,
    });

    expect(pos.featureSnapshotJson).toEqual(featureSnapshot);

    const trade = await service.closePosition(pos.id, 'TP1_HIT');
    expect(trade.featureSnapshotJson).toEqual(featureSnapshot);
    expect(trade.outcomeSnapshotJson).toBeDefined();
    expect(trade.outcomeSnapshotJson.exitPrice).toBeLessThanOrEqual(24200.0);
  });

  it('should fail-closed and mark position EXIT_PENDING when real-time exit price cannot be resolved', async () => {
    const pos = await service.placeOrder({
      symbol: 'NIFTY',
      direction: 'BUY',
      quantity: 50,
      orderType: 'MARKET',
      price: 24100.0,
      stopLoss: 24050.0,
      target1: 24200.0,
    });

    // Simulate market data outage
    mockRealMarketStreamer.getValidatedTicker.mockImplementation(() => {
      throw new MarketDataUnavailableError('NIFTY', 'Stream disconnected');
    });
    mockCandlesService.getLatestCandle.mockResolvedValue(null);

    await expect(service.closePosition(pos.id, 'Target Achieved')).rejects.toThrow();

    expect(dbPositions[0].status).toBe(PositionState.EXIT_PENDING);
  });

  it('should prevent concurrency race condition over-allocations when multiple orders execute concurrently', async () => {
    // Set account balance such that only 1 order fits (NIFTY margin ~241k, cash = 300k)
    dbAccounts[0].cashBalance = new Decimal(300000.0);
    dbAccounts[0].usedMargin = new Decimal(0.0);

    const orderPromises = [
      service.placeOrder({
        symbol: 'NIFTY',
        direction: 'BUY',
        quantity: 50,
        orderType: 'MARKET',
        price: 24100.0,
        stopLoss: 24050.0,
        target1: 24200.0,
      }),
      service.placeOrder({
        symbol: 'BANKNIFTY',
        direction: 'BUY',
        quantity: 50,
        orderType: 'MARKET',
        price: 52000.0,
        stopLoss: 51900.0,
        target1: 52200.0,
      }),
    ];

    const results = await Promise.allSettled(orderPromises);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);
  });

  it('should prevent double-close / duplicate trades when concurrent close requests are executed on the same position', async () => {
    mockRealMarketStreamer.getValidatedTicker.mockReturnValue({
      symbol: 'NIFTY',
      price: 24040.0,
      timestamp: Date.now(),
      lastUpdated: Date.now(),
    });

    const pos = await service.placeOrder({
      symbol: 'NIFTY',
      direction: 'BUY',
      quantity: 50,
      orderType: 'MARKET',
      price: 24100.0,
      stopLoss: 24050.0,
      target1: 24200.0,
    });

    const closePromises = [
      service.closePosition(pos.id, 'SL Triggered A'),
      service.closePosition(pos.id, 'SL Triggered B'),
    ];

    const results = await Promise.allSettled(closePromises);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');

    // Both may return the trade (idempotent) or exactly one creates it
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);
    // Crucially, verify that only ONE PaperTrade record was created in the database
    expect(dbTrades.length).toBe(1);
    expect(dbPositions[0].status).toBe(PositionState.CLOSED);
  });

  it('should execute full end-to-end paper trading lifecycle from live tick entry to exit with preserved snapshots and exact fill prices', async () => {
    mockRealMarketStreamer.getValidatedTicker.mockReturnValue({
      symbol: 'NIFTY',
      price: 24210.0,
      timestamp: Date.now(),
      lastUpdated: Date.now(),
    });

    const featureSnapshot = {
      smcScore: 0.9,
      fvgSize: 15.5,
      regime: 'TRENDING_BULLISH',
    };

    // 1. Order placement with live tick
    const pos = await service.placeOrder({
      symbol: 'NIFTY',
      direction: 'BUY',
      quantity: 50,
      orderType: 'MARKET',
      price: 24100.0,
      stopLoss: 24050.0,
      target1: 24200.0,
      target2: 24250.0,
      featureSnapshotJson: featureSnapshot,
    });

    expect(pos.entryPrice).toBeGreaterThanOrEqual(24100.0);
    expect(pos.status).toBe(PositionState.OPEN);
    expect(pos.featureSnapshotJson).toEqual(featureSnapshot);

    const fillRecord = dbFills[0];
    expect(fillRecord.executionPriceSource).toBe('LIVE_TICK');
    expect(fillRecord.fillPrice.toNumber()).toBe(pos.entryPrice);

    // 2. Position exit with live tick and slippage
    const trade = await service.closePosition(pos.id, 'TP1 Hit on Live Tick');

    expect(trade.entryPrice).toBe(pos.entryPrice);
    expect(trade.exitPrice).toBeLessThanOrEqual(24210.0);
    expect(trade.featureSnapshotJson).toEqual(featureSnapshot);
    expect(trade.outcomeSnapshotJson.executionPriceSource).toBe('LIVE_TICK');
    expect(trade.outcomeSnapshotJson.livePrice).toBe(24210.0);
    expect(trade.outcomeSnapshotJson.exitPrice).toBe(trade.exitPrice);

    // Verify P&L is calculated using exact fill prices
    const expectedGrossPnL = (trade.exitPrice - Number(trade.entryPrice!)) * 50;
    const expectedNetPnL = Number((expectedGrossPnL - trade.totalCharges).toFixed(2));
    expect(trade.realizedPnL!).toBeCloseTo(expectedNetPnL, 1);

    // Verify R multiple is calculated from initialStopLoss risk anchor
    const expectedRiskDistance = Math.abs(pos.entryPrice - 24050.0);
    const expectedR = Number(((trade.exitPrice - Number(trade.entryPrice!)) / expectedRiskDistance).toFixed(2));
    expect(trade.realizedR!).toBeCloseTo(expectedR, 1);
  });

  it('should reject close request if position is already in CLOSING state by worker', async () => {
    mockRealMarketStreamer.getValidatedTicker.mockReturnValue({
      symbol: 'NIFTY',
      price: 24210.0,
      timestamp: Date.now(),
      lastUpdated: Date.now(),
    });

    const pos = await service.placeOrder({
      symbol: 'NIFTY',
      direction: 'BUY',
      quantity: 50,
      orderType: 'MARKET',
      price: 24100.0,
      stopLoss: 24050.0,
      target1: 24200.0,
    });

    // Simulate worker transitioning position to CLOSING state
    dbPositions[0].status = PositionState.CLOSING;

    await expect(service.closePosition(pos.id, 'API Close Race')).rejects.toThrow(
      /is currently being closed/,
    );
  });

  it('should maintain strict accounting invariants across full trade lifecycle', async () => {
    // Initial account state
    dbAccounts[0].cashBalance = new Decimal(500000.0);
    dbAccounts[0].usedMargin = new Decimal(0.0);
    dbAccounts[0].realizedPnL = new Decimal(0.0);
    dbAccounts[0].totalChargesPaid = new Decimal(0.0);

    mockRealMarketStreamer.getValidatedTicker.mockReturnValue({
      symbol: 'NIFTY',
      price: 24100.0,
      timestamp: Date.now(),
      lastUpdated: Date.now(),
    });

    // 1. Enter Trade
    const pos = await service.placeOrder({
      symbol: 'NIFTY',
      direction: 'BUY',
      quantity: 50,
      orderType: 'MARKET',
      price: 24100.0,
      stopLoss: 24050.0,
      target1: 24200.0,
      leverage: 5,
    });

    const usedMarginAfterEntry = Number(dbAccounts[0].usedMargin);
    expect(usedMarginAfterEntry).toBeGreaterThan(0);

    // 2. Exit Trade at higher price
    mockRealMarketStreamer.getValidatedTicker.mockReturnValue({
      symbol: 'NIFTY',
      price: 24200.0,
      timestamp: Date.now(),
      lastUpdated: Date.now(),
    });

    const trade = await service.closePosition(pos.id, 'TP1 Hit');

    // 3. Verify Accounting Invariants:
    // a. Used margin must be fully released back to 0
    expect(Number(dbAccounts[0].usedMargin)).toBe(0.0);

    // b. Realized P&L matches trade realized P&L
    expect(Number(dbAccounts[0].realizedPnL)).toBeCloseTo(Number(trade.realizedPnL!), 2);

    // c. Cash balance equals initial (500,000) + grossPnL - totalCharges
    const expectedCashBalance = 500000.0 + Number(trade.realizedPnL!);
    expect(Number(dbAccounts[0].cashBalance)).toBeCloseTo(expectedCashBalance, 2);

    // d. Exactly 1 PaperTrade record created
    expect(dbTrades.length).toBe(1);
  });

  it('Test B — API vs worker: simultaneous close execution race creates exactly 1 trade and 1 accounting settlement', async () => {
    mockRealMarketStreamer.getValidatedTicker.mockReturnValue({
      symbol: 'NIFTY',
      price: 24200.0,
      timestamp: Date.now(),
      lastUpdated: Date.now(),
    });

    const pos = await service.placeOrder({
      symbol: 'NIFTY',
      direction: 'BUY',
      quantity: 50,
      orderType: 'MARKET',
      price: 24100.0,
      stopLoss: 24050.0,
      target1: 24200.0,
    });

    const initialTradesCount = dbTrades.length;
    const initialUsedMargin = Number(dbAccounts[0].usedMargin);

    // Simulate worker concurrently locking the position in DB transaction right before API finishes
    // API closePosition runs concurrently with a simulated worker transaction
    const closeOperationA = service.closePosition(pos.id, 'API Close Trigger');
    const closeOperationB = service.closePosition(pos.id, 'Worker StopLoss Trigger');

    const results = await Promise.allSettled([closeOperationA, closeOperationB]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');

    // At least one succeeds (or both return the same trade idempotently)
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);

    // Invariant: Exactly 1 PaperTrade created in DB
    expect(dbTrades.length).toBe(initialTradesCount + 1);

    // Invariant: Used margin released exactly once (not decremented twice)
    expect(Number(dbAccounts[0].usedMargin)).toBe(0);

    // Invariant: Position status is CLOSED
    expect(dbPositions[0].status).toBe(PositionState.CLOSED);
  });
});
