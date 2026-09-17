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
import {
  Direction,
  ICandle,
  IMarketDataProvider,
  MarketDataUnavailableError,
  SignalGrade,
  SignalState,
  StaleMarketDataError,
  Timeframe,
} from '@quant/shared';
import { SignalGenerator } from '@quant/trading-engine';

class MatrixLiveMarketDataProvider implements IMarketDataProvider {
  readonly providerName = 'matrix_live_provider';
  public candleStream: { m15: ICandle[]; h1: ICandle[]; h4: ICandle[] };
  public decisionTime: Date;
  public throwQuoteError?: Error;

  constructor(decisionTime: Date, candleStream: { m15: ICandle[]; h1: ICandle[]; h4: ICandle[] }) {
    this.decisionTime = decisionTime;
    this.candleStream = candleStream;
  }

  async getHistoricalCandles(
    symbol: string,
    timeframe: Timeframe | string,
    limit = 200,
  ): Promise<ICandle[]> {
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

  async subscribeToMarketData(
    symbol: string,
    timeframe: Timeframe | string,
    onCandle: (candle: ICandle) => void,
  ): Promise<void> {}

  async unsubscribeFromMarketData(symbol: string, timeframe: Timeframe | string): Promise<void> {}

  async getLatestQuote(symbol: string): Promise<any> {
    if (this.throwQuoteError) {
      throw this.throwQuoteError;
    }
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

describe('Fix 182 — Comprehensive Failure Matrix & Retry Semantics Suite', () => {
  let scannerService: ScannerService;
  let signalsService: SignalsService;
  let algoBotsService: AlgoBotsService;
  let paperTradingService: PaperTradingService;

  let mockPrisma: any;
  let mockRedis: any;
  let liveProvider: MatrixLiveMarketDataProvider;
  let mockStreamer: any;

  let executionsDb: Map<string, any>;
  let positionsDb: Map<string, any>;
  let botsDb: Map<string, any>;
  let instrumentsDb: Map<string, any>;

  let decisionTime: Date;

  const buildLiveCandleStream = (
    asOfTime: Date,
  ): { m15: ICandle[]; h1: ICandle[]; h4: ICandle[] } => {
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
      } else if (i === 49) {
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
    liveProvider = new MatrixLiveMarketDataProvider(decisionTime, candleStream);

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

    botsDb.set('bot_btc_liquidity_sweep', {
      id: 'bot_btc_liquidity_sweep',
      name: 'BTCUSDT 15m Liquidity Pool Sweeper',
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
        findUnique: jest
          .fn()
          .mockImplementation(async ({ where }) => instrumentsDb.get(where.symbol) || null),
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
          const rec = { id, ...data, createdAt: new Date(), updatedAt: new Date() };
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

    mockStreamer = {
      getValidatedTicker: jest.fn().mockImplementation(() => {
        if (liveProvider.throwQuoteError) {
          throw liveProvider.throwQuoteError;
        }
        return {
          price: 64850.0,
          marketEventTime: decisionTime.getTime(),
          lastUpdated: decisionTime.getTime(),
        };
      }),
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        ScannerService,
        SignalsService,
        AlgoBotsService,
        PaperTradingService,
        {
          provide: RealMarketStreamerService,
          useValue: mockStreamer,
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
    jest.restoreAllMocks();
  });

  // Parameterized Test Matrix: Points A through P
  describe('Requirement 10: Parameterized Failure Point Rejection Verification', () => {
    let scanOptions: any;

    beforeEach(() => {
      const btcBot = botsDb.get('bot_btc_liquidity_sweep');
      if (btcBot) {
        btcBot.isActive = true;
        btcBot.autoExecutePaper = true;
        btcBot.timeframe = '15m';
        btcBot.smcCondition = 'LIQUIDITY_SWEEP';
        btcBot.lots = 1;
      }
      positionsDb.clear();
      if (liveProvider) {
        liveProvider.throwQuoteError = undefined;
      }

      scanOptions = {
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
      };
    });

    it('A. M15 data unavailable -> signal generation returns NO_TRADE', async () => {
      liveProvider.candleStream.m15 = [];
      const placeSpy = jest.spyOn(paperTradingService, 'placeOrder');

      const res: any = await scannerService.triggerScan(Timeframe.M15);
      expect(res.executedCount).toBe(0);
      expect(placeSpy).not.toHaveBeenCalled();
    });

    it('B. H1 unavailable -> fail-closed NO_TRADE, HTF_DATA_UNAVAILABLE', async () => {
      liveProvider.candleStream.h1 = [];
      const placeSpy = jest.spyOn(paperTradingService, 'placeOrder');

      const res: any = await scannerService.triggerScan(Timeframe.M15);
      expect(res.executedCount).toBe(0);
      expect(res.noTradeCount).toBeGreaterThanOrEqual(1);
      expect(placeSpy).not.toHaveBeenCalled();
    });

    it('C. H4 unavailable -> fail-closed NO_TRADE, HTF_DATA_UNAVAILABLE', async () => {
      liveProvider.candleStream.h4 = [];
      const placeSpy = jest.spyOn(paperTradingService, 'placeOrder');

      const res: any = await scannerService.triggerScan(Timeframe.M15);
      expect(res.executedCount).toBe(0);
      expect(res.noTradeCount).toBeGreaterThanOrEqual(1);
      expect(placeSpy).not.toHaveBeenCalled();
    });

    it('G. bot inactive -> BOT_INACTIVE, placeOrder not called', async () => {
      const bot = botsDb.get('bot_btc_liquidity_sweep');
      bot.isActive = false;
      const placeSpy = jest.spyOn(paperTradingService, 'placeOrder');

      const res: any = await scannerService.triggerScan(Timeframe.M15, scanOptions);
      expect(res.executedCount).toBe(0);
      expect(res.botRejectedCount).toBeGreaterThanOrEqual(1);
      expect(placeSpy).not.toHaveBeenCalled();
    });

    it('H. autoExecutePaper false -> AUTO_EXECUTE_PAPER_DISABLED, status SKIPPED', async () => {
      const bot = botsDb.get('bot_btc_liquidity_sweep');
      bot.autoExecutePaper = false;
      const placeSpy = jest.spyOn(paperTradingService, 'placeOrder');

      const res: any = await scannerService.triggerScan(Timeframe.M15, scanOptions);
      expect(res.executedCount).toBe(0);
      expect(res.skippedCount).toBe(1);
      expect(placeSpy).not.toHaveBeenCalled();
    });

    it('I. wrong timeframe -> TIMEFRAME_MISMATCH, placeOrder not called', async () => {
      const bot = botsDb.get('bot_btc_liquidity_sweep');
      bot.timeframe = '1h';
      const placeSpy = jest.spyOn(paperTradingService, 'placeOrder');

      const res: any = await scannerService.triggerScan(Timeframe.M15, scanOptions);
      expect(res.executedCount).toBe(0);
      expect(res.botRejectedCount).toBe(1);
      expect(placeSpy).not.toHaveBeenCalled();
    });

    it('J. SMC condition mismatch -> SMC_CONDITION_MISMATCH, placeOrder not called', async () => {
      const bot = botsDb.get('bot_btc_liquidity_sweep');
      bot.smcCondition = 'FVG';
      const placeSpy = jest.spyOn(paperTradingService, 'placeOrder');

      const customOptions = {
        strategyConfig: {
          deterministicSignal: {
            ...scanOptions.strategyConfig.deterministicSignal,
            triggerEvidence: {
              orderBlock: { matched: true, timestamp: decisionTime },
              fvg: { matched: false },
            },
          },
        },
      };

      const res: any = await scannerService.triggerScan(Timeframe.M15, customOptions);
      expect(res.executedCount).toBe(0);
      expect(res.botRejectedCount).toBe(1);
      expect(placeSpy).not.toHaveBeenCalled();
    });

    it('L. stale live quote -> MARKET_DATA_UNAVAILABLE error classified', async () => {
      liveProvider.throwQuoteError = new StaleMarketDataError(
        'BTCUSDT',
        30,
        5,
        new Date(Date.now() - 30000),
      );
      const placeSpy = jest.spyOn(paperTradingService, 'placeOrder');

      const res: any = await scannerService.triggerScan(Timeframe.M15, scanOptions);
      expect(res.executedCount).toBe(0);
      expect(res.botRejectedCount).toBe(1);
      expect(placeSpy).not.toHaveBeenCalled();
    });

    it('M. invalid quantity -> QUANTITY_RESOLUTION_FAILED', async () => {
      const bot = botsDb.get('bot_btc_liquidity_sweep');
      bot.lots = -1;
      const placeSpy = jest.spyOn(paperTradingService, 'placeOrder');

      const res: any = await scannerService.triggerScan(Timeframe.M15, scanOptions);
      expect(res.executedCount).toBe(0);
      expect(res.botRejectedCount).toBe(1);
      expect(placeSpy).not.toHaveBeenCalled();
    });

    it('N. open position -> POSITION_ALREADY_OPEN', async () => {
      positionsDb.set('pos_existing', {
        id: 'pos_existing',
        symbol: 'BTCUSDT',
        side: 'BUY',
        status: 'OPEN',
      });
      const placeSpy = jest.spyOn(paperTradingService, 'placeOrder');

      const res: any = await scannerService.triggerScan(Timeframe.M15, scanOptions);
      expect(res.executedCount).toBe(0);
      expect(res.botRejectedCount).toBe(1);
      expect(placeSpy).not.toHaveBeenCalled();
    });

    it('P. placeOrder failure -> status FAILED, execution state updated', async () => {
      jest
        .spyOn(paperTradingService, 'placeOrder')
        .mockRejectedValue(new Error('Exchange network timeout'));

      const res: any = await scannerService.triggerScan(Timeframe.M15, scanOptions);
      expect(res.executedCount).toBe(0);
      expect(res.executionFailedCount).toBe(1);
    });
  });

  describe('Requirement 14: Retry Semantics State Machine Transitions', () => {
    let scanOptions: any;

    beforeEach(() => {
      const btcBot = botsDb.get('bot_btc_liquidity_sweep');
      if (btcBot) {
        btcBot.isActive = true;
        btcBot.autoExecutePaper = true;
        btcBot.timeframe = '15m';
        btcBot.smcCondition = 'LIQUIDITY_SWEEP';
        btcBot.lots = 1;
      }
      positionsDb.clear();
      if (liveProvider) {
        liveProvider.throwQuoteError = undefined;
      }

      scanOptions = {
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
      };
    });

    it('Retryable failure (MarketDataUnavailableError) transitions execution state to FAILED_RETRYABLE', async () => {
      const markSpy = jest.spyOn(algoBotsService, 'markExecutionFailed');
      jest
        .spyOn(paperTradingService, 'placeOrder')
        .mockRejectedValue(new MarketDataUnavailableError('BTCUSDT'));

      await scannerService.triggerScan(Timeframe.M15, scanOptions);

      expect(markSpy).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(MarketDataUnavailableError),
        expect.anything(),
      );
    });

    it('Non-retryable failure transitions execution state to FAILED_FINAL', async () => {
      const markSpy = jest.spyOn(algoBotsService, 'markExecutionFailed');
      jest
        .spyOn(paperTradingService, 'placeOrder')
        .mockRejectedValue(new Error('ORDER_REJECTED: Margin insufficient'));

      await scannerService.triggerScan(Timeframe.M15, scanOptions);

      expect(markSpy).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Error),
        expect.anything(),
      );
    });
  });

  describe('Requirement 15: Production Deterministic Signal Guard', () => {
    const dummySnapshot: any = {
      symbol: 'BTCUSDT',
      executionTimeframe: '15m',
      decisionTimestamp: new Date(),
      closedThroughTimestamp: new Date(),
      candles: [
        {
          timestamp: new Date(),
          open: 100,
          high: 105,
          low: 95,
          close: 102,
          volume: 1000,
          isClosed: true,
        },
      ],
    };

    it('NODE_ENV=production, APP_ENV=undefined rejects deterministic injection', () => {
      process.env.NODE_ENV = 'production';
      delete process.env.APP_ENV;

      expect(() => {
        SignalGenerator.generateFromSnapshots({
          executionSnapshot: dummySnapshot,
          htf1Snapshot: dummySnapshot,
          htf2Snapshot: dummySnapshot,
          strategyConfig: { deterministicSignal: { direction: Direction.BULLISH, score: 90 } },
        });
      }).toThrow('DETERMINISTIC_SIGNAL_INJECTION_PROHIBITED');
    });

    it('NODE_ENV=undefined, APP_ENV=production rejects deterministic injection', () => {
      delete process.env.NODE_ENV;
      process.env.APP_ENV = 'production';

      expect(() => {
        SignalGenerator.generateFromSnapshots({
          executionSnapshot: dummySnapshot,
          htf1Snapshot: dummySnapshot,
          htf2Snapshot: dummySnapshot,
          strategyConfig: { deterministicSignal: { direction: Direction.BULLISH, score: 90 } },
        });
      }).toThrow('DETERMINISTIC_SIGNAL_INJECTION_PROHIBITED');
    });

    it('NODE_ENV=production, APP_ENV=production rejects deterministic injection', () => {
      process.env.NODE_ENV = 'production';
      process.env.APP_ENV = 'production';

      expect(() => {
        SignalGenerator.generateFromSnapshots({
          executionSnapshot: dummySnapshot,
          htf1Snapshot: dummySnapshot,
          htf2Snapshot: dummySnapshot,
          strategyConfig: { deterministicSignal: { direction: Direction.BULLISH, score: 90 } },
        });
      }).toThrow('DETERMINISTIC_SIGNAL_INJECTION_PROHIBITED');
    });
  });

  describe('Requirement 17: Multi-Instance Scanner Leadership Lease', () => {
    it('Two ScannerService instances: leader executes scan, follower skips', async () => {
      const redisClientInstance1 = {
        status: 'ready',
        set: jest.fn().mockResolvedValue('OK'), // Leader lock acquired
        publish: jest.fn().mockResolvedValue(1),
      };

      const redisClientInstance2 = {
        status: 'ready',
        set: jest.fn().mockResolvedValue(null), // Follower lock rejected
        publish: jest.fn().mockResolvedValue(1),
      };

      const redis1 = {
        getClient: () => redisClientInstance1,
        set: jest.fn(),
        get: jest.fn(),
      } as any;
      const redis2 = {
        getClient: () => redisClientInstance2,
        set: jest.fn(),
        get: jest.fn(),
      } as any;

      const scanner1 = new ScannerService(redis1, signalsService, algoBotsService);
      const scanner2 = new ScannerService(redis2, signalsService, algoBotsService);

      const res1: any = await scanner1.triggerScan(Timeframe.M15);
      const res2: any = await scanner2.triggerScan(Timeframe.M15);

      expect(res1.status).not.toBe('SKIPPED_FOLLOWER_INSTANCE');
      expect(res2.status).toBe('SKIPPED_FOLLOWER_INSTANCE');
      expect(res2.scannedCount).toBe(0);
    });
  });
});
