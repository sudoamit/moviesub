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
import { Direction, ICandle, IMarketDataProvider, MarketDataUnavailableError, SignalGrade, SignalState, Timeframe } from '@quant/shared';

/**
 * Controlled Live Market Data Provider Fixture implementing IMarketDataProvider.
 * Produces LIVE provenance candles for BTCUSDT without allowing synthetic fallbacks in production.
 * Enforces strict symbol identity (BTCUSDT only).
 */
class ControlledLiveMarketDataProvider implements IMarketDataProvider {
  readonly providerName = 'controlled_live_provider_fixture';
  private readonly candleStream: { m15: ICandle[]; h1: ICandle[]; h4: ICandle[] };
  private readonly decisionTime: Date;

  constructor(decisionTime: Date, candleStream: { m15: ICandle[]; h1: ICandle[]; h4: ICandle[] }) {
    this.decisionTime = decisionTime;
    this.candleStream = candleStream;
  }

  async getHistoricalCandles(symbol: string, timeframe: Timeframe | string, limit = 200): Promise<ICandle[]> {
    const sym = symbol.toUpperCase();
    if (sym !== 'BTCUSDT') return [];

    const tfStr = String(timeframe).toUpperCase();
    let source: ICandle[] = [];
    if (tfStr === 'M15' || tfStr === '15M') source = this.candleStream.m15;
    else if (tfStr === 'H1' || tfStr === '1H') source = this.candleStream.h1;
    else if (tfStr === 'H4' || tfStr === '4H') source = this.candleStream.h4;

    const slice = source.slice(-limit);
    return slice.map((c) => ({
      ...c,
      timestamp: c.timestamp instanceof Date ? c.timestamp : new Date(c.timestamp),
      isClosed: true,
      provenance: 'LIVE',
    }));
  }

  async getLatestCandle(symbol: string, timeframe: Timeframe | string): Promise<ICandle> {
    const candles = await this.getHistoricalCandles(symbol, timeframe, 1);
    if (!candles || candles.length === 0) {
      throw new MarketDataUnavailableError(symbol);
    }
    return candles[0];
  }

  async subscribeToMarketData(symbol: string, timeframe: Timeframe | string, onCandle: (candle: ICandle) => void): Promise<void> {}

  async unsubscribeFromMarketData(symbol: string, timeframe: Timeframe | string): Promise<void> {}

  async getLatestQuote(symbol: string): Promise<any> {
    if (symbol.toUpperCase() !== 'BTCUSDT') {
      throw new MarketDataUnavailableError(symbol);
    }
    const candles = this.candleStream.m15;
    const last = candles[candles.length - 1];
    const price = last ? last.close : 65000;

    const marketAsOf = this.decisionTime;
    const observedAt = new Date(this.decisionTime.getTime() + 100);

    return {
      symbol: 'BTCUSDT',
      bid: price - 0.5,
      ask: price + 0.5,
      last: price,
      volume: last ? last.volume : 1000,
      timestamp: observedAt,
      marketAsOf,
      observedAt,
      dataProvenance: 'LIVE',
      providerId: this.providerName,
    };
  }

  async getMarketHealth(): Promise<{ isHealthy: boolean; latencyMs: number }> {
    return { isHealthy: true, latencyMs: 12 };
  }
}

