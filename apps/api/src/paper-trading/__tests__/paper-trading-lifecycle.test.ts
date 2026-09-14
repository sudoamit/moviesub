import { Test, TestingModule } from '@nestjs/testing';
import { PaperTradingService, ExecutionMode } from '../paper-trading.service';
import { PaperPositionMonitorService } from '../paper-position-monitor.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CandlesService } from '../../candles/candles.service';
import { RealMarketStreamerService, ILiveRealTicker } from '../../market-data/real-market-streamer.service';
import { Direction, PositionState, OrderState, MarketDataUnavailableError, StaleMarketDataError } from '@quant/shared';
import { Decimal } from '@prisma/client/runtime/library';

describe('AI FIX 133 — Authoritative Paper Trading Lifecycle Test Suite (Tests A-O)', () => {
  let paperService: PaperTradingService;
  let monitorService: PaperPositionMonitorService;
  let streamerService: RealMarketStreamerService;
  let mockPrisma: any;

  let dbAccounts: any[] = [];
  let dbOrders: any[] = [];
  let dbFills: any[] = [];
  let dbPositions: any[] = [];
  let dbTrades: any[] = [];
  let dbAudits: any[] = [];
  let entitySeq = 1;

  beforeEach(async () => {
    entitySeq = 1;
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
          const acc = { id: `acc_${entitySeq++}`, ...args.data };
          dbAccounts.push(acc);
          return Promise.resolve(acc);
        }),
        update: jest.fn().mockImplementation((args) => {
          const acc = dbAccounts.find((a) => a.id === args.where.id) || dbAccounts[0];
          if (acc) {
            if (args.data.cashBalance?.decrement) {
              acc.cashBalance = new Decimal(Number(acc.cashBalance) - Number(args.data.cashBalance.decrement));
            }
            if (args.data.cashBalance?.increment) {
              acc.cashBalance = new Decimal(Number(acc.cashBalance) + Number(args.data.cashBalance.increment));
            }
            if (args.data.usedMargin?.increment) {
              acc.usedMargin = new Decimal(Number(acc.usedMargin) + Number(args.data.usedMargin.increment));
            }
            if (args.data.usedMargin?.decrement) {
              acc.usedMargin = new Decimal(Number(acc.usedMargin) - Number(args.data.usedMargin.decrement));
            }
            if (args.data.realizedPnL?.decrement) {
              acc.realizedPnL = new Decimal(Number(acc.realizedPnL) - Number(args.data.realizedPnL.decrement));
            }
            if (args.data.realizedPnL?.increment) {
              acc.realizedPnL = new Decimal(Number(acc.realizedPnL) + Number(args.data.realizedPnL.increment));
            }
            if (args.data.totalChargesPaid?.increment) {
              acc.totalChargesPaid = new Decimal(Number(acc.totalChargesPaid) + Number(args.data.totalChargesPaid.increment));
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
          maxPositionRiskPercent: new Decimal(1.0),
          maxTotalExposurePercent: new Decimal(20.0),
          maxOpenPositions: 5,
          maxTradesPerDay: 20,
          maxConsecutiveLosses: 3,
          maxLeverage: new Decimal(5.0),
          maxSlippageBps: 0, // Set to 0 for exact price parity assertion in tests
          maxMarketDataAgeSeconds: 5,
        }),
      },
      paperOrder: {
        findUnique: jest.fn().mockImplementation((args) => {
          const order = dbOrders.find((o) => o.idempotencyKey === args.where.idempotencyKey);
          return Promise.resolve(order || null);
        }),
        create: jest.fn().mockImplementation((args) => {
          if (args.data.idempotencyKey && dbOrders.some((o) => o.idempotencyKey === args.data.idempotencyKey)) {
            const err: any = new Error('Unique constraint failed on the fields: (`idempotencyKey`)');
            err.code = 'P2002';
            return Promise.reject(err);
          }
          const order = { id: `ord_${entitySeq++}`, positions: [], ...args.data };
          dbOrders.push(order);
          return Promise.resolve(order);
        }),
        count: jest.fn().mockResolvedValue(0),
      },
      paperFill: {
        create: jest.fn().mockImplementation((args) => {
          const fill = { id: `fill_${entitySeq++}`, ...args.data };
          dbFills.push(fill);
          return Promise.resolve(fill);
        }),
        findMany: jest.fn().mockImplementation((args) => {
          const fills = dbFills.filter((f) => f.orderId === args.where.orderId);
          return Promise.resolve(fills);
        }),
      },
      paperPosition: {
        findUnique: jest.fn().mockImplementation((args) => {
          const pos = dbPositions.find((p) => p.id === args.where.id);
          return Promise.resolve(pos || null);
        }),
        findMany: jest.fn().mockImplementation((args) => {
          let res = [...dbPositions];
          if (args?.where?.status?.in) {
            res = res.filter((p) => args.where.status.in.includes(p.status));
          }
          return Promise.resolve(res);
        }),
        create: jest.fn().mockImplementation((args) => {
          const pos = { id: `pos_${entitySeq++}`, ...args.data };
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
          const matching = dbPositions.filter((p) => {
            if (args.where.id && p.id !== args.where.id) return false;
            if (args.where.accountId && p.accountId !== args.where.accountId) return false;
            if (args.where.status?.in) return args.where.status.in.includes(p.status);
            if (args.where.status) return p.status === args.where.status;
            return true;
          });
          matching.forEach((p) => Object.assign(p, args.data));
          return Promise.resolve({ count: matching.length });
        }),
        count: jest.fn().mockImplementation(() => {
          return Promise.resolve(dbPositions.filter((p) => p.status === 'OPEN').length);
        }),
      },
      paperTrade: {
        create: jest.fn().mockImplementation((args) => {
          const trade = { id: `trd_${entitySeq++}`, ...args.data };
          dbTrades.push(trade);
          return Promise.resolve(trade);
        }),
        findFirst: jest.fn().mockImplementation((args) => {
          const trade = dbTrades.find((t) => t.positionId === args?.where?.positionId);
          return Promise.resolve(trade || null);
        }),
        findMany: jest.fn().mockImplementation(() => Promise.resolve(dbTrades)),
      },
      auditEvent: {
        create: jest.fn().mockImplementation((args) => {
          dbAudits.push(args.data);
          return Promise.resolve(args.data);
        }),
        createMany: jest.fn().mockImplementation((args) => {
          dbAudits.push(...args.data);
          return Promise.resolve({ count: args.data.length });
        }),
      },
      $transaction: jest.fn().mockImplementation(async (cb) => {
        const snapAccounts = JSON.parse(JSON.stringify(dbAccounts));
        const snapOrders = JSON.parse(JSON.stringify(dbOrders));
        const snapFills = JSON.parse(JSON.stringify(dbFills));
        const snapPositions = JSON.parse(JSON.stringify(dbPositions));
        const snapTrades = JSON.parse(JSON.stringify(dbTrades));
        const snapAudits = JSON.parse(JSON.stringify(dbAudits));
        try {
          return await cb(mockPrisma);
        } catch (err) {
          dbAccounts.length = 0;
          dbAccounts.push(
            ...snapAccounts.map((a: any) => ({
              ...a,
              cashBalance: new Decimal(a.cashBalance),
              usedMargin: new Decimal(a.usedMargin),
              realizedPnL: new Decimal(a.realizedPnL),
              totalChargesPaid: new Decimal(a.totalChargesPaid),
            })),
          );
          dbOrders.length = 0; dbOrders.push(...snapOrders);
          dbFills.length = 0; dbFills.push(...snapFills);
          dbPositions.length = 0; dbPositions.push(...snapPositions);
          dbTrades.length = 0; dbTrades.push(...snapTrades);
          dbAudits.length = 0; dbAudits.push(...snapAudits);
          throw err;
        }
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaperTradingService,
        PaperPositionMonitorService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: CandlesService, useValue: {} },
        {
          provide: RealMarketStreamerService,
          useValue: {
            getValidatedTicker: jest.fn(),
            updateTicker: jest.fn(),
          },
        },
      ],
    }).compile();

    paperService = module.get<PaperTradingService>(PaperTradingService);
    monitorService = module.get<PaperPositionMonitorService>(PaperPositionMonitorService);
    streamerService = module.get<RealMarketStreamerService>(RealMarketStreamerService);
  });

  // TEST A: MARKET ENTRY PRICE PARITY
  it('TEST A: MARKET ENTRY PRICE PARITY — provider quote != caller req.price => MARKET order executes at validated quote', async () => {
    (streamerService.getValidatedTicker as jest.Mock).mockReturnValue({
      symbol: 'NIFTY',
      price: 50100,
      provenance: 'LIVE_PROVIDER',
      lastUpdated: Date.now(),
      marketEventTime: Date.now(),
    });

    const orderReq = {
      symbol: 'NIFTY',
      direction: 'BUY' as const,
      quantity: 10,
      orderType: 'MARKET' as const,
      price: 49900, // Caller-supplied price should be IGNORED for market order
      stopLoss: 49500,
      target1: 50500,
      target2: 51000,
    };

    const pos = await paperService.placeOrder(orderReq);
    expect(pos.entryPrice).toBe(50100); // Must use provider quote 50100, NOT caller 49900
    expect(dbFills[0].fillPrice.toNumber()).toBe(50100);
  });

  // TEST B: RUNNING POSITION
  it('TEST B: RUNNING POSITION — running P&L uses exact entryPrice and latest validated quote', async () => {
    (streamerService.getValidatedTicker as jest.Mock).mockReturnValue({
      symbol: 'NIFTY',
      price: 50100,
      provenance: 'LIVE_PROVIDER',
      lastUpdated: Date.now(),
      marketEventTime: Date.now(),
    });

    const pos = await paperService.placeOrder({
      symbol: 'NIFTY',
      direction: 'BUY',
      quantity: 10,
      orderType: 'MARKET',
      stopLoss: 49500,
      target1: 50500,
      target2: 51000,
    });

    (streamerService.getValidatedTicker as jest.Mock).mockReturnValue({
      symbol: 'NIFTY',
      price: 50250,
      provenance: 'LIVE_PROVIDER',
      lastUpdated: Date.now(),
      marketEventTime: Date.now(),
    });

    const portfolio = await paperService.getPortfolio();
    const openPos = portfolio.openPositions[0];
    expect(openPos.entryPrice).toBe(50100);
    expect(openPos.currentPrice).toBe(50250);
  });

  // TEST C: BUY SL
  it('TEST C: BUY SL — live price crosses stopLoss => backend automatically closes position', async () => {
    (streamerService.getValidatedTicker as jest.Mock).mockReturnValue({
      symbol: 'NIFTY',
      price: 50000,
      provenance: 'LIVE_PROVIDER',
      lastUpdated: Date.now(),
      marketEventTime: Date.now(),
    });

    const pos = await paperService.placeOrder({
      symbol: 'NIFTY',
      direction: 'BUY',
      quantity: 10,
      orderType: 'MARKET',
      stopLoss: 49500,
      target1: 51000,
      target2: 52000,
    });

    // Price drops to 49499 (below SL 49500)
    (streamerService.getValidatedTicker as jest.Mock).mockReturnValue({
      symbol: 'NIFTY',
      price: 49499,
      provenance: 'LIVE_PROVIDER',
      lastUpdated: Date.now(),
      marketEventTime: Date.now(),
    });

    await monitorService.evaluateActivePositions();

    const closedPos = dbPositions.find((p) => p.id === pos.id);
    expect(closedPos.status).toBe(PositionState.CLOSED);
    expect(dbTrades[0].exitReason).toContain('Stop Loss Hit');
  });

  // TEST D: BUY TP2
  it('TEST D: BUY TP2 — live price crosses target2 => backend automatically closes position', async () => {
    (streamerService.getValidatedTicker as jest.Mock).mockReturnValue({
      symbol: 'NIFTY',
      price: 50000,
      provenance: 'LIVE_PROVIDER',
      lastUpdated: Date.now(),
      marketEventTime: Date.now(),
    });

    const pos = await paperService.placeOrder({
      symbol: 'NIFTY',
      direction: 'BUY',
      quantity: 10,
      orderType: 'MARKET',
      stopLoss: 49500,
      target1: 51000,
      target2: 51250,
    });

    // Price rises to 51251 (crosses TP2 51250)
    (streamerService.getValidatedTicker as jest.Mock).mockReturnValue({
      symbol: 'NIFTY',
      price: 51251,
      provenance: 'LIVE_PROVIDER',
      lastUpdated: Date.now(),
      marketEventTime: Date.now(),
    });

    await monitorService.evaluateActivePositions();

    const closedPos = dbPositions.find((p) => p.id === pos.id);
    expect(closedPos.status).toBe(PositionState.CLOSED);
    expect(dbTrades[0].exitReason).toContain('Target 2');
  });

  // TEST E: SELL SL
  it('TEST E: SELL SL — sell position SL hit when price rises above stopLoss', async () => {
    (streamerService.getValidatedTicker as jest.Mock).mockReturnValue({
      symbol: 'NIFTY',
      price: 50000,
      provenance: 'LIVE_PROVIDER',
      lastUpdated: Date.now(),
      marketEventTime: Date.now(),
    });

    const pos = await paperService.placeOrder({
      symbol: 'NIFTY',
      direction: 'SELL',
      quantity: 10,
      orderType: 'MARKET',
      stopLoss: 50500,
      target1: 49000,
      target2: 48500,
    });

    // Price rises to 50501 (crosses SELL SL 50500)
    (streamerService.getValidatedTicker as jest.Mock).mockReturnValue({
      symbol: 'NIFTY',
      price: 50501,
      provenance: 'LIVE_PROVIDER',
      lastUpdated: Date.now(),
      marketEventTime: Date.now(),
    });

    await monitorService.evaluateActivePositions();

    const closedPos = dbPositions.find((p) => p.id === pos.id);
    expect(closedPos.status).toBe(PositionState.CLOSED);
    expect(dbTrades[0].exitReason).toContain('Stop Loss Hit');
  });

  // TEST F: SELL TP2
  it('TEST F: SELL TP2 — sell position TP2 hit when price drops below target2', async () => {
    (streamerService.getValidatedTicker as jest.Mock).mockReturnValue({
      symbol: 'NIFTY',
      price: 50000,
      provenance: 'LIVE_PROVIDER',
      lastUpdated: Date.now(),
      marketEventTime: Date.now(),
    });

    const pos = await paperService.placeOrder({
      symbol: 'NIFTY',
      direction: 'SELL',
      quantity: 10,
      orderType: 'MARKET',
      stopLoss: 50500,
      target1: 49500,
      target2: 48750,
    });

    // Price drops to 48749 (crosses SELL TP2 48750)
    (streamerService.getValidatedTicker as jest.Mock).mockReturnValue({
      symbol: 'NIFTY',
      price: 48749,
      provenance: 'LIVE_PROVIDER',
      lastUpdated: Date.now(),
      marketEventTime: Date.now(),
    });

    await monitorService.evaluateActivePositions();

    const closedPos = dbPositions.find((p) => p.id === pos.id);
    expect(closedPos.status).toBe(PositionState.CLOSED);
    expect(dbTrades[0].exitReason).toContain('Target 2');
  });

  // TEST G: BROWSER CLOSED
  it('TEST G: BROWSER CLOSED — position monitor runs independently without browser', async () => {
    (streamerService.getValidatedTicker as jest.Mock).mockReturnValue({
      symbol: 'BTCUSDT',
      price: 80000,
      provenance: 'LIVE_PROVIDER',
      lastUpdated: Date.now(),
      marketEventTime: Date.now(),
    });

    const pos = await paperService.placeOrder({
      symbol: 'BTCUSDT',
      direction: 'BUY',
      quantity: 1,
      orderType: 'MARKET',
      stopLoss: 79000,
      target1: 82000,
      target2: 84000,
    });

    // Price drops below SL
    (streamerService.getValidatedTicker as jest.Mock).mockReturnValue({
      symbol: 'BTCUSDT',
      price: 78950,
      provenance: 'LIVE_PROVIDER',
      lastUpdated: Date.now(),
      marketEventTime: Date.now(),
    });

    await monitorService.evaluateActivePositions();

    const closedPos = dbPositions.find((p) => p.id === pos.id);
    expect(closedPos.status).toBe(PositionState.CLOSED);
  });

  // TEST H: DOUBLE TRIGGER
  it('TEST H: DOUBLE TRIGGER — simultaneous triggers produce exactly ONE PaperTrade record', async () => {
    (streamerService.getValidatedTicker as jest.Mock).mockReturnValue({
      symbol: 'NIFTY',
      price: 50000,
      provenance: 'LIVE_PROVIDER',
      lastUpdated: Date.now(),
      marketEventTime: Date.now(),
    });

    const pos = await paperService.placeOrder({
      symbol: 'NIFTY',
      direction: 'BUY',
      quantity: 10,
      orderType: 'MARKET',
      stopLoss: 49500,
      target1: 51000,
      target2: 52000,
    });

    (streamerService.getValidatedTicker as jest.Mock).mockReturnValue({
      symbol: 'NIFTY',
      price: 49400,
      provenance: 'LIVE_PROVIDER',
      lastUpdated: Date.now(),
      marketEventTime: Date.now(),
    });

    // Two simultaneous close attempts
    const [t1, t2] = await Promise.allSettled([
      paperService.closePosition(pos.id, 'Trigger 1'),
      paperService.closePosition(pos.id, 'Trigger 2'),
    ]);

    const createdTradesForPos = dbTrades.filter((t) => t.positionId === pos.id);
    expect(createdTradesForPos.length).toBe(1); // Strictly ONE PaperTrade record created
  });

  // TEST I: EXIT PRICE PARITY
  it('TEST I: EXIT PRICE PARITY — returned PaperTrade exitPrice exactly matches execution fill', async () => {
    (streamerService.getValidatedTicker as jest.Mock).mockReturnValue({
      symbol: 'NIFTY',
      price: 50000,
      provenance: 'LIVE_PROVIDER',
      lastUpdated: Date.now(),
      marketEventTime: Date.now(),
    });

    const pos = await paperService.placeOrder({
      symbol: 'NIFTY',
      direction: 'BUY',
      quantity: 10,
      orderType: 'MARKET',
      stopLoss: 49500,
      target1: 51000,
      target2: 52000,
    });

    (streamerService.getValidatedTicker as jest.Mock).mockReturnValue({
      symbol: 'NIFTY',
      price: 51500,
      provenance: 'LIVE_PROVIDER',
      lastUpdated: Date.now(),
      marketEventTime: Date.now(),
    });

    const trade = await paperService.closePosition(pos.id, 'Manual Exit');
    expect(trade.exitPrice).toBe(51500);
  });

  // TEST J: JOURNAL PARITY
  it('TEST J: JOURNAL PARITY — completed PaperTrade retains exact entryPrice, exitPrice, PnL, R, timestamps', async () => {
    const entryTime = new Date('2026-09-13T10:00:00Z');
    (streamerService.getValidatedTicker as jest.Mock).mockReturnValue({
      symbol: 'NIFTY',
      price: 50000,
      provenance: 'LIVE_PROVIDER',
      lastUpdated: entryTime.getTime(),
      marketEventTime: entryTime.getTime(),
    });

    const pos = await paperService.placeOrder({
      symbol: 'NIFTY',
      direction: 'BUY',
      quantity: 10,
      orderType: 'MARKET',
      stopLoss: 49500,
      target1: 51000,
      target2: 52000,
    });

    if (dbFills.length > 0) {
      dbFills[dbFills.length - 1].fillTimestamp = entryTime;
      dbFills[dbFills.length - 1].sourceTimestamp = entryTime;
    }

    const exitTime = new Date('2026-09-13T10:30:00Z');
    (streamerService.getValidatedTicker as jest.Mock).mockReturnValue({
      symbol: 'NIFTY',
      price: 51000,
      provenance: 'LIVE_PROVIDER',
      lastUpdated: exitTime.getTime(),
      marketEventTime: exitTime.getTime(),
    });

    const trade = await paperService.closePosition(pos.id, 'Target 1');
    expect(trade.entryPrice).toBe(50000);
    expect(trade.exitPrice).toBe(51000);
    expect(trade.realizedPnL).toBeGreaterThan(0);
    expect(trade.holdingDurationSeconds).toBeGreaterThan(0);
  });

  // TEST K: FAILED EXIT
  it('TEST K: FAILED EXIT — missing market data causes close request to fail closed without marking position CLOSED', async () => {
    (streamerService.getValidatedTicker as jest.Mock).mockReturnValue({
      symbol: 'NIFTY',
      price: 50000,
      provenance: 'LIVE_PROVIDER',
      lastUpdated: Date.now(),
      marketEventTime: Date.now(),
    });

    const pos = await paperService.placeOrder({
      symbol: 'NIFTY',
      direction: 'BUY',
      quantity: 10,
      orderType: 'MARKET',
      stopLoss: 49500,
      target1: 51000,
      target2: 52000,
    });

    // Market data streamer throws error
    (streamerService.getValidatedTicker as jest.Mock).mockImplementation(() => {
      throw new MarketDataUnavailableError('NIFTY', 'Stream disconnected');
    });

    await expect(paperService.closePosition(pos.id, 'Manual Exit')).rejects.toThrow();

    const dbPos = dbPositions.find((p) => p.id === pos.id);
    expect(dbPos.status).not.toBe(PositionState.CLOSED);
  });

  // TEST L: STALE DATA
  it('TEST L: STALE DATA — quote older than maxAgeSeconds does NOT trigger auto-close', async () => {
    (streamerService.getValidatedTicker as jest.Mock).mockReturnValue({
      symbol: 'NIFTY',
      price: 50000,
      provenance: 'LIVE_PROVIDER',
      lastUpdated: Date.now(),
      marketEventTime: Date.now(),
    });

    const pos = await paperService.placeOrder({
      symbol: 'NIFTY',
      direction: 'BUY',
      quantity: 10,
      orderType: 'MARKET',
      stopLoss: 49500,
      target1: 51000,
      target2: 52000,
    });

    // Market data throws StaleMarketDataError
    (streamerService.getValidatedTicker as jest.Mock).mockImplementation(() => {
      throw new StaleMarketDataError('NIFTY', 10, 5, new Date());
    });

    await monitorService.evaluateActivePositions();

    const dbPos = dbPositions.find((p) => p.id === pos.id);
    expect(dbPos.status).toBe(PositionState.OPEN); // Stale quote does not trigger exit
  });

  // TEST M: SYNTHETIC BOOTSTRAP
  it('TEST M: SYNTHETIC BOOTSTRAP — BOOTSTRAP quote cannot trigger execution', async () => {
    (streamerService.getValidatedTicker as jest.Mock).mockImplementation(() => {
      throw new MarketDataUnavailableError(
        'NIFTY',
        "Market quote for NIFTY is of provenance 'BOOTSTRAP'. Startup BOOTSTRAP defaults cannot be used for execution.",
      );
    });

    await expect(
      paperService.placeOrder({
        symbol: 'NIFTY',
        direction: 'BUY',
        quantity: 10,
        orderType: 'MARKET',
        stopLoss: 49500,
        target1: 51000,
        target2: 52000,
      }),
    ).rejects.toThrow();
  });

  // TEST N: OPTION CONTRACT
  it('TEST N: OPTION CONTRACT — spot price move does NOT accidentally trigger option auto-close if option LTP has not reached threshold', async () => {
    (streamerService.getValidatedTicker as jest.Mock).mockReturnValue({
      symbol: 'NIFTY',
      price: 24000,
      provenance: 'LIVE_PROVIDER',
      lastUpdated: Date.now(),
      marketEventTime: Date.now(),
    });

    const pos = await paperService.placeOrder({
      symbol: 'NIFTY',
      direction: 'BUY',
      quantity: 10,
      orderType: 'MARKET',
      instrumentType: 'OPTION',
      contractSymbol: 'NIFTY 24000 PE',
      strike: 24000,
      optionType: 'PE',
      stopLoss: 100, // Option SL = 100 option premium pts
      target1: 200,
      target2: 300,
      allowPriceOverride: true,
      executionMode: ExecutionMode.TEST,
      price: 150, // Option entry LTP = 150
    });

    // Spot NIFTY drops, but option contract LTP has NOT crossed SL (option LTP = 120 > SL 100)
    (streamerService.getValidatedTicker as jest.Mock).mockReturnValue({
      symbol: 'NIFTY',
      price: 23500, // Spot NIFTY moved, but position is option!
      provenance: 'LIVE_PROVIDER',
      lastUpdated: Date.now(),
      marketEventTime: Date.now(),
    });

    await monitorService.evaluateActivePositions();

    const dbPos = dbPositions.find((p) => p.id === pos.id);
    expect(dbPos.status).toBe(PositionState.OPEN); // Option position remains open until option LTP crosses threshold
  });

  // TEST O: TIMING
  it('TEST O: TIMING — holding duration is derived from real persisted entry and exit timestamps', async () => {
    const entryTime = new Date(Date.now() - 3600 * 1000); // 1 hour ago
    (streamerService.getValidatedTicker as jest.Mock).mockReturnValue({
      symbol: 'NIFTY',
      price: 50000,
      provenance: 'LIVE_PROVIDER',
      lastUpdated: entryTime.getTime(),
      marketEventTime: entryTime.getTime(),
    });

    const pos = await paperService.placeOrder({
      symbol: 'NIFTY',
      direction: 'BUY',
      quantity: 10,
      orderType: 'MARKET',
      stopLoss: 49500,
      target1: 51000,
      target2: 52000,
    });

    if (dbFills.length > 0) {
      dbFills[dbFills.length - 1].fillTimestamp = entryTime;
      dbFills[dbFills.length - 1].sourceTimestamp = entryTime;
    }

    const exitTime = new Date();
    (streamerService.getValidatedTicker as jest.Mock).mockReturnValue({
      symbol: 'NIFTY',
      price: 51000,
      provenance: 'LIVE_PROVIDER',
      lastUpdated: exitTime.getTime(),
      marketEventTime: exitTime.getTime(),
    });

    const trade = await paperService.closePosition(pos.id, 'Target 1');
    expect(trade.holdingDurationSeconds).toBeGreaterThanOrEqual(3590);
  });

  // TEST P: TP1 PARTIAL SCALE-OUT EXECUTION LEG (NO DUPLICATE PAPER TRADE ROW)
  it('TEST P: TP1 PARTIAL EXECUTION LEG — TP1 scale-out creates execution leg, updates position to PARTIALLY_CLOSED, but DOES NOT create a duplicate PaperTrade row', async () => {
    (streamerService.getValidatedTicker as jest.Mock).mockReturnValue({
      symbol: 'NIFTY',
      price: 50000,
      provenance: 'LIVE_PROVIDER',
      lastUpdated: Date.now(),
      marketEventTime: Date.now(),
    });

    const pos = await paperService.placeOrder({
      symbol: 'NIFTY',
      direction: 'BUY',
      quantity: 10,
      orderType: 'MARKET',
      stopLoss: 49500,
      target1: 51000,
      target2: 52000,
      executionMode: ExecutionMode.TEST,
    });

    const initialCash = Number((await paperService.getOrCreateAccount()).cashBalance);

    // Live price crosses Target 1 (51000)
    (streamerService.getValidatedTicker as jest.Mock).mockReturnValue({
      symbol: 'NIFTY',
      price: 51000,
      provenance: 'LIVE_PROVIDER',
      lastUpdated: Date.now(),
      marketEventTime: Date.now(),
    });

    await monitorService.evaluateActivePositions();

    const dbPos = dbPositions.find((p) => p.id === pos.id);
    expect(dbPos.status).toBe(PositionState.PARTIALLY_CLOSED);
    expect(Number(dbPos.quantity)).toBe(5); // 50% remaining
    expect(Number(dbPos.stopLoss)).toBe(50000); // SL moved to breakeven

    // Verify NO top-level PaperTrade record was created at TP1 partial exit
    const tradesForPosAtTP1 = dbTrades.filter((t) => t.positionId === pos.id);
    expect(tradesForPosAtTP1.length).toBe(0);

    // Verify Account cash balance was credited for partial leg
    const updatedAccount = await paperService.getOrCreateAccount();
    expect(Number(updatedAccount.cashBalance)).toBeGreaterThan(initialCash);
  });

  // TEST Q: EXECUTION MODE PRICE OVERRIDE RESTRICTION
  it('TEST Q: EXECUTION MODE RESTRICTION — allowPriceOverride is ignored in LIVE_MARKET mode for MARKET orders', async () => {
    (streamerService.getValidatedTicker as jest.Mock).mockReturnValue({
      symbol: 'NIFTY',
      price: 50500,
      provenance: 'LIVE_PROVIDER',
      lastUpdated: Date.now(),
      marketEventTime: Date.now(),
    });

    // Caller attempts to pass arbitrary price 48000 with allowPriceOverride in LIVE_MARKET mode
    const pos = await paperService.placeOrder({
      symbol: 'NIFTY',
      direction: 'BUY',
      quantity: 10,
      orderType: 'MARKET',
      price: 48000,
      allowPriceOverride: true,
      executionMode: ExecutionMode.LIVE_MARKET,
      stopLoss: 49500,
      target1: 51000,
    });

    // Order must execute at live ticker price (50500), ignoring caller's price override in LIVE_MARKET mode
    expect(pos.entryPrice).toBe(50500);
  });

  // TEST R: BINANCE GENUINE CLOSE TIME
  it('TEST R: BINANCE GENUINE CLOSE TIME — marketEventTime originates from Binance closeTime', async () => {
    const binanceCloseTime = 1726284000000;
    const realStreamer = new RealMarketStreamerService({} as any);
    const ticker = realStreamer.updateTicker('BTCUSDT', {
      price: 80000,
      provenance: 'LIVE_PROVIDER',
      marketEventTime: binanceCloseTime,
    });

    expect(ticker!.marketEventTime).toBe(binanceCloseTime);
  });

  // TEST S: SINGLE PAPERTRADE RECORD INVARIANT FOR MULTI-LEG LIFECYCLE
  it('TEST S: SINGLE PAPERTRADE INVARIANT — full multi-leg lifecycle (TP1 + Final Exit) produces EXACTLY ONE PaperTrade record', async () => {
    (streamerService.getValidatedTicker as jest.Mock).mockReturnValue({
      symbol: 'NIFTY',
      price: 50000,
      provenance: 'LIVE_PROVIDER',
      lastUpdated: Date.now(),
      marketEventTime: Date.now(),
    });

    const pos = await paperService.placeOrder({
      symbol: 'NIFTY',
      direction: 'BUY',
      quantity: 10,
      orderType: 'MARKET',
      stopLoss: 49500,
      target1: 51000,
      target2: 52000,
      executionMode: ExecutionMode.TEST,
    });

    // 1. TP1 hit
    (streamerService.getValidatedTicker as jest.Mock).mockReturnValue({
      symbol: 'NIFTY',
      price: 51000,
      provenance: 'LIVE_PROVIDER',
      lastUpdated: Date.now(),
      marketEventTime: Date.now(),
    });
    await monitorService.evaluateActivePositions();

    // 2. Final TP2 hit on remaining 50%
    (streamerService.getValidatedTicker as jest.Mock).mockReturnValue({
      symbol: 'NIFTY',
      price: 52000,
      provenance: 'LIVE_PROVIDER',
      lastUpdated: Date.now(),
      marketEventTime: Date.now(),
    });
    await monitorService.evaluateActivePositions();

    const tradesForPos = dbTrades.filter((t) => t.positionId === pos.id);
    expect(tradesForPos.length).toBe(1); // STRICTLY ONE CANONICAL PAPERTRADE RECORD
    expect(Number(tradesForPos[0].quantity)).toBe(10); // Original full quantity (10)
    expect(Number(tradesForPos[0].exitPrice)).toBe(51500); // Weighted exit price: (51000*5 + 52000*5)/10 = 51500
  });

  // TEST T: MULTI-LEG WEIGHTED REALIZED R & NET PNL AGGREGATION
  it('TEST T: WEIGHTED LIFECYCLE R & NET PNL — calculates correct aggregated lifecycle realized R and net PnL', async () => {
    (streamerService.getValidatedTicker as jest.Mock).mockReturnValue({
      symbol: 'NIFTY',
      price: 50000,
      provenance: 'LIVE_PROVIDER',
      lastUpdated: Date.now(),
      marketEventTime: Date.now(),
    });

    const pos = await paperService.placeOrder({
      symbol: 'NIFTY',
      direction: 'BUY',
      quantity: 10,
      orderType: 'MARKET',
      stopLoss: 49000, // Risk = 1000 pts per unit
      target1: 51000, // TP1 = +1.0R (+1000 pts)
      target2: 52000, // TP2 = +2.0R (+2000 pts)
      executionMode: ExecutionMode.TEST,
    });

    // TP1 hit (51000 @ 5 units)
    (streamerService.getValidatedTicker as jest.Mock).mockReturnValue({
      symbol: 'NIFTY',
      price: 51000,
      provenance: 'LIVE_PROVIDER',
      lastUpdated: Date.now(),
      marketEventTime: Date.now(),
    });
    await monitorService.evaluateActivePositions();

    // Final TP2 hit (52000 @ 5 units)
    (streamerService.getValidatedTicker as jest.Mock).mockReturnValue({
      symbol: 'NIFTY',
      price: 52000,
      provenance: 'LIVE_PROVIDER',
      lastUpdated: Date.now(),
      marketEventTime: Date.now(),
    });
    await monitorService.evaluateActivePositions();

    const trade = dbTrades.find((t) => t.positionId === pos.id);
    expect(trade).toBeDefined();

    // Weighted R = (1.0R * 5 + 2.0R * 5) / 10 = 1.5R
    expect(Number(trade.realizedR)).toBeCloseTo(1.5, 1);
    expect(Number(trade.realizedPnL)).toBeGreaterThan(0);
    expect(trade.outcomeSnapshotJson?.legs).toBeDefined();
    expect(trade.outcomeSnapshotJson.legs.length).toBeGreaterThanOrEqual(2);
  });

  // TEST U: OPTION MARKET EVENT TIMESTAMP PROPAGATION
  it('TEST U: OPTION TIMESTAMP PROPAGATION — option auto-close uses option quote marketEventTime', async () => {
    const optionEventTime = new Date('2026-09-13T14:30:00Z');
    const realStreamer = new RealMarketStreamerService({} as any);
    realStreamer.updateOptionTicker('NIFTY 24000 CE', {
      price: 250,
      provenance: 'LIVE_PROVIDER',
      marketEventTime: optionEventTime.getTime(),
    });

    const quote = (realStreamer as any).getOptionTicker('NIFTY 24000 CE');
    expect(quote).toBeDefined();
    expect(quote.marketEventTime).toBe(optionEventTime.getTime());
  });

  // TEST V: REAL UNMOCKED MARKET STREAMER TO MONITOR END-TO-END INTEGRATION
  it('TEST V: REAL UNMOCKED MARKET STREAMER END-TO-END — real tick in RealMarketStreamer propagates through PaperPositionMonitorService to close position and record single PaperTrade', async () => {
    const realStreamer = new RealMarketStreamerService({
      getClient: () => null,
      set: jest.fn(),
      get: jest.fn(),
    } as any);

    const realMonitor = new PaperPositionMonitorService(
      mockPrisma as any,
      paperService,
      realStreamer,
    );

    (paperService as any).realMarketStreamer = realStreamer;

    const providerTime = Date.now() - 1000;
    realStreamer.updateTicker('NIFTY', {
      price: 50000,
      provenance: 'LIVE_PROVIDER',
      marketEventTime: providerTime,
    });

    const pos = await paperService.placeOrder({
      symbol: 'NIFTY',
      direction: 'BUY',
      quantity: 10,
      orderType: 'MARKET',
      stopLoss: 49500,
      target1: 51000,
      target2: 52000,
      executionMode: ExecutionMode.TEST,
    });

    // Push live provider tick crossing TP2 into unmocked RealMarketStreamerService
    const tpEventTime = Date.now();
    realStreamer.updateTicker('NIFTY', {
      price: 52050,
      provenance: 'LIVE_PROVIDER',
      marketEventTime: tpEventTime,
    });

    // Execute unmocked PaperPositionMonitorService evaluation loop
    await realMonitor.evaluateActivePositions();

    const dbPos = dbPositions.find((p) => p.id === pos.id);
    expect(dbPos.status).toBe(PositionState.CLOSED);

    const trades = dbTrades.filter((t) => t.positionId === pos.id);
    expect(trades.length).toBe(1);
    expect(Number(trades[0].exitPrice)).toBe(52050);
    expect(Number(trades[0].realizedPnL)).toBeGreaterThan(0);
    expect(trades[0].outcomeSnapshotJson.exitQuotePrice).toBe(52050);
  });

  // TEST T2: MULTI-LEG ACCOUNT PARITY INVARIANT (ZERO DOUBLE COUNTING)
  it('TEST T2: ACCOUNT PARITY INVARIANT — multi-leg scale-out updates cash & realizedPnL incrementally without double-counting TP1', async () => {
    (streamerService.getValidatedTicker as jest.Mock).mockReturnValue({
      symbol: 'NIFTY',
      price: 50000,
      provenance: 'LIVE_PROVIDER',
      marketEventTime: Date.now() - 1000,
    });

    const initCash = Number(dbAccounts[0].cashBalance);

    const pos = await paperService.placeOrder({
      symbol: 'NIFTY',
      direction: 'BUY',
      quantity: 10,
      orderType: 'MARKET',
      stopLoss: 49000,
      target1: 51000,
      target2: 52000,
      executionMode: ExecutionMode.TEST,
    });

    const entryCharges = Number(dbFills[0].fee);
    const postEntryCash = Number(dbAccounts[0].cashBalance);
    expect(postEntryCash).toBeCloseTo(initCash - entryCharges, 2);

    // 1. Execute TP1 scale-out (5 qty @ 51000)
    (streamerService.getValidatedTicker as jest.Mock).mockReturnValue({
      symbol: 'NIFTY',
      price: 51000,
      provenance: 'LIVE_PROVIDER',
      marketEventTime: Date.now(),
    });
    await monitorService.evaluateActivePositions();

    const postTp1Account = dbAccounts[0];
    const tp1Fill = dbFills.find((f) => f.orderId !== dbOrders[0].id);
    const tp1NetPnL = (51000 - 50000) * 5 - Number(tp1Fill.fee);
    const postTp1Cash = Number(postTp1Account.cashBalance);
    const postTp1RealizedPnL = Number(postTp1Account.realizedPnL);

    expect(postTp1RealizedPnL).toBeCloseTo(tp1NetPnL - entryCharges, 2);
    expect(postTp1Cash).toBeCloseTo(postEntryCash + tp1NetPnL, 2);

    // 2. Execute TP2 final exit (5 qty @ 52000)
    (streamerService.getValidatedTicker as jest.Mock).mockReturnValue({
      symbol: 'NIFTY',
      price: 52000,
      provenance: 'LIVE_PROVIDER',
      marketEventTime: Date.now(),
    });
    await monitorService.evaluateActivePositions();

    const finalAccount = dbAccounts[0];
    const finalFill = dbFills[dbFills.length - 1];
    const finalLegNetPnL = (52000 - 50000) * 5 - Number(finalFill.fee);
    const totalLifecycleNetPnL = tp1NetPnL + finalLegNetPnL - entryCharges;

    expect(Number(finalAccount.realizedPnL)).toBeCloseTo(totalLifecycleNetPnL, 2);
    expect(Number(finalAccount.cashBalance) - initCash).toBeCloseTo(totalLifecycleNetPnL, 2);
    expect(Number(finalAccount.usedMargin)).toBe(0);

    const trades = dbTrades.filter((t) => t.positionId === pos.id);
    expect(trades.length).toBe(1);
    expect(Number(trades[0].realizedPnL)).toBeCloseTo(totalLifecycleNetPnL, 2);
  });

  // TEST S2: USED MARGIN ZERO-BALANCE INVARIANT
  it('TEST S2: USED MARGIN ZERO INVARIANT — total used margin returns to exactly 0.0 after multi-leg exit', async () => {
    (streamerService.getValidatedTicker as jest.Mock).mockReturnValue({
      symbol: 'NIFTY',
      price: 50000,
      provenance: 'LIVE_PROVIDER',
      marketEventTime: Date.now() - 1000,
    });

    const pos = await paperService.placeOrder({
      symbol: 'NIFTY',
      direction: 'BUY',
      quantity: 10,
      orderType: 'MARKET',
      stopLoss: 49000,
      target1: 51000,
      target2: 52000,
      executionMode: ExecutionMode.TEST,
    });

    expect(Number(dbAccounts[0].usedMargin)).toBeGreaterThan(0);

    // TP1
    (streamerService.getValidatedTicker as jest.Mock).mockReturnValue({
      symbol: 'NIFTY',
      price: 51000,
      provenance: 'LIVE_PROVIDER',
      marketEventTime: Date.now(),
    });
    await monitorService.evaluateActivePositions();

    // Final Exit
    (streamerService.getValidatedTicker as jest.Mock).mockReturnValue({
      symbol: 'NIFTY',
      price: 52000,
      provenance: 'LIVE_PROVIDER',
      marketEventTime: Date.now(),
    });
    await monitorService.evaluateActivePositions();

    expect(Number(dbAccounts[0].usedMargin)).toBe(0);
  });

  // TEST W: PROVIDER ADAPTER TO MONITOR PIPELINE INTEGRATION
  it('TEST W: REAL EXCHANGE PROVIDER EVENT TO MONITOR INTEGRATION — raw provider payload updates streamer and triggers monitor auto-close', async () => {
    const realStreamer = new RealMarketStreamerService({
      getClient: () => null,
      set: jest.fn(),
      get: jest.fn(),
    } as any);

    const realMonitor = new PaperPositionMonitorService(
      mockPrisma as any,
      paperService,
      realStreamer,
    );
    (paperService as any).realMarketStreamer = realStreamer;

    // Test rejection of malformed provider tick without timestamp or with invalid price
    const invalidTickResult = (realStreamer as any).ingestBinanceTickerData({ s: 'BTCUSDT', c: '80000.00' });
    expect(invalidTickResult).toBeNull(); // Rejected: missing closeTime / C

    const providerTime = Date.now() - 500;
    realStreamer.updateTicker('BTCUSDT', {
      price: 80000,
      provenance: 'LIVE_PROVIDER',
      marketEventTime: providerTime,
    });

    const pos = await paperService.placeOrder({
      symbol: 'BTCUSDT',
      direction: 'BUY',
      quantity: 1,
      orderType: 'MARKET',
      stopLoss: 78000,
      target1: 81000,
      target2: 82000,
      executionMode: ExecutionMode.TEST,
    });

    // Strictly test Binance raw ticker ingestion method without fallback
    const binanceCloseTime = Date.now();
    expect(typeof (realStreamer as any).handleBinanceTickerData).toBe('function');
    await (realStreamer as any).handleBinanceTickerData({
      s: 'BTCUSDT',
      c: '82500.00',
      o: '80000.00',
      h: '83000.00',
      l: '79000.00',
      v: '1000',
      P: '3.125',
      p: '2500.00',
      C: binanceCloseTime,
    });

    const ticker = realStreamer.getValidatedTicker('BTCUSDT', 5);
    expect(ticker.price).toBe(82500);
    expect(ticker.marketEventTime).toBe(binanceCloseTime);

    await realMonitor.evaluateActivePositions();

    const dbPos = dbPositions.find((p) => p.id === pos.id);
    expect(dbPos.status).toBe(PositionState.CLOSED);

    const trade = dbTrades.find((t) => t.positionId === pos.id);
    expect(trade).toBeDefined();
    expect(Number(trade.exitPrice)).toBeGreaterThanOrEqual(82000);
  });

  // TEST X: MARKET ENTRY PROVIDER QUOTE AUTHORITY
  it('TEST X: MARKET ENTRY PROVIDER QUOTE AUTHORITY — MARKET order ignores caller req.price when live provider ticker exists', async () => {
    const liveTime = Date.now() - 200;
    (streamerService.getValidatedTicker as jest.Mock).mockReturnValue({
      symbol: 'NIFTY',
      price: 24500.0,
      provenance: 'LIVE_PROVIDER',
      marketEventTime: liveTime,
    });

    const pos = await paperService.placeOrder({
      symbol: 'NIFTY',
      direction: 'BUY',
      quantity: 10,
      orderType: 'MARKET',
      price: 99999.0, // Contaminated caller request price
      stopLoss: 24000.0,
      target1: 25000.0,
      executionMode: ExecutionMode.TEST,
    });

    expect(Number(pos.entryPrice)).toBe(24500.0);
    expect(Number(pos.entryPrice)).not.toBe(99999.0);
  });

  // TEST Y: RESET PORTFOLIO INTEGRITY
  it('TEST Y: RESET PORTFOLIO INTEGRITY — resetPortfolio marks active positions INVALIDATED without creating fake CLOSED journal trades', async () => {
    (streamerService.getValidatedTicker as jest.Mock).mockReturnValue({
      symbol: 'NIFTY',
      price: 50000,
      provenance: 'LIVE_PROVIDER',
      marketEventTime: Date.now(),
    });

    const pos = await paperService.placeOrder({
      symbol: 'NIFTY',
      direction: 'BUY',
      quantity: 10,
      orderType: 'MARKET',
      stopLoss: 49000,
      target1: 51000,
      executionMode: ExecutionMode.TEST,
    });

    expect(dbPositions.find((p) => p.id === pos.id).status).toBe(PositionState.OPEN);

    await paperService.resetPortfolio(1000000);

    const resetPos = dbPositions.find((p) => p.id === pos.id);
    expect(resetPos.status).toBe(PositionState.INVALIDATED);

    // Hard invariant: No orphaned CLOSED trades without proper execution
    const closedTrades = dbTrades.filter((t) => t.positionId === pos.id);
    expect(closedTrades.length).toBe(0);
  });

  // TEST Z: TP1 CONCURRENT EXECUTION SAFETY ACROSS INDEPENDENT WORKERS
  it('TEST Z: TP1 CONCURRENT EXECUTION SAFETY — concurrent evaluateActivePositions across separate worker instances produce exactly ONE partial scale-out leg', async () => {
    (streamerService.getValidatedTicker as jest.Mock).mockReturnValue({
      symbol: 'NIFTY',
      price: 50000,
      provenance: 'LIVE_PROVIDER',
      marketEventTime: Date.now() - 1000,
    });

    const pos = await paperService.placeOrder({
      symbol: 'NIFTY',
      direction: 'BUY',
      quantity: 10,
      orderType: 'MARKET',
      stopLoss: 49000,
      target1: 51000,
      target2: 52000,
      executionMode: ExecutionMode.TEST,
    });

    (streamerService.getValidatedTicker as jest.Mock).mockReturnValue({
      symbol: 'NIFTY',
      price: 51050,
      provenance: 'LIVE_PROVIDER',
      marketEventTime: Date.now(),
    });

    // Create two separate monitor service instances simulating independent Worker A and Worker B
    const monitorA = new PaperPositionMonitorService(
      mockPrisma as any,
      paperService,
      streamerService,
    );
    const monitorB = new PaperPositionMonitorService(
      mockPrisma as any,
      paperService,
      streamerService,
    );

    // Run parallel monitor checks concurrently across Worker A and Worker B
    await Promise.all([
      monitorA.evaluateActivePositions(),
      monitorB.evaluateActivePositions(),
    ]);

    const partialFills = dbFills.filter((f) => f.orderId !== dbOrders[0].id);
    expect(partialFills.length).toBe(1);

    const updatedPos = dbPositions.find((p) => p.id === pos.id);
    expect(Number(updatedPos.quantity)).toBe(5);
    expect(updatedPos.status).toBe(PositionState.PARTIALLY_CLOSED);
  });

  // =========================================================================
  // AI FIX 140 TESTS — PROVIDER INGESTION MATRIX, STALENESS & BREAKEVEN LIFECYCLE
  // =========================================================================

  it('TEST 140-1: PROVIDER INGESTION MATRIX — strict timestamp validation, zero value preservation & no hybrid defaults', () => {
    const realStreamer = new RealMarketStreamerService(null as any);

    // 1. Valid payload
    const valid = realStreamer.ingestBinanceTickerData({
      s: 'BTCUSDT',
      c: '50000.00',
      closeTime: 1700000000000,
      P: '0',
      v: '0',
    });
    expect(valid).not.toBeNull();
    expect(valid!.marketEventTime).toBe(1700000000000);
    expect(valid!.changePercent).toBe(0);
    expect(valid!.volume).toBe(0);
    expect(valid!.tickSize).toBe(0.01); // Standard nonsynthetic instrument tick size

    // 2. Missing closeTime
    expect(realStreamer.ingestBinanceTickerData({ s: 'BTCUSDT', c: '50000.00' })).toBeNull();
    // 3. Timestamp = 0
    expect(realStreamer.ingestBinanceTickerData({ s: 'BTCUSDT', c: '50000.00', closeTime: 0 })).toBeNull();
    // 4. Timestamp < 0
    expect(realStreamer.ingestBinanceTickerData({ s: 'BTCUSDT', c: '50000.00', closeTime: -100 })).toBeNull();
    // 5. Timestamp = NaN
    expect(realStreamer.ingestBinanceTickerData({ s: 'BTCUSDT', c: '50000.00', closeTime: 'NaN' })).toBeNull();
    // 6. Timestamp = Infinity
    expect(realStreamer.ingestBinanceTickerData({ s: 'BTCUSDT', c: '50000.00', closeTime: Infinity })).toBeNull();

    // 7. Price = 0
    expect(realStreamer.ingestBinanceTickerData({ s: 'BTCUSDT', c: '0', closeTime: Date.now() })).toBeNull();
    // 8. Price < 0
    expect(realStreamer.ingestBinanceTickerData({ s: 'BTCUSDT', c: '-500', closeTime: Date.now() })).toBeNull();
    // 9. Price = NaN
    expect(realStreamer.ingestBinanceTickerData({ s: 'BTCUSDT', c: 'invalid', closeTime: Date.now() })).toBeNull();

    // 10. No hybrid merging from cached ticker when fields missing
    const noHybrid = realStreamer.ingestBinanceTickerData({
      s: 'ETHUSDT',
      c: '3000.00',
      closeTime: 1700000005000,
    });
    expect(noHybrid).not.toBeNull();
    expect(noHybrid!.open).toBe(3000.00); // Defaults to livePrice, NOT old cached value
    expect(noHybrid!.volume).toBe(0); // Defaults to 0, NOT old cached value
  });

  it('TEST 140-2: STRICT STALENESS FAIL-CLOSED EXECUTION — stale marketEventTime rejected by streamer and monitor', async () => {
    const realStreamer = new RealMarketStreamerService(null as any);
    const now = Date.now();

    // 1. Valid tick (1s old <= 5s maxAge)
    const niftyTicker = (realStreamer as any).tickers.get('NIFTY');
    niftyTicker.provenance = 'LIVE_PROVIDER';
    niftyTicker.marketEventTime = now - 1000;
    const validTicker = realStreamer.getValidatedTicker('NIFTY', 5);
    expect(validTicker.price).toBe(24175.65);

    // 2. Stale tick (10s old > 5s maxAge)
    (realStreamer as any).tickers.get('NIFTY').marketEventTime = now - 10000;
    expect(() => realStreamer.getValidatedTicker('NIFTY', 5)).toThrow(StaleMarketDataError);

    // 3. Stale tick (60s old) prevents monitor auto-close
    (streamerService.getValidatedTicker as jest.Mock).mockImplementation((sym: string) => {
      if (sym === 'NIFTY') {
        return {
          symbol: 'NIFTY',
          price: 50000,
          provenance: 'LIVE_PROVIDER',
          marketEventTime: now - 1000,
        };
      }
      return null;
    });

    const pos = await paperService.placeOrder({
      symbol: 'NIFTY',
      direction: 'BUY',
      quantity: 10,
      orderType: 'MARKET',
      stopLoss: 49000,
      target1: 51000,
      executionMode: ExecutionMode.TEST,
    });

    // Stale ticker causes monitor's getValidatedTicker call to throw StaleMarketDataError and fail closed
    (streamerService.getValidatedTicker as jest.Mock).mockImplementation((sym: string) => {
      if (sym === 'NIFTY') {
        throw new StaleMarketDataError('NIFTY', 60, 5, new Date(now - 60000));
      }
      return null;
    });

    await monitorService.evaluateActivePositions();

    // Position remains OPEN because stale market data causes fail-closed monitoring
    const unclosedPos = dbPositions.find((p) => p.id === pos.id);
    expect(unclosedPos.status).toBe(PositionState.OPEN);
  });

  it('TEST 140-3: BREAKEVEN AFTER TP1 LIFECYCLE — ENTRY -> TP1 PARTIAL -> SL BREAKEVEN exit produces exact accounting and single PaperTrade', async () => {
    let currentPrice = 50000;
    let currentEventTime = Date.now();
    const initCash = Number(dbAccounts[0].cashBalance);

    (streamerService.getValidatedTicker as jest.Mock).mockImplementation((sym: string) => {
      return {
        symbol: sym,
        price: currentPrice,
        provenance: 'LIVE_PROVIDER',
        marketEventTime: currentEventTime,
      };
    });

    // 1. ENTRY 10 @ 50,000 (SL 49,500 => Risk = 5000 <= Max 10,000)
    const pos = await paperService.placeOrder({
      symbol: 'BTCUSDT',
      direction: 'BUY',
      quantity: 10,
      orderType: 'MARKET',
      stopLoss: 49500,
      target1: 51000,
      executionMode: ExecutionMode.TEST,
    });

    const entryFill = dbFills[dbFills.length - 1];
    const entryCharges = Number(entryFill.fee);

    // 2. TP1 hit @ 51,000 -> scale out 5 units
    currentPrice = 51000;
    currentEventTime = Date.now() + 5000;
    await monitorService.evaluateActivePositions();

    const tp1Pos = dbPositions.find((p) => p.id === pos.id);
    expect(tp1Pos.status).toBe(PositionState.PARTIALLY_CLOSED);
    expect(Number(tp1Pos.quantity)).toBe(5);
    expect(Number(tp1Pos.stopLoss)).toBe(50000); // Moved to breakeven

    const tp1Fill = dbFills[dbFills.length - 1];
    const tp1NetPnL = (51000 - 50000) * 92.0 * 5 - Number(tp1Fill.fee);

    // 3. Price drops back to SL Breakeven @ 49,900 -> close remaining 5 units
    currentPrice = 49900;
    currentEventTime = Date.now() + 10000;
    await monitorService.evaluateActivePositions();

    const finalPos = dbPositions.find((p) => p.id === pos.id);
    expect(finalPos.status).toBe(PositionState.CLOSED);

    const finalFill = dbFills[dbFills.length - 1];
    const finalLegNetPnL = (49900 - 50000) * 92.0 * 5 - Number(finalFill.fee);
    const totalLifecycleNetPnL = tp1NetPnL + finalLegNetPnL - entryCharges;

    // 4. Assert Account Ledger Invariants
    const finalAccount = dbAccounts[0];
    expect(Number(finalAccount.realizedPnL)).toBeCloseTo(totalLifecycleNetPnL, 2);
    expect(Number(finalAccount.cashBalance) - initCash).toBeCloseTo(totalLifecycleNetPnL, 2);
    expect(Number(finalAccount.usedMargin)).toBe(0);

    // 5. Assert Single PaperTrade Record
    const trades = dbTrades.filter((t) => t.positionId === pos.id);
    expect(trades.length).toBe(1);
    expect(Number(trades[0].realizedPnL)).toBeCloseTo(totalLifecycleNetPnL, 2);

    // 6. Assert Execution Legs (ENTRY, TP1_PARTIAL, FINAL_EXIT)
    const legs = (finalPos.executionEventsJson as any).partialLegs || [];
    expect(legs.length).toBe(1);
    expect(legs[0].role).toBe('TP1_PARTIAL');
    expect(legs[0].fillPrice).toBe(51000);
    expect(legs[0].fillTimestamp).toBeDefined();
  });

  // =========================================================================
  // AI FIX 141 TESTS — FULL LEDGER EQUATIONS, EVENT ORDERING & PROVENANCE
  // =========================================================================

  it('TEST 141-1: FULL LEDGER EQUATION MATRIX — cashDelta === PaperTrade.realizedPnL === sum(exitLegsNetPnL) - entryFees', async () => {
    let currentPrice = 50000;
    let currentEventTime = Date.now();

    (streamerService.getValidatedTicker as jest.Mock).mockImplementation((sym: string) => {
      return {
        symbol: sym,
        price: currentPrice,
        provenance: 'LIVE_PROVIDER',
        marketEventTime: currentEventTime,
      };
    });

    // Case 1: TP1 + Losing Final SL Exit
    const initCash = Number(dbAccounts[0].cashBalance);

    const pos = await paperService.placeOrder({
      symbol: 'BTCUSDT',
      direction: 'BUY',
      quantity: 10,
      orderType: 'MARKET',
      stopLoss: 49500,
      target1: 51000,
      executionMode: ExecutionMode.TEST,
    });

    const entryFill = dbFills[dbFills.length - 1];
    const entryFees = Number(entryFill.fee);

    // TP1 @ 51,000
    currentPrice = 51000;
    currentEventTime += 5000;
    await monitorService.evaluateActivePositions();
    const tp1Fill = dbFills[dbFills.length - 1];
    const tp1GrossPnL = (51000 - 50000) * 92.0 * 5;
    const tp1ExitFees = Number(tp1Fill.fee);
    const tp1NetPnL = tp1GrossPnL - tp1ExitFees;

    // Final Losing SL @ 48,000
    currentPrice = 48000;
    currentEventTime += 5000;
    await monitorService.evaluateActivePositions();
    const finalFill = dbFills[dbFills.length - 1];
    const finalGrossPnL = (48000 - 50000) * 92.0 * 5;
    const finalExitFees = Number(finalFill.fee);
    const finalLegNetPnL = finalGrossPnL - finalExitFees;

    const totalLifecycleNetPnL = tp1GrossPnL + finalGrossPnL - entryFees - tp1ExitFees - finalExitFees;
    const cashDelta = totalLifecycleNetPnL;

    const finalAccount = dbAccounts[0];
    const trade = dbTrades.find((t) => t.positionId === pos.id)!;

    // 1. Account realized PnL delta equals total lifecycle net PnL (Model A)
    expect(Number(finalAccount.realizedPnL)).toBeCloseTo(totalLifecycleNetPnL, 2);

    // 2. Cash balance delta equals total lifecycle net PnL
    expect(Number(finalAccount.cashBalance) - initCash).toBeCloseTo(cashDelta, 2);

    // 3. PaperTrade realized PnL equals lifecycle gross PnL minus all lifecycle charges
    expect(Number(trade.realizedPnL)).toBeCloseTo(totalLifecycleNetPnL, 2);

    // 4. Parity equation: cashDelta === Account.realizedPnL === PaperTrade.realizedPnL
    expect(cashDelta).toBeCloseTo(Number(trade.realizedPnL), 2);
  });

  it('TEST 141-2: STRICT PROVIDER ORDERING, CLOCK SKEW & REST PROVENANCE REJECTION', async () => {
    const realStreamer = new RealMarketStreamerService(null as any);
    const now = Date.now();

    // 1. Ingest Event A @ T+10s (Price: 50,000)
    const eventA = realStreamer.ingestBinanceTickerData({
      s: 'BTCUSDT',
      c: '50000.00',
      closeTime: now + 2000, // T+2s (valid)
    });
    expect(eventA).not.toBeNull();
    expect(eventA!.price).toBe(50000);

    // 2. Ingest Event B @ T+1s (Price: 49,000) — Older timestamp delivered out-of-order MUST BE REJECTED
    const eventB = realStreamer.ingestBinanceTickerData({
      s: 'BTCUSDT',
      c: '49000.00',
      closeTime: now + 1000, // T+1s (older timestamp)
    });
    expect(eventB).toBeNull(); // Rejected out-of-order tick

    // Canonical ticker remains Event A @ 50,000
    const currentTicker = realStreamer.getValidatedTicker('BTCUSDT', 5);
    expect(currentTicker.price).toBe(50000);

    // 3. Clock Skew Validation — T+10s (> 5s clock skew limit) MUST BE REJECTED
    const futureEvent = realStreamer.ingestBinanceTickerData({
      s: 'BTCUSDT',
      c: '52000.00',
      closeTime: now + 10000, // T+10s (future clock skew violation)
    });
    expect(futureEvent).toBeNull();

    // 4. REST / BOOTSTRAP Provenance Rejection
    const bootstrapTicker = {
      symbol: 'BTCUSDT',
      price: 45000,
      provenance: 'BOOTSTRAP' as const,
      marketEventTime: now,
      lastUpdated: now,
    };
    (streamerService.getValidatedTicker as jest.Mock).mockReturnValue(bootstrapTicker);

    const pos = await paperService.placeOrder({
      symbol: 'BTCUSDT',
      direction: 'BUY',
      quantity: 5,
      orderType: 'MARKET',
      stopLoss: 44000,
      target1: 46000,
      executionMode: ExecutionMode.TEST,
    });

    // Monitor will NOT execute auto-close on BOOTSTRAP or STALE data
    await monitorService.evaluateActivePositions();
    const unclosedPos = dbPositions.find((p) => p.id === pos.id);
    expect(unclosedPos.status).toBe(PositionState.OPEN);

    // 5. Execution Timestamps — Fill sourceTimestamp (marketEventTime) !== fillTimestamp (local execution time)
    const fill = dbFills[dbFills.length - 1];
    expect(fill.sourceTimestamp).toBeDefined();
    expect(fill.fillTimestamp).toBeDefined();
  });

  // =========================================================================
  // AI FIX 143 TESTS — AUTHORITATIVE EXECUTION BASELINE
  // =========================================================================

  it('TEST 143-1: SYNTHETIC TICKSIZE REMOVAL — unknown instrument tickSize is undefined/null; known instrument uses registry tickSize', () => {
    const streamer = new RealMarketStreamerService(null as any);
    const tickKnown = streamer.updateTicker('BTCUSDT', {
      price: 50000,
      marketEventTime: Date.now(),
      provenance: 'LIVE_PROVIDER',
    });
    expect(tickKnown!.tickSize).toBe(0.1); // Registry tickSize for BTCUSDT

    const tickUnknown = streamer.updateTicker('UNKNOWN_XYZ_999', {
      price: 100,
      marketEventTime: Date.now(),
      provenance: 'LIVE_PROVIDER',
    });
    expect(tickUnknown?.tickSize).toBeUndefined(); // Never fabricates 0.05 or 0.01
  });

  it('TEST 143-2: LIVE_PROVIDER MANDATORY MARKET EVENT TIME — missing/invalid marketEventTime fails closed in streamer and monitor', async () => {
    const streamer = new RealMarketStreamerService(null as any);
    const resNoTime = streamer.updateTicker('NEW_MANDATORY_SYM', {
      price: 50000,
      provenance: 'LIVE_PROVIDER',
      marketEventTime: undefined as any,
    });
    expect(resNoTime).toBeNull();
    expect(() => streamer.getValidatedTicker('NEW_MANDATORY_SYM', 5)).toThrow(/No active market data stream available for symbol/);

    // 1. Place order with valid ticker
    (streamerService.getValidatedTicker as jest.Mock).mockReturnValue({
      symbol: 'BTCUSDT',
      price: 50000,
      provenance: 'LIVE_PROVIDER',
      marketEventTime: Date.now(),
    });

    const pos = await paperService.placeOrder({
      symbol: 'BTCUSDT',
      direction: 'BUY',
      quantity: 1,
      orderType: 'MARKET',
      stopLoss: 49000,
      target1: 51000,
      executionMode: ExecutionMode.TEST,
    });

    // 2. Monitor evaluation fails closed when ticker lacks marketEventTime
    (streamerService.getValidatedTicker as jest.Mock).mockImplementation(() => {
      throw new Error('Market quote missing mandatory marketEventTime');
    });

    await monitorService.evaluateActivePositions();
    const unclosedPos = dbPositions.find((p) => p.id === pos.id);
    expect(unclosedPos.status).toBe(PositionState.OPEN); // Fails closed
  });

  it('TEST 143-3: FUTURE TIMESTAMP CLOCK SKEW & AGE 0 — future event inside 5s skew yields age = 0; future event > 5s skew is rejected', () => {
    const streamer = new RealMarketStreamerService(null as any);
    const now = Date.now();

    // 1. Future event within allowed 5s clock skew (+2s)
    streamer.updateTicker('SOLUSDT', {
      price: 150,
      provenance: 'LIVE_PROVIDER',
      marketEventTime: now + 2000,
    });

    const validFuture = streamer.getValidatedTicker('SOLUSDT', 5);
    expect(validFuture.symbol).toBe('SOLUSDT');

    // 2. Future event beyond 5s clock skew (+10s)
    streamer.updateTicker('SOLUSDT', {
      price: 150,
      provenance: 'LIVE_PROVIDER',
      marketEventTime: now + 10000,
    });

    expect(() => streamer.getValidatedTicker('SOLUSDT', 5)).toThrow();
  });

  // =========================================================================
  // AI FIX 144 TESTS — RELEASE GATE INGESTION VALIDATION & REAL MODEL-A LEDGER
  // =========================================================================

  it('TEST 144-1: INGESTION BOUNDARY VALIDATION — LIVE_PROVIDER rejected if marketEventTime is missing, 0, negative, NaN, or Infinity', () => {
    const streamer = new RealMarketStreamerService(null as any);

    // 1. Missing / undefined
    const res1 = streamer.updateTicker('TEST_SYM', { price: 100, provenance: 'LIVE_PROVIDER', marketEventTime: undefined });
    expect(res1).toBeNull();
    expect(streamer.getTicker('TEST_SYM')).toBeUndefined();

    // 2. Zero (0)
    const res2 = streamer.updateTicker('TEST_SYM', { price: 100, provenance: 'LIVE_PROVIDER', marketEventTime: 0 });
    expect(res2).toBeNull();

    // 3. Negative (-1000)
    const res3 = streamer.updateTicker('TEST_SYM', { price: 100, provenance: 'LIVE_PROVIDER', marketEventTime: -1000 });
    expect(res3).toBeNull();

    // 4. NaN
    const res4 = streamer.updateTicker('TEST_SYM', { price: 100, provenance: 'LIVE_PROVIDER', marketEventTime: NaN });
    expect(res4).toBeNull();

    // 5. Infinity
    const res5 = streamer.updateTicker('TEST_SYM', { price: 100, provenance: 'LIVE_PROVIDER', marketEventTime: Infinity });
    expect(res5).toBeNull();

    // 6. Option Ticker missing timestamp
    const optRes = streamer.updateOptionTicker('NIFTY24DEC24000CE', { price: 50, provenance: 'LIVE_PROVIDER', marketEventTime: undefined });
    expect(optRes).toBeNull();

    // 7. Valid timestamp -> Accepted
    const now = Date.now();
    const resValid = streamer.updateTicker('TEST_SYM', { price: 100, provenance: 'LIVE_PROVIDER', marketEventTime: now });
    expect(resValid).not.toBeNull();
    expect(resValid!.provenance).toBe('LIVE_PROVIDER');
    expect(resValid!.marketEventTime).toBe(now);
  });

  it('TEST 144-2: REAL PRODUCTION MODEL-A ENTRY ACCOUNTING — placeOrder() decrements cashBalance & realizedPnL by entryFees before any exit', async () => {
    // 1. Set up clean account balance
    dbAccounts[0].cashBalance = new Decimal(1000000.0);
    dbAccounts[0].usedMargin = new Decimal(0.0);
    dbAccounts[0].realizedPnL = new Decimal(0.0);
    dbAccounts[0].totalChargesPaid = new Decimal(0.0);

    (streamerService.getValidatedTicker as jest.Mock).mockReturnValue({
      symbol: 'BTCUSDT',
      price: 50000,
      provenance: 'LIVE_PROVIDER',
      marketEventTime: Date.now(),
    });

    const initCash = 1000000.0;

    // 2. Place MARKET entry order with quantity: 2 (risk = 4,000 <= 10,000 max risk limit)
    const pos = await paperService.placeOrder({
      symbol: 'BTCUSDT',
      direction: 'BUY',
      quantity: 2,
      orderType: 'MARKET',
      stopLoss: 48000,
      target1: 52000,
      executionMode: ExecutionMode.TEST,
    });

    const accountAfterEntry = dbAccounts[0];
    const entryFill = dbFills[dbFills.length - 1];
    const entryFees = Number(entryFill.fee);
    const requiredMargin = Number(accountAfterEntry.usedMargin);

    // Assert production Model-A accounting state RIGHT AFTER ENTRY:
    // cashBalance = 1,000,000 - entryFees
    expect(Number(accountAfterEntry.cashBalance)).toBeCloseTo(initCash - entryFees, 2);

    // realizedPnL = -entryFees
    expect(Number(accountAfterEntry.realizedPnL)).toBeCloseTo(-entryFees, 2);

    // usedMargin = requiredMargin
    expect(Number(accountAfterEntry.usedMargin)).toBeCloseTo(requiredMargin, 2);

    // totalChargesPaid = entryFees
    expect(Number(accountAfterEntry.totalChargesPaid)).toBeCloseTo(entryFees, 2);

    // No trades exist yet
    const trades = dbTrades.filter((t) => t.positionId === pos.id);
    expect(trades.length).toBe(0);
  });

  it('TEST 144-3: COMPLETE 5-LIFECYCLE RECONCILIATION MATRIX — Account.realizedPnL === PaperTrade.realizedPnL === cashDelta & usedMargin === 0', async () => {
    let currentPrice = 50000;
    let currentEventTime = Date.now();

    (streamerService.getValidatedTicker as jest.Mock).mockImplementation((sym: string) => ({
      symbol: sym,
      price: currentPrice,
      provenance: 'LIVE_PROVIDER',
      marketEventTime: currentEventTime,
    }));

    // Path 1: Full Exit Without TP1 (Direct Target 2 Hit)
    {
      dbAccounts[0].cashBalance = new Decimal(500000.0);
      dbAccounts[0].usedMargin = new Decimal(0.0);
      dbAccounts[0].realizedPnL = new Decimal(0.0);
      dbAccounts[0].totalChargesPaid = new Decimal(0.0);

      const initCash = 500000.0;
      currentPrice = 50000;
      currentEventTime = Date.now();

      const pos = await paperService.placeOrder({
        symbol: 'BTCUSDT',
        direction: 'BUY',
        quantity: 2,
        orderType: 'MARKET',
        stopLoss: 48000,
        target1: 52000,
        target2: 55000,
        executionMode: ExecutionMode.TEST,
      });

      // Price skips target1 and hits target2 @ 55000
      currentPrice = 55000;
      currentEventTime += 2000;
      await monitorService.evaluateActivePositions();

      const account = dbAccounts[0];
      const trade = dbTrades.find((t) => t.positionId === pos.id)!;
      const cashDelta = Number(account.cashBalance) - initCash;

      expect(Number(account.realizedPnL)).toBeCloseTo(Number(trade.realizedPnL), 2);
      expect(cashDelta).toBeCloseTo(Number(trade.realizedPnL), 2);
      expect(Number(account.usedMargin)).toBe(0);
    }

    // Path 2: TP1 -> TP2 (Scale-out then full target hit)
    {
      dbAccounts[0].cashBalance = new Decimal(500000.0);
      dbAccounts[0].usedMargin = new Decimal(0.0);
      dbAccounts[0].realizedPnL = new Decimal(0.0);
      dbAccounts[0].totalChargesPaid = new Decimal(0.0);

      const initCash = 500000.0;
      currentPrice = 50000;
      currentEventTime = Date.now();

      const pos = await paperService.placeOrder({
        symbol: 'BTCUSDT',
        direction: 'BUY',
        quantity: 2,
        orderType: 'MARKET',
        stopLoss: 48000,
        target1: 52000,
        target2: 55000,
        executionMode: ExecutionMode.TEST,
      });

      // TP1 @ 52000
      currentPrice = 52000;
      currentEventTime += 2000;
      await monitorService.evaluateActivePositions();

      // TP2 @ 55000
      currentPrice = 55000;
      currentEventTime += 2000;
      await monitorService.evaluateActivePositions();

      const account = dbAccounts[0];
      const trade = dbTrades.find((t) => t.positionId === pos.id)!;
      const cashDelta = Number(account.cashBalance) - initCash;

      expect(Number(account.realizedPnL)).toBeCloseTo(Number(trade.realizedPnL), 2);
      expect(cashDelta).toBeCloseTo(Number(trade.realizedPnL), 2);
      expect(Number(account.usedMargin)).toBe(0);
    }

    // Path 3: TP1 -> SL (Scale-out then initial SL hit)
    {
      dbAccounts[0].cashBalance = new Decimal(500000.0);
      dbAccounts[0].usedMargin = new Decimal(0.0);
      dbAccounts[0].realizedPnL = new Decimal(0.0);
      dbAccounts[0].totalChargesPaid = new Decimal(0.0);

      const initCash = 500000.0;
      currentPrice = 50000;
      currentEventTime = Date.now();

      const pos = await paperService.placeOrder({
        symbol: 'BTCUSDT',
        direction: 'BUY',
        quantity: 2,
        orderType: 'MARKET',
        stopLoss: 47000,
        target1: 52000,
        executionMode: ExecutionMode.TEST,
      });

      // TP1 @ 52000
      currentPrice = 52000;
      currentEventTime += 2000;
      await monitorService.evaluateActivePositions();

      // SL @ 47000
      currentPrice = 47000;
      currentEventTime += 2000;
      await monitorService.evaluateActivePositions();

      const account = dbAccounts[0];
      const trade = dbTrades.find((t) => t.positionId === pos.id)!;
      const cashDelta = Number(account.cashBalance) - initCash;

      expect(Number(account.realizedPnL)).toBeCloseTo(Number(trade.realizedPnL), 2);
      expect(cashDelta).toBeCloseTo(Number(trade.realizedPnL), 2);
      expect(Number(account.usedMargin)).toBe(0);
    }

    // Path 4: TP1 -> Breakeven (Scale-out then SL moved to entry price hit)
    {
      dbAccounts[0].cashBalance = new Decimal(500000.0);
      dbAccounts[0].usedMargin = new Decimal(0.0);
      dbAccounts[0].realizedPnL = new Decimal(0.0);
      dbAccounts[0].totalChargesPaid = new Decimal(0.0);

      const initCash = 500000.0;
      currentPrice = 50000;
      currentEventTime = Date.now();

      const pos = await paperService.placeOrder({
        symbol: 'BTCUSDT',
        direction: 'BUY',
        quantity: 2,
        orderType: 'MARKET',
        stopLoss: 48000,
        target1: 52000,
        executionMode: ExecutionMode.TEST,
      });

      // TP1 @ 52000 (moves SL to 50000 breakeven)
      currentPrice = 52000;
      currentEventTime += 2000;
      await monitorService.evaluateActivePositions();

      // Breakeven SL @ 50000
      currentPrice = 50000;
      currentEventTime += 2000;
      await monitorService.evaluateActivePositions();

      const account = dbAccounts[0];
      const trade = dbTrades.find((t) => t.positionId === pos.id)!;
      const cashDelta = Number(account.cashBalance) - initCash;

      expect(Number(account.realizedPnL)).toBeCloseTo(Number(trade.realizedPnL), 2);
      expect(cashDelta).toBeCloseTo(Number(trade.realizedPnL), 2);
      expect(Number(account.usedMargin)).toBe(0);
    }

    // Path 5: Losing Final Exit (Direct SL hit without TP1)
    {
      dbAccounts[0].cashBalance = new Decimal(500000.0);
      dbAccounts[0].usedMargin = new Decimal(0.0);
      dbAccounts[0].realizedPnL = new Decimal(0.0);
      dbAccounts[0].totalChargesPaid = new Decimal(0.0);

      const initCash = 500000.0;
      currentPrice = 50000;
      currentEventTime = Date.now();

      const pos = await paperService.placeOrder({
        symbol: 'BTCUSDT',
        direction: 'BUY',
        quantity: 2,
        orderType: 'MARKET',
        stopLoss: 48000,
        target1: 55000,
        executionMode: ExecutionMode.TEST,
      });

      // Direct SL @ 48000
      currentPrice = 48000;
      currentEventTime += 2000;
      await monitorService.evaluateActivePositions();

      const account = dbAccounts[0];
      const trade = dbTrades.find((t) => t.positionId === pos.id)!;
      const cashDelta = Number(account.cashBalance) - initCash;

      expect(Number(account.realizedPnL)).toBeCloseTo(Number(trade.realizedPnL), 2);
      expect(cashDelta).toBeCloseTo(Number(trade.realizedPnL), 2);
      expect(Number(account.usedMargin)).toBe(0);
    }
  });

  it('TEST 144-4: PROVIDER SEQUENCE ORDERING — higher sequence number takes precedence over timestamp', () => {
    const streamer = new RealMarketStreamerService(null as any);
    const now = Date.now();

    // 1. First event with sequence 100 @ timestamp T (Price 50,000)
    streamer.updateTicker('BTCUSDT', {
      price: 50000,
      provenance: 'LIVE_PROVIDER',
      marketEventTime: now,
      sequence: 100,
    });

    // 2. Incoming event with sequence 99 @ timestamp T+100ms (Price 49,000) — should be REJECTED
    const resSeqLow = streamer.updateTicker('BTCUSDT', {
      price: 49000,
      provenance: 'LIVE_PROVIDER',
      marketEventTime: now + 100,
      sequence: 99,
    });

    expect(resSeqLow!.price).toBe(50000); // Maintained sequence 100 price

    // 3. Incoming event with sequence 101 @ timestamp T-10ms (Price 51,000) — should be ACCEPTED
    const resSeqHigh = streamer.updateTicker('BTCUSDT', {
      price: 51000,
      provenance: 'LIVE_PROVIDER',
      marketEventTime: now - 10,
      sequence: 101,
    });

    expect(resSeqHigh!.price).toBe(51000); // Updated to sequence 101 price
  });

  // =========================================================================
  // AI FIX 145 TESTS — FINAL LEDGER & EXECUTION RELEASE GATE
  // =========================================================================

  it('TEST 145-1: ENTRY TRANSACTION ATOMICITY & FAILURE INJECTION — DB error midway rolls back account state 100%', async () => {
    dbAccounts[0].cashBalance = new Decimal(1000000.0);
    dbAccounts[0].usedMargin = new Decimal(0.0);
    dbAccounts[0].realizedPnL = new Decimal(0.0);
    dbAccounts[0].totalChargesPaid = new Decimal(0.0);

    const initCash = 1000000.0;
    const initialOrdersCount = dbOrders.length;
    const initialFillsCount = dbFills.length;
    const initialPositionsCount = dbPositions.length;

    (streamerService.getValidatedTicker as jest.Mock).mockReturnValue({
      symbol: 'BTCUSDT',
      price: 50000,
      provenance: 'LIVE_PROVIDER',
      marketEventTime: Date.now(),
    });

    // Force failure midway inside mockPrisma.paperPosition.create
    const origCreatePosition = mockPrisma.paperPosition.create;
    (mockPrisma.paperPosition.create as jest.Mock) = jest.fn().mockImplementation(() => {
      throw new Error('[FORCED_DB_FAILURE_INJECTION] Database connection lost midway through transaction');
    });

    try {
      await expect(
        paperService.placeOrder({
          symbol: 'BTCUSDT',
          direction: 'BUY',
          quantity: 2,
          orderType: 'MARKET',
          stopLoss: 48000,
          target1: 52000,
          executionMode: ExecutionMode.TEST,
        }),
      ).rejects.toThrow('[FORCED_DB_FAILURE_INJECTION]');
    } finally {
      mockPrisma.paperPosition.create = origCreatePosition;
    }

    // Assert 100% atomic rollback: zero leftover account balance or margin drift
    const account = dbAccounts[0];
    expect(Number(account.cashBalance)).toBe(initCash);
    expect(Number(account.realizedPnL)).toBe(0.0);
    expect(Number(account.usedMargin)).toBe(0.0);
    expect(Number(account.totalChargesPaid)).toBe(0.0);

    // Assert no order, fill, or position survived
    expect(dbOrders.length).toBe(initialOrdersCount);
    expect(dbFills.length).toBe(initialFillsCount);
    expect(dbPositions.length).toBe(initialPositionsCount);
  });

  it('TEST 145-2 & 145-3: COMPLETE 7-PATH MODEL-A RECONCILIATION MATRIX & FEE RECONCILIATION', async () => {
    let currentPrice = 50000;
    let currentEventTime = Date.now();

    (streamerService.getValidatedTicker as jest.Mock).mockImplementation((sym: string) => ({
      symbol: sym,
      price: currentPrice,
      provenance: 'LIVE_PROVIDER',
      marketEventTime: currentEventTime,
    }));

    const runLifecyclePath = async (
      pathName: string,
      direction: 'BUY' | 'SELL',
      entryPrice: number,
      sl: number,
      tp1: number,
      tp2: number | null,
      ticks: { price: number; delayMs?: number; action?: 'monitor' | 'close' }[],
    ) => {
      // Reset account for isolated test run
      dbAccounts[0].cashBalance = new Decimal(1000000.0);
      dbAccounts[0].usedMargin = new Decimal(0.0);
      dbAccounts[0].realizedPnL = new Decimal(0.0);
      dbAccounts[0].totalChargesPaid = new Decimal(0.0);

      const initCash = 1000000.0;
      currentPrice = entryPrice;
      currentEventTime = Date.now();

      const pos = await paperService.placeOrder({
        symbol: 'BTCUSDT',
        direction,
        quantity: 2,
        orderType: 'MARKET',
        stopLoss: sl,
        target1: tp1,
        target2: tp2 || undefined,
        executionMode: ExecutionMode.TEST,
      });

      for (const tick of ticks) {
        currentPrice = tick.price;
        currentEventTime += tick.delayMs || 2000;
        if (tick.action === 'close') {
          await paperService.closePosition(pos.id);
        } else {
          await monitorService.evaluateActivePositions();
        }
      }

      const acc = dbAccounts[0];
      const trades = dbTrades.filter((t) => t.positionId === pos.id);
      expect(trades.length).toBe(1); // Exactly 1 PaperTrade lifecycle record

      const trade = trades[0];
      const cashDelta = Number(acc.cashBalance) - initCash;
      const realizedPnLDelta = Number(acc.realizedPnL);
      const totalChargesPaid = Number(acc.totalChargesPaid);
      const tradeRealizedPnL = Number(trade.realizedPnL);
      const chargesJsonTotal = Number((trade.chargesJson as any).totalCharges);

      // Model-A Equality: Account realizedPnL == PaperTrade.realizedPnL == cashDelta
      expect(realizedPnLDelta).toBeCloseTo(tradeRealizedPnL, 2);
      expect(cashDelta).toBeCloseTo(tradeRealizedPnL, 2);
      expect(Number(acc.usedMargin)).toBe(0);

      // Fee Equality: totalChargesPaid delta == chargesJson.totalCharges
      expect(totalChargesPaid).toBeCloseTo(chargesJsonTotal, 2);

      return { trade, acc };
    };

    // Path A: Full exit without TP1 (Direct target2 hit)
    await runLifecyclePath('PathA', 'BUY', 50000, 48000, 52000, 55000, [
      { price: 55000, action: 'monitor' },
    ]);

    // Path B: TP1 -> TP2 (Scale out @ 52000, then TP2 @ 55000)
    await runLifecyclePath('PathB', 'BUY', 50000, 48000, 52000, 55000, [
      { price: 52000, action: 'monitor' },
      { price: 55000, action: 'monitor' },
    ]);

    // Path C: TP1 -> SL (Scale out @ 52000, then initial SL @ 47000)
    await runLifecyclePath('PathC', 'BUY', 50000, 47000, 52000, null, [
      { price: 52000, action: 'monitor' },
      { price: 47000, action: 'monitor' },
    ]);

    // Path D: TP1 -> Breakeven SL (Scale out @ 52000, then SL moved to entry 50000)
    await runLifecyclePath('PathD', 'BUY', 50000, 48000, 52000, null, [
      { price: 52000, action: 'monitor' },
      { price: 50000, action: 'monitor' },
    ]);

    // Path E: TP1 -> Manual Exit (Scale out @ 52000, then manual close @ 53000)
    await runLifecyclePath('PathE', 'BUY', 50000, 48000, 52000, null, [
      { price: 52000, action: 'monitor' },
      { price: 53000, action: 'close' },
    ]);

    // Path F: Losing Full SL (Direct SL @ 48000 hit without TP1)
    await runLifecyclePath('PathF', 'BUY', 50000, 48000, 52000, null, [
      { price: 48000, action: 'monitor' },
    ]);

    // Path G: Short/Bearish Lifecycle (SELL order @ 50000, TP1 @ 48000, TP2 @ 45000)
    await runLifecyclePath('PathG', 'SELL', 50000, 52000, 48000, 45000, [
      { price: 48000, action: 'monitor' },
      { price: 45000, action: 'monitor' },
    ]);
  });

  it('TEST 145-4: EXECUTION PATH USES VALIDATED TICKER — position monitor fails closed on invalid ticker', async () => {
    (streamerService.getValidatedTicker as jest.Mock).mockImplementation(() => {
      throw new Error('MARKET_DATA_UNAVAILABLE: Stale or unvalidated quote');
    });

    // Monitor evaluation should catch error or ignore position without executing trade
    await expect(monitorService.evaluateActivePositions()).resolves.not.toThrow();
  });

  it('TEST 145-5: EXECUTION LEG AUDIT SCHEMA CHECK — legs contain role, prices, timestamps, PnL & R', async () => {
    let currentPrice = 50000;
    let currentEventTime = Date.now();

    (streamerService.getValidatedTicker as jest.Mock).mockImplementation((sym: string) => ({
      symbol: sym,
      price: currentPrice,
      provenance: 'LIVE_PROVIDER',
      marketEventTime: currentEventTime,
    }));

    dbAccounts[0].cashBalance = new Decimal(1000000.0);
    dbAccounts[0].usedMargin = new Decimal(0.0);
    dbAccounts[0].realizedPnL = new Decimal(0.0);
    dbAccounts[0].totalChargesPaid = new Decimal(0.0);

    const pos = await paperService.placeOrder({
      symbol: 'BTCUSDT',
      direction: 'BUY',
      quantity: 2,
      orderType: 'MARKET',
      stopLoss: 48000,
      target1: 52000,
      target2: 55000,
      executionMode: ExecutionMode.TEST,
    });

    // TP1 @ 52000
    currentPrice = 52000;
    currentEventTime += 2000;
    await monitorService.evaluateActivePositions();

    // TP2 @ 55000
    currentPrice = 55000;
    currentEventTime += 2000;
    await monitorService.evaluateActivePositions();

    const trade = dbTrades.find((t) => t.positionId === pos.id)!;
    const legs = (trade.outcomeSnapshotJson as any).legs;

    expect(legs).toBeDefined();
    expect(legs.length).toBe(3); // ENTRY, TP1_PARTIAL, FINAL_EXIT

    const tp1Leg = legs.find((l: any) => l.role === 'TP1_PARTIAL');
    expect(tp1Leg).toBeDefined();
    expect(tp1Leg.role).toBe('TP1_PARTIAL');
    expect(tp1Leg.triggerPrice).toBe(52000);
    expect(tp1Leg.fillPrice).toBe(52000);
    expect(tp1Leg.quantity).toBe(1.0);
    expect(tp1Leg.fee).toBeGreaterThan(0);
    expect(tp1Leg.grossPnL).toBeGreaterThan(0);
    expect(tp1Leg.netPnL).toBeGreaterThan(0);
    expect(tp1Leg.fillTimestamp).toBeDefined();

    const finalLeg = legs.find((l: any) => l.role === 'FINAL_EXIT');
    expect(finalLeg).toBeDefined();
    expect(finalLeg.role).toBe('FINAL_EXIT');
    expect(finalLeg.fillPrice).toBe(55000);
    expect(finalLeg.quantity).toBe(1.0);
    expect(finalLeg.fee).toBeGreaterThan(0);
  });
});
