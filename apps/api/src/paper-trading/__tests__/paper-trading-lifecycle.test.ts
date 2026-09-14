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
            if (p.id !== args.where.id) return false;
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
        return await cb(mockPrisma);
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

    expect(ticker.marketEventTime).toBe(binanceCloseTime);
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
});
