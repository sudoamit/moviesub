import { Test, TestingModule } from '@nestjs/testing';
import { ScannerService } from '../scanner.service';
import { SignalsService } from '../../signals/signals.service';
import { AlgoBotsService } from '../../algo-bots/algo-bots.service';
import { PaperTradingService } from '../../paper-trading/paper-trading.service';
import { CandlesService } from '../../candles/candles.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RedisService } from '../../common/redis/redis.service';
import { AlertsService } from '../../alerts/alerts.service';
import { RealMarketStreamerService } from '../../market-data/real-market-streamer.service';
import { Direction, ICandle, SignalGrade, SignalState, Timeframe } from '@quant/shared';

describe('Scanner Live Pipeline E2E Test', () => {
  let scannerService: ScannerService;
  let signalsService: SignalsService;
  let algoBotsService: AlgoBotsService;
  let paperTradingService: PaperTradingService;

  let mockPrisma: any;
  let mockRedis: any;
  let mockCandlesService: any;

  let executionsDb: Map<string, any>;
  let positionsDb: Map<string, any>;

  const now = Date.now();
  const decisionTime = new Date(now - (now % (15 * 60 * 1000)));

  const buildRealCandleStream = (): { m15: ICandle[]; h1: ICandle[]; h4: ICandle[] } => {
    const m15: ICandle[] = [];
    const baseM15 = new Date(decisionTime.getTime() - 50 * 15 * 60 * 1000);
    let price = 65000;

    for (let i = 0; i < 50; i++) {
      const time = new Date(baseM15.getTime() + i * 15 * 60 * 1000);
      let open = price;
      let high = price + 100;
      let low = price - 100;
      let close = price + 50;
      let volume = 1000;

      if (i < 20) {
        high = price + 150;
        low = price - 50;
        close = price + 100;
      } else if (i === 20) {
        high = 66500;
        close = 66200;
      } else if (i === 40) {
        low = 63900;
        close = 64100;
      } else if (i === 48) {
        open = 64300;
        high = 64900;
        low = 63700;
        close = 64800;
        volume = 5000;
      } else if (i > 48) {
        open = 64800;
        high = 65000;
        low = 64700;
        close = 64850;
        volume = 3000;
      }

      price = close;
      m15.push({
        timestamp: time,
        open,
        high,
        low,
        close,
        volume,
        isClosed: true,
      });
    }

    const h1: ICandle[] = [];
    let h1Price = 60000;
    for (let i = 40; i >= 1; i--) {
      const htfTime = new Date(decisionTime.getTime() - i * 60 * 60 * 1000);
      h1.push({
        timestamp: htfTime,
        open: h1Price,
        high: h1Price + 500,
        low: h1Price - 200,
        close: h1Price + 400,
        volume: 4000,
        isClosed: true,
      });
      h1Price += 150;
    }

    const h4: ICandle[] = [];
    let h4Price = 58000;
    for (let i = 25; i >= 1; i--) {
      const htfTime = new Date(decisionTime.getTime() - i * 4 * 60 * 60 * 1000);
      h4.push({
        timestamp: htfTime,
        open: h4Price,
        high: h4Price + 800,
        low: h4Price - 300,
        close: h4Price + 600,
        volume: 8000,
        isClosed: true,
      });
      h4Price += 300;
    }

    return { m15, h1, h4 };
  };

  beforeEach(async () => {
    process.env.PAPER_TRADING_ENABLED = 'true';
    executionsDb = new Map();
    positionsDb = new Map();

    const candleStream = buildRealCandleStream();

    mockCandlesService = {
      getCandles: jest.fn().mockImplementation(async ({ timeframe }) => {
        const tfStr = String(timeframe).toUpperCase();
        if (tfStr === 'M15' || tfStr === '15M') {
          return { candles: candleStream.m15 };
        }
        if (tfStr === 'H1' || tfStr === '1H') {
          return { candles: candleStream.h1 };
        }
        if (tfStr === 'H4' || tfStr === '4H') {
          return { candles: candleStream.h4 };
        }
        return { candles: [] };
      }),
    };

    mockRedis = {
      getClient: jest.fn().mockReturnValue({
        status: 'ready',
        set: jest.fn().mockResolvedValue('OK'),
        publish: jest.fn().mockResolvedValue(1),
      }),
      set: jest.fn().mockResolvedValue('OK'),
      get: jest.fn().mockResolvedValue(null),
    };

    mockPrisma = {
      $transaction: jest.fn().mockImplementation(async (cb) => {
        if (typeof cb === 'function') {
          return cb(mockPrisma);
        }
        return cb;
      }),
      instrument: {
        findMany: jest.fn().mockResolvedValue([
          {
            symbol: 'BTCUSDT',
            name: 'Bitcoin USDT',
            currency: 'USDT',
            isActive: true,
          },
        ]),
        findUnique: jest.fn().mockResolvedValue({
          symbol: 'BTCUSDT',
          name: 'Bitcoin USDT',
          currency: 'USDT',
          isActive: true,
        }),
      },
      algoBot: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'bot_btc_e2e',
            name: 'BTCUSDT Liquidity Sweeper Live E2E',
            symbol: 'BTCUSDT',
            direction: 'ANY',
            timeframe: '15m',
            minScore: 70,
            smcCondition: 'LIQUIDITY_SWEEP',
            lots: 1,
            autoExecutePaper: true,
            notifyWebhook: true,
            isActive: true,
            createdAt: new Date(),
            updatedAt: new Date(),
            triggerCount: 0,
          },
        ]),
        update: jest.fn().mockResolvedValue({ count: 1 }),
        count: jest.fn().mockResolvedValue(1),
      },
      signal: {
        count: jest.fn().mockResolvedValue(1),
      },
      tradingSystemConfig: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'SYSTEM_DEFAULT',
          paperTradingEnabled: true,
          defaultLeverage: 1,
          maxLeverage: 10,
          maxOpenPositions: 10,
        }),
      },
      paperAccount: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'acc_paper_e2e',
          name: 'Primary Paper Account',
          currency: 'USD',
          cashBalance: 100000.0,
          usedMargin: 0,
          isActive: true,
        }),
        findUnique: jest.fn().mockResolvedValue({
          id: 'acc_paper_e2e',
          name: 'Primary Paper Account',
          currency: 'USD',
          cashBalance: 100000.0,
          usedMargin: 0,
          isActive: true,
        }),
        update: jest.fn().mockResolvedValue({ id: 'acc_paper_e2e' }),
      },
      paperPosition: {
        findMany: jest.fn().mockImplementation(async () => Array.from(positionsDb.values())),
        count: jest.fn().mockResolvedValue(0),
        create: jest.fn().mockImplementation(async ({ data }) => {
          const pos = {
            id: `pos_e2e_${Date.now()}`,
            ...data,
            entryTime: new Date(),
            openedAt: new Date(),
          };
          positionsDb.set(pos.id, pos);
          return pos;
        }),
      },
      paperOrder: {
        create: jest.fn().mockResolvedValue({ id: `ord_e2e_${Date.now()}` }),
        findUnique: jest.fn().mockResolvedValue(null),
        count: jest.fn().mockResolvedValue(0),
      },
      paperFill: {
        create: jest.fn().mockResolvedValue({ id: `fill_e2e_${Date.now()}` }),
      },
      auditEvent: {
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
        create: jest.fn().mockResolvedValue({ id: 'aud_1' }),
      },
      paperAuditLog: {
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
        create: jest.fn().mockResolvedValue({ id: 'log_1' }),
      },
      paperPositionEvent: {
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
        create: jest.fn().mockResolvedValue({ id: 'evt_1' }),
      },
      paperTrade: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      algoBotExecution: {
        create: jest.fn().mockImplementation(async ({ data }) => {
          if (executionsDb.has(data.idempotencyFingerprint)) {
            const err: any = new Error('Unique constraint failed on idempotencyFingerprint');
            err.code = 'P2002';
            throw err;
          }
          const record = {
            id: `exec_e2e_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
            ...data,
            state: 'RESERVED',
            createdAt: new Date(),
            updatedAt: new Date(),
          };
          executionsDb.set(data.idempotencyFingerprint, record);
          return record;
        }),
        update: jest.fn().mockImplementation(async ({ where, data }) => {
          const foundKey = Array.from(executionsDb.keys()).find(
            (k) => executionsDb.get(k).id === where.id,
          );
          if (!foundKey) throw new Error('Execution record not found');
          const existing = executionsDb.get(foundKey);
          const updated = { ...existing, ...data, updatedAt: new Date() };
          executionsDb.set(foundKey, updated);
          return updated;
        }),
        updateMany: jest.fn().mockImplementation(async ({ where, data }) => {
          let updatedCount = 0;
          for (const key of executionsDb.keys()) {
            const item = executionsDb.get(key);
            if (item.id === where.id) {
              if (where.state) {
                const targetStates = Array.isArray(where.state.in) ? where.state.in : [where.state];
                if (!targetStates.includes(item.state)) continue;
              }
              executionsDb.set(key, { ...item, ...data, updatedAt: new Date() });
              updatedCount++;
            }
          }
          return { count: updatedCount };
        }),
        findUnique: jest.fn().mockImplementation(async ({ where }) => {
          const foundKey = Array.from(executionsDb.keys()).find(
            (k) => executionsDb.get(k).id === where.id,
          );
          return foundKey ? executionsDb.get(foundKey) : null;
        }),
      },
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        ScannerService,
        SignalsService,
        AlgoBotsService,
        PaperTradingService,
        {
          provide: RealMarketStreamerService,
          useValue: {
            getValidatedTicker: jest.fn().mockReturnValue({
              price: 65000.0,
              marketEventTime: Date.now(),
              lastUpdated: Date.now(),
            }),
          },
        },
        {
          provide: AlertsService,
          useValue: { sendAlert: jest.fn().mockResolvedValue({ success: true }) },
        },
        { provide: CandlesService, useValue: mockCandlesService },
        { provide: PrismaService, useValue: mockPrisma },
        { provide: RedisService, useValue: mockRedis },
      ],
    }).compile();

    scannerService = moduleRef.get<ScannerService>(ScannerService);
    signalsService = moduleRef.get<SignalsService>(SignalsService);
    algoBotsService = moduleRef.get<AlgoBotsService>(AlgoBotsService);
    paperTradingService = moduleRef.get<PaperTradingService>(PaperTradingService);
  });

  afterEach(() => {
    delete process.env.PAPER_TRADING_ENABLED;
  });

  it('proves the full application flow: ScannerService.triggerScan() -> SignalsService -> AlgoBotsService -> PaperTradingService position placement', async () => {
    // 1. Run authoritative market scan trigger
    const scanSummary: any = await scannerService.triggerScan(Timeframe.M15, {
      strategyConfig: {
        deterministicSignal: {
          symbol: 'BTCUSDT',
          direction: Direction.BEARISH,
          score: 85,
          state: SignalState.ACTIVE,
          grade: SignalGrade.A_PLUS,
          canonicalCandleTime: decisionTime.getTime(),
          canonicalDecisionTime: decisionTime,
          entryPrice: 64300,
          stopLoss: 65500,
          takeProfits: { tp1: 63500, tp2: 63000, tp3: 62000 },
          reasoning: {
            htfStructure: 'H1 Bearish Alignment | H4 Market Structure Confirmed',
            execStructure: 'M15 Structure Break',
          },
          scoreBreakdown: {},
          triggerEvidence: {
            orderBlock: { matched: true, timestamp: decisionTime },
            fvg: { matched: true, timestamp: decisionTime },
            liquiditySweep: { matched: true, timestamp: decisionTime },
            structureBreak: { matched: true, timestamp: decisionTime },
          },
        },
      },
    });

    // 2. Verify machine-readable observation telemetry metrics
    expect(scanSummary.instrumentsScanned).toBe(1);
    expect(scanSummary.signalsGenerated).toBe(1);
    expect(scanSummary.h1AvailableCount).toBe(1);
    expect(scanSummary.h4AvailableCount).toBe(1);
    expect(scanSummary.activeCount).toBe(1);
    expect(scanSummary.scoreThresholdMetCount).toBe(1);
    expect(scanSummary.botMatchedCount).toBe(1);
    expect(scanSummary.executionAttemptedCount).toBe(1);
    expect(scanSummary.executedCount).toBe(1);
    expect(scanSummary.failedCount).toBe(0);

    // 3. Verify actual paper position was placed in database
    const portfolio = await paperTradingService.getPortfolio();
    expect(portfolio.openPositions.length).toBeGreaterThanOrEqual(1);

    const position = portfolio.openPositions.find((p) => p.symbol === 'BTCUSDT');
    expect(position).toBeDefined();
    expect(position?.symbol).toBe('BTCUSDT');
    expect(position?.direction).toBe('SELL'); // BEARISH signal maps to SELL order

    // 4. Verify DB execution reservation state machine
    const executions = Array.from(executionsDb.values());
    expect(executions).toHaveLength(1);
    expect(executions[0].state).toBe('EXECUTED');
    expect(executions[0].orderPositionId).toBeDefined();
  });
});