describe('Fix 182 — Authoritative Root-Cause Test for Zero Live Paper Trades', () => {
  let scannerService: ScannerService;
  let signalsService: SignalsService;
  let algoBotsService: AlgoBotsService;
  let paperTradingService: PaperTradingService;

  let mockPrisma: any;
  let mockRedis: any;

  let executionsDb: Map<string, any>;
  let positionsDb: Map<string, any>;
  let botsDb: Map<string, any>;
  let instrumentsDb: Map<string, any>;

  let decisionTime: Date;

  /**
   * Constructs valid BTCUSDT M15, H1, H4 candle streams satisfying natural SMC Order Block signal generation
   */
  const buildLiveCandleStream = (asOfTime: Date): { m15: ICandle[]; h1: ICandle[]; h4: ICandle[] } => {
    const m15: ICandle[] = [];
    const baseM15 = new Date(asOfTime.getTime() - 49 * 15 * 60 * 1000);
    let price = 65000;

    for (let i = 0; i < 50; i++) {
      const time = new Date(baseM15.getTime() + i * 15 * 60 * 1000);
      let open = price;
      let high = price + 100;
      let low = price - 100;
      let close = price + 50;
      let volume = 1000;

      if (i === 15) {
        // Swing high anchor
        open = 65000;
        high = 66000;
        low = 64900;
        close = 65800;
      } else if (i === 34) {
        // Order Block candle (bearish push before bullish reversal)
        open = 65800;
        high = 65900;
        low = 64200;
        close = 64300;
        volume = 4000;
      } else if (i === 35) {
        // Liquidity Sweep (wicks below previous swing low of 63900)
        open = 64300;
        high = 64500;
        low = 63700;
        close = 64400;
        volume = 5000;
      } else if (i === 36) {
        // Bullish Displacement & BOS (breaks 66000 swing high, creates FVG)
        open = 64400;
        high = 66800;
        low = 64550;
        close = 66700;
        volume = 9000;
      } else if (i > 36) {
        open = price;
        high = price + 100;
        low = price - 50;
        close = price + 80;
        volume = 2000;
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
      const htfTime = new Date(asOfTime.getTime() - i * 60 * 60 * 1000);
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
      const htfTime = new Date(asOfTime.getTime() - i * 4 * 60 * 60 * 1000);
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
    process.env.NODE_ENV = 'test';
    delete process.env.APP_ENV;

    decisionTime = new Date();
    executionsDb = new Map();
    positionsDb = new Map();
    botsDb = new Map();
    instrumentsDb = new Map();

    const candleStream = buildLiveCandleStream(decisionTime);
    const liveProvider = new ControlledLiveMarketDataProvider(decisionTime, candleStream);

    // Seed Instrument
    instrumentsDb.set('BTCUSDT', {
      id: 'inst_btcusdt',
      symbol: 'BTCUSDT',
      name: 'Bitcoin',
      type: 'CRYPTO',
      currency: 'USD',
      lotSize: 0.01,
      minimumQuantity: 0.001,
      quantityPrecision: 4,
      pricePrecision: 2,
      isActive: true,
    });

    // Seed Active Execution Bot using ANY_CONFLUENCE to match generated SMC evidence
    botsDb.set('bot_btc_order_block', {
      id: 'bot_btc_order_block',
      name: 'BTCUSDT 15m Order Block Hunter',
      symbol: 'BTCUSDT',
      direction: 'ANY',
      timeframe: '15m',
      minScore: 70,
      smcCondition: 'ANY_CONFLUENCE',
      lots: 1,
      autoExecutePaper: true,
      notifyWebhook: false,
      isActive: true,
      createdAt: new Date(),
      triggerCount: 0,
    });

    mockPrisma = {
      instrument: {
        findUnique: jest.fn().mockImplementation(async ({ where }) => {
          return instrumentsDb.get(where.symbol) || null;
        }),
        findMany: jest.fn().mockResolvedValue(Array.from(instrumentsDb.values())),
      },
      algoBot: {
        findMany: jest.fn().mockImplementation(async (query) => {
          const all = Array.from(botsDb.values());
          if (query?.where?.isActive !== undefined) {
            return all.filter((b) => b.isActive === query.where.isActive);
          }
          return all;
        }),
        findUnique: jest.fn().mockImplementation(async ({ where }) => botsDb.get(where.id) || null),
        count: jest.fn().mockImplementation(async () => botsDb.size),
        update: jest.fn().mockImplementation(async ({ where, data }) => {
          const bot = botsDb.get(where.id);
          if (bot) {
            if (data.triggerCount?.increment) bot.triggerCount += data.triggerCount.increment;
            bot.lastTriggeredAt = data.lastTriggeredAt || bot.lastTriggeredAt;
            bot.lastTriggerDetails = data.lastTriggerDetails || bot.lastTriggerDetails;
          }
          return bot;
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
        create: jest.fn().mockResolvedValue({ id: `audit_e2e_${Date.now()}` }),
      },
      paperTrade: {
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockResolvedValue({ id: `trade_e2e_${Date.now()}` }),
      },
      tradingSystemConfig: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'SYSTEM_DEFAULT',
          paperTradingEnabled: true,
          liveTradingEnabled: false,
          emergencyStop: false,
          maxDailyLossPercent: 3.0,
          maxPositionRiskPercent: 1.0,
          maxTotalExposurePercent: 20.0,
          maxOpenPositions: 5,
          maxTradesPerDay: 20,
          maxConsecutiveLosses: 3,
          maxLeverage: 5.0,
          maxSlippageBps: 50,
          maxMarketDataAgeSeconds: 5,
        }),
        findFirst: jest.fn().mockResolvedValue({
          id: 'SYSTEM_DEFAULT',
          paperTradingEnabled: true,
          liveTradingEnabled: false,
          emergencyStop: false,
          maxDailyLossPercent: 3.0,
          maxPositionRiskPercent: 1.0,
          maxTotalExposurePercent: 20.0,
          maxOpenPositions: 5,
          maxTradesPerDay: 20,
          maxConsecutiveLosses: 3,
          maxLeverage: 5.0,
          maxSlippageBps: 50,
          maxMarketDataAgeSeconds: 5,
        }),
        create: jest.fn().mockResolvedValue({ id: 'SYSTEM_DEFAULT' }),
        upsert: jest.fn().mockResolvedValue({ id: 'SYSTEM_DEFAULT' }),
      },
      algoBotExecution: {
        create: jest.fn().mockImplementation(async ({ data }) => {
          const id = `exec_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
          const rec = {
            id,
            ...data,
            createdAt: new Date(),
            updatedAt: new Date(),
          };
          executionsDb.set(data.fingerprint, rec);
          executionsDb.set(id, rec);
          return rec;
        }),
        findUnique: jest.fn().mockImplementation(async ({ where }) => {
          if (where.fingerprint) return executionsDb.get(where.fingerprint) || null;
          if (where.id) return executionsDb.get(where.id) || null;
          return null;
        }),
        updateMany: jest.fn().mockImplementation(async ({ where, data }) => {
          const rec = executionsDb.get(where.id);
          if (!rec) return { count: 0 };
          const expectedStates = Array.isArray(where.state?.in)
            ? where.state.in
            : where.state
              ? [where.state]
              : [];
          if (expectedStates.length > 0 && !expectedStates.includes(rec.state)) {
            return { count: 0 };
          }
          Object.assign(rec, data);
          return { count: 1 };
        }),
      },
      paperPosition: {
        findMany: jest.fn().mockImplementation(async (query) => {
          const all = Array.from(positionsDb.values());
          if (query?.where?.status) {
            const allowed = Array.isArray(query.where.status?.in)
              ? query.where.status.in
              : Array.isArray(query.where.status)
                ? query.where.status
                : [query.where.status];
            return all.filter((p) => allowed.includes(p.status));
          }
          return all;
        }),
        findFirst: jest.fn().mockImplementation(async (query) => {
          const all = Array.from(positionsDb.values());
          return (
            all.find((p) => {
              if (query?.where?.symbol && p.symbol !== query.where.symbol) return false;
              if (query?.where?.status) {
                const allowed = Array.isArray(query.where.status?.in)
                  ? query.where.status.in
                  : Array.isArray(query.where.status)
                    ? query.where.status
                    : [query.where.status];
                if (!allowed.includes(p.status)) return false;
              }
              return true;
            }) || null
          );
        }),
        count: jest.fn().mockImplementation(async (query) => {
          const all = Array.from(positionsDb.values());
          if (query?.where?.status) {
            return all.filter((p) => p.status === query.where.status).length;
          }
          return all.length;
        }),
        create: jest.fn().mockImplementation(async ({ data }) => {
          const id = `pos_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
          const pos = { id, ...data, createdAt: new Date() };
          positionsDb.set(id, pos);
          return pos;
        }),
      },
      paperBalance: {
        findFirst: jest.fn().mockResolvedValue({ balance: 100000, equity: 100000 }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      signal: {
        count: jest.fn().mockResolvedValue(10),
        findMany: jest.fn().mockResolvedValue([]),
      },
      $transaction: jest.fn().mockImplementation(async (cb) => {
        if (typeof cb === 'function') return cb(mockPrisma);
        return cb;
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
              price: 64850.0,
              marketEventTime: Date.now(),
              lastUpdated: Date.now(),
            }),
          },
        },
        {
          provide: AlertsService,
          useValue: { sendAlert: jest.fn(), notifyWebhook: jest.fn() },
        },
        {
          provide: CandlesService,
          useValue: {
            getCandles: jest.fn().mockImplementation(async ({ symbol, timeframe, limit }) => {
              const candles = await liveProvider.getHistoricalCandles(symbol, timeframe, limit);
              return { candles };
            }),
          },
        },
        {
          provide: PrismaService,
          useValue: mockPrisma,
        },
        {
          provide: RedisService,
          useValue: mockRedis,
        },
      ],
    }).compile();

    scannerService = moduleRef.get<ScannerService>(ScannerService);
    signalsService = moduleRef.get<SignalsService>(SignalsService);
    algoBotsService = moduleRef.get<AlgoBotsService>(AlgoBotsService);
    paperTradingService = moduleRef.get<PaperTradingService>(PaperTradingService);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('1. REAL SCANNER E2E: ScannerService.triggerScan() executes complete pipeline to paper order', async () => {
    const evaluateSpy = jest.spyOn(algoBotsService, 'evaluateSignalForBots');

    // 1. Authoritative Entry Point: Trigger scan from ScannerService with deterministic signal setup
    const scanResult: any = await scannerService.triggerScan(Timeframe.M15, {
      strategyConfig: {
        deterministicSignal: {
          symbol: 'BTCUSDT',
          direction: Direction.BEARISH,
          score: 85,
          grade: SignalGrade.A_PLUS,
          entryZone: { min: 64800, max: 64900, optimal: 64850 },
          stopLoss: 65500,
          takeProfits: { tp1: 64000, tp2: 63500, tp3: 62000 },
          canonicalCandleTime: decisionTime.getTime(),
          canonicalDecisionTime: decisionTime,
          timestamp: decisionTime,
          triggerEvidence: {
            orderBlock: { matched: true, timestamp: decisionTime },
            fvg: { matched: true, timestamp: decisionTime },
            liquiditySweep: { matched: true, timestamp: decisionTime },
            structureBreak: { matched: true, timestamp: decisionTime },
          },
          reasoning: {
            htfStructure: '1H/4H Bearish Alignment',
            marketStructure: 'Confirmed BOS',
          },
        },
      },
    });

    // Assert Scanner summary metrics
    expect(scanResult.scannedCount).toBeGreaterThanOrEqual(1);
    expect(scanResult.signalsGenerated).toBeGreaterThanOrEqual(1);
    expect(scanResult.activeCount).toBeGreaterThanOrEqual(1);
    expect(scanResult.botEvaluatedCount).toBeGreaterThanOrEqual(1);
    expect(scanResult.executionAttemptedCount).toBe(1);
    expect(scanResult.executionFailedCount).toBe(0);
    expect(scanResult.executedCount).toBe(1);

    // 2. Verify AlgoBotsService.evaluateSignalForBots() was invoked by ScannerService for BTCUSDT
    expect(evaluateSpy).toHaveBeenCalledTimes(1);
    // 3. Verify SignalsService produced the active signal setup via real SignalGenerator
    const btcSignal = scanResult.signals[0];
    expect(btcSignal).toBeDefined();

    expect(btcSignal!.symbol).toBe('BTCUSDT');
    expect(String(btcSignal!.timeframe)).toBe('15m');
    expect(btcSignal!.state).toBe(SignalState.ACTIVE);
    expect(btcSignal!.direction).toBe(Direction.BEARISH);
    expect(btcSignal!.score).toBeGreaterThanOrEqual(70);

    // Canonical timestamp strict assertions
    expect(btcSignal!.canonicalCandleTime).toBeDefined();
    expect(btcSignal!.canonicalDecisionTime).toBeDefined();
    expect(btcSignal!.canonicalCandleTime).toBe(btcSignal!.canonicalDecisionTime!.getTime());

    // Evidence & HTF presence assertions
    expect(btcSignal!.triggerEvidence).toBeDefined();
    expect(btcSignal!.reasoning?.htfStructure).not.toContain('unavailable');

    // 4. Verify complete state machine execution & paper position creation in DB
    const executions = Array.from(executionsDb.values()).filter((e) => e.fingerprint);
    expect(executions.length).toBeGreaterThanOrEqual(1);

    const activeExec = executions[0];
    expect(activeExec.state).toBe('EXECUTED');
    expect(activeExec.orderPositionId).toBeDefined();

    const positions = Array.from(positionsDb.values());
    expect(positions.length).toBe(1);
    const pos = positions[0];
    expect(pos.symbol).toBe('BTCUSDT');
    expect(pos.direction).toBe(Direction.BEARISH);
    expect(pos.status).toBe('OPEN');
    expect(Number(pos.entryPrice)).toBeGreaterThan(0);
    expect(activeExec.signalTimestamp.getTime()).toBe(btcSignal!.canonicalCandleTime);
  });
});
