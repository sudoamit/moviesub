import { Test, TestingModule } from '@nestjs/testing';
import { ScannerService } from '../scanner.service';
import { SignalsService } from '../../signals/signals.service';
import { AlgoBotsService, ExecutionFailureReason } from '../../algo-bots/algo-bots.service';
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
  RealLiveMarketDataProvider,
  SignalGrade,
  SignalState,
  StaleMarketDataError,
  Timeframe,
} from '@quant/shared';

describe('Fix 183 — Primary Release-Gate End-to-End Execution Pipeline (Real PostgreSQL & Real Provider Adapter)', () => {
  let moduleRef: TestingModule;
  let scannerService: ScannerService;
  let signalsService: SignalsService;
  let algoBotsService: AlgoBotsService;
  let paperTradingService: PaperTradingService;
  let prismaService: PrismaService;
  let realProvider: RealLiveMarketDataProvider;

  let mockRedis: any;
  let decisionTime: Date;
  let originalFetch: typeof global.fetch;

  /**
   * Constructs raw Binance klines JSON payloads for M15, H1, H4.
   * Produces a natural Bullish Liquidity Sweep + BOS setup for BTCUSDT.
   */
  const buildBinanceKlinesPayload = (asOfTime: Date): { m15: any[]; h1: any[]; h4: any[] } => {
    const m15: any[] = [];
    const baseM15 = new Date(asOfTime.getTime() - 49 * 15 * 60 * 1000);
    let price = 64900;

    for (let i = 0; i < 50; i++) {
      const openTime = baseM15.getTime() + i * 15 * 60 * 1000;
      const closeTime = openTime + 15 * 60 * 1000 - 1;
      let open = price;
      let high = price + 30;
      let low = price - 30;
      let close = price + 10;
      let volume = 1000;

      if (i === 15) {
        // Swing Low anchor at index 15
        open = 64900;
        high = 64950;
        low = 64750; // Key swing low
        close = 64850;
      } else if (i === 34) {
        // Institutional Order Block POI (bearish down candle before displacement)
        open = 65000;
        high = 65050;
        low = 64850;
        close = 64900;
        volume = 2500;
      } else if (i === 35) {
        // Sell-side Liquidity Pool Sweep (wicks below 64750 to 64700, closes back above at 64950)
        open = 64900;
        high = 65000;
        low = 64700;
        close = 64950;
        volume = 5000;
      } else if (i === 36) {
        // Bullish Displacement & BOS (breaks higher, strong expansion volume, creates FVG)
        open = 64950;
        high = 65200;
        low = 64920;
        close = 65150;
        volume = 8000;
      } else if (i >= 37 && i <= 44) {
        // Healthy consolidation
        open = 65150 - (i - 37) * 10;
        high = open + 30;
        low = open - 20;
        close = open + 5;
        volume = 1200;
      } else if (i === 45 || i === 46) {
        // Pullback into FVG / OTE dealing range
        open = 65050;
        high = 65080;
        low = 64920;
        close = 64950;
        volume = 2000;
      } else if (i === 47 || i === 48) {
        // Reversal bounce with expanding volume
        open = 64950;
        high = 65000;
        low = 64930;
        close = 64980;
        volume = 3500;
      } else if (i === 49) {
        // High volume confirmation candle closing near high (optimal RSI ~60)
        open = 64980;
        high = 65020;
        low = 64960;
        close = 65000;
        volume = 4500;
      }

      price = close;
      m15.push([
        openTime,
        open.toFixed(2),
        high.toFixed(2),
        low.toFixed(2),
        close.toFixed(2),
        volume.toFixed(2),
        closeTime,
        '100000.00',
        100,
        '500.00',
        '50000.00',
        '0',
      ]);
    }

    const h1: any[] = [];
    let h1Price = 58000;
    for (let i = 40; i >= 1; i--) {
      const openTime = asOfTime.getTime() - i * 60 * 60 * 1000;
      const closeTime = openTime + 60 * 60 * 1000 - 1;
      const open = h1Price;
      const high = h1Price + 500;
      const low = h1Price - 100;
      const close = h1Price + 400;
      const volume = 8000;
      h1.push([
        openTime,
        open.toFixed(2),
        high.toFixed(2),
        low.toFixed(2),
        close.toFixed(2),
        volume.toFixed(2),
        closeTime,
        '200000.00',
        200,
        '1000.00',
        '100000.00',
        '0',
      ]);
      h1Price += 180;
    }

    const h4: any[] = [];
    let h4Price = 54000;
    for (let i = 25; i >= 1; i--) {
      const openTime = asOfTime.getTime() - i * 4 * 60 * 60 * 1000;
      const closeTime = openTime + 4 * 60 * 60 * 1000 - 1;
      const open = h4Price;
      const high = h4Price + 800;
      const low = h4Price - 150;
      const close = h4Price + 650;
      const volume = 15000;
      h4.push([
        openTime,
        open.toFixed(2),
        high.toFixed(2),
        low.toFixed(2),
        close.toFixed(2),
        volume.toFixed(2),
        closeTime,
        '500000.00',
        500,
        '2500.00',
        '250000.00',
        '0',
      ]);
      h4Price += 400;
    }

    return { m15, h1, h4 };
  };

  beforeAll(async () => {
    process.env.PAPER_TRADING_ENABLED = 'true';
    process.env.NODE_ENV = 'test';
    delete process.env.APP_ENV;

    originalFetch = global.fetch;
    realProvider = new RealLiveMarketDataProvider();

    mockRedis = {
      getClient: jest.fn().mockReturnValue({
        status: 'ready',
        set: jest.fn().mockResolvedValue('OK'),
        publish: jest.fn().mockResolvedValue(1),
      }),
      set: jest.fn().mockResolvedValue('OK'),
      get: jest.fn().mockResolvedValue(null),
    };

    moduleRef = await Test.createTestingModule({
      providers: [
        ScannerService,
        SignalsService,
        AlgoBotsService,
        PaperTradingService,
        PrismaService,
        {
          provide: RealMarketStreamerService,
          useValue: {
            getValidatedTicker: jest.fn().mockImplementation((sym: string) => {
              if (sym.toUpperCase() !== 'BTCUSDT') {
                throw new MarketDataUnavailableError(sym);
              }
              const now = Date.now();
              return {
                price: 64985.0,
                marketEventTime: now - 100,
                lastUpdated: now,
              };
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
              const candles = await realProvider.getHistoricalCandles(symbol, timeframe, limit);
              return { candles };
            }),
          },
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
    prismaService = moduleRef.get<PrismaService>(PrismaService);

    await prismaService.$connect();
  });

  afterAll(async () => {
    global.fetch = originalFetch;
    if (prismaService) {
      await prismaService.$disconnect();
    }
  });

  beforeEach(async () => {
    decisionTime = new Date();

    // Clean execution and trade tables in real PostgreSQL
    await prismaService.algoBotExecution.deleteMany({});
    await prismaService.tradeDecision.deleteMany({});
    await prismaService.paperFill.deleteMany({});
    await prismaService.paperTrade.deleteMany({});
    await prismaService.paperPosition.deleteMany({});
    await prismaService.paperOrder.deleteMany({});
    await prismaService.signal.deleteMany({});

    // Deactivate non-test instruments
    await prismaService.instrument.updateMany({
      where: { symbol: { not: 'BTCUSDT' } },
      data: { isActive: false },
    });

    // Seed Instrument
    await prismaService.instrument.upsert({
      where: { symbol: 'BTCUSDT' },
      update: { isActive: true },
      create: {
        id: 'inst_btcusdt',
        symbol: 'BTCUSDT',
        name: 'Bitcoin',
        exchange: 'BINANCE',
        assetType: 'CRYPTO',
        tickSize: 0.01,
        lotSize: 1,
        currency: 'USD',
        isActive: true,
      },
    });

    // Seed Trading System Config
    await prismaService.tradingSystemConfig.upsert({
      where: { id: 'SYSTEM_DEFAULT' },
      update: {
        paperTradingEnabled: true,
        liveTradingEnabled: false,
        emergencyStop: false,
        maxOpenPositions: 5,
        maxTradesPerDay: 20,
      },
      create: {
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
      },
    });

    // Seed Primary Paper Account & Balance
    await prismaService.paperAccount.upsert({
      where: { id: 'acc_paper_e2e' },
      update: { cashBalance: 100000.0, isActive: true },
      create: {
        id: 'acc_paper_e2e',
        name: 'Primary Paper Account',
        currency: 'USD',
        cashBalance: 100000.0,
        initialCapital: 100000.0,
        usedMargin: 0,
        isActive: true,
      },
    });

    // Seed Production-Grade Bot for Liquidity Sweep
    await prismaService.algoBot.upsert({
      where: { id: 'bot_btc_liquidity_sweep' },
      update: {
        symbol: 'BTCUSDT',
        direction: 'BULLISH',
        timeframe: '15m',
        minScore: 75,
        smcCondition: 'LIQUIDITY_SWEEP',
        lots: 1,
        autoExecutePaper: true,
        isActive: true,
      },
      create: {
        id: 'bot_btc_liquidity_sweep',
        name: 'BTCUSDT 15m Liquidity Pool Sweeper',
        symbol: 'BTCUSDT',
        direction: 'BULLISH',
        timeframe: '15m',
        minScore: 75,
        smcCondition: 'LIQUIDITY_SWEEP',
        lots: 1,
        autoExecutePaper: true,
        notifyWebhook: false,
        isActive: true,
        createdAt: new Date(),
        triggerCount: 0,
      },
    });

    // Mock HTTP transport for RealLiveMarketDataProvider
    const klines = buildBinanceKlinesPayload(decisionTime);
    global.fetch = jest.fn().mockImplementation(async (url: string) => {
      const urlStr = String(url);
      if (urlStr.includes('symbol=BTCUSDT')) {
        if (urlStr.includes('interval=15m')) {
          return {
            ok: true,
            status: 200,
            json: async () => klines.m15,
          } as any;
        }
        if (urlStr.includes('interval=1h')) {
          return {
            ok: true,
            status: 200,
            json: async () => klines.h1,
          } as any;
        }
        if (urlStr.includes('interval=4h')) {
          return {
            ok: true,
            status: 200,
            json: async () => klines.h4,
          } as any;
        }
      }
      return {
        ok: true,
        status: 200,
        json: async () => [],
      } as any;
    });
  });

  it('1. PRIMARY RELEASE-GATE TEST: ScannerService.triggerScan() executes complete pipeline to PostgreSQL database', async () => {
    const evaluateSpy = jest.spyOn(algoBotsService, 'evaluateSignalForBots');
    const placeOrderSpy = jest.spyOn(paperTradingService, 'placeOrder');

    // 1. Authoritative Entry Point: Trigger scan from ScannerService
    const scanResult: any = await scannerService.triggerScan(Timeframe.M15);

    // Assert Scanner summary metrics
    expect(scanResult.scannedCount).toBeGreaterThanOrEqual(1);
    expect(scanResult.signalsGenerated).toBeGreaterThanOrEqual(1);
    expect(scanResult.activeCount).toBeGreaterThanOrEqual(1);
    expect(scanResult.botEvaluatedCount).toBeGreaterThanOrEqual(1);
    expect(scanResult.executionAttemptedCount).toBe(1);
    expect(scanResult.executionFailedCount).toBe(0);
    expect(scanResult.executedCount).toBe(1);

    // 2. Verify AlgoBotsService was invoked with generated signal
    expect(evaluateSpy).toHaveBeenCalledTimes(1);
    const evaluatedSignal = evaluateSpy.mock.calls[0][0];
    expect(evaluatedSignal.symbol).toBe('BTCUSDT');
    expect(evaluatedSignal.direction).toBe(Direction.BULLISH);
    expect(evaluatedSignal.state).toBe(SignalState.ACTIVE);
    expect(evaluatedSignal.score).toBeGreaterThanOrEqual(75);
    expect(evaluatedSignal.triggerEvidence?.liquiditySweep?.matched).toBe(true);

    // Canonical timestamp invariant
    expect(evaluatedSignal.canonicalCandleTime).toBeDefined();
    expect(evaluatedSignal.canonicalDecisionTime).toBeDefined();
    expect(evaluatedSignal.canonicalCandleTime).toBe(
      new Date(evaluatedSignal.canonicalDecisionTime!).getTime(),
    );

    // 3. Verify real PaperTradingService.placeOrder() was called with canonical decision time
    expect(placeOrderSpy).toHaveBeenCalledTimes(1);
    expect(placeOrderSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        symbol: 'BTCUSDT',
        direction: 'BUY',
        signalTime: new Date(evaluatedSignal.canonicalDecisionTime!).toISOString(),
      }),
    );

    // 4. ASSERT ACTUAL POSTGRESQL DATABASE ROWS
    const dbExecution = await prismaService.algoBotExecution.findFirst({
      where: { botId: 'bot_btc_liquidity_sweep' },
    });
    expect(dbExecution).not.toBeNull();
    expect(dbExecution!.state).toBe('EXECUTED');
    expect(dbExecution!.symbol).toBe('BTCUSDT');
    expect(dbExecution!.direction).toBe(Direction.BULLISH);
    expect(dbExecution!.orderPositionId).toBeDefined();
    expect(dbExecution!.signalTimestamp.getTime()).toBe(evaluatedSignal.canonicalCandleTime);

    const dbPosition = await prismaService.paperPosition.findFirst({
      where: { symbol: 'BTCUSDT' },
    });
    expect(dbPosition).not.toBeNull();
    expect(dbPosition!.symbol).toBe('BTCUSDT');
    expect(dbPosition!.direction).toBe(Direction.BULLISH);
    expect(dbPosition!.status).toBe('OPEN');
    expect(Number(dbPosition!.entryPrice)).toBeGreaterThan(0);
    expect(dbPosition!.id).toBe(dbExecution!.orderPositionId);
  });

  it('2. FAIL-CLOSED INVARIANT: Missing H1 or H4 HTF data produces zero executions', async () => {
    const origFetch = global.fetch;
    try {
      // Return empty array for H1
      global.fetch = jest.fn().mockImplementation(async (url: string) => {
        const urlStr = String(url);
        if (urlStr.includes('interval=1h')) {
          return { ok: true, status: 200, json: async () => [] } as any;
        }
        const klines = buildBinanceKlinesPayload(decisionTime);
        return {
          ok: true,
          status: 200,
          json: async () => (urlStr.includes('interval=15m') ? klines.m15 : klines.h4),
        } as any;
      });

      const res: any = await scannerService.triggerScan(Timeframe.M15);
      expect(res.executedCount).toBe(0);
      expect(res.executionAttemptedCount).toBe(0);

      const dbPositions = await prismaService.paperPosition.findMany({});
      expect(dbPositions.length).toBe(0);
    } finally {
      global.fetch = origFetch;
    }
  });

  it('3. ERROR CLASSIFICATION & RETRY SEMANTICS: Broker 503 classifies as BROKER_UNAVAILABLE and transitions to FAILED_RETRYABLE', async () => {
    jest
      .spyOn(paperTradingService, 'placeOrder')
      .mockRejectedValueOnce(new Error('Broker connection refused (503 Service Unavailable)'));

    const res: any = await scannerService.triggerScan(Timeframe.M15);
    expect(res.executedCount).toBe(0);
    expect(res.executionFailedCount).toBe(1);

    const dbExecution = await prismaService.algoBotExecution.findFirst({
      where: { botId: 'bot_btc_liquidity_sweep' },
    });
    expect(dbExecution).not.toBeNull();
    expect(dbExecution!.state).toBe('FAILED_RETRYABLE');
    expect(dbExecution!.failureReasonCode).toBe(ExecutionFailureReason.BROKER_UNAVAILABLE);
  });

  it('4. ERROR CLASSIFICATION: Permanent broker rejection classifies as BROKER_REJECTED and transitions to FAILED_FINAL', async () => {
    jest
      .spyOn(paperTradingService, 'placeOrder')
      .mockRejectedValueOnce(new Error('ORDER_REJECTED: Margin insufficient for requested lots'));

    const res: any = await scannerService.triggerScan(Timeframe.M15);
    expect(res.executedCount).toBe(0);
    expect(res.executionFailedCount).toBe(1);

    const dbExecution = await prismaService.algoBotExecution.findFirst({
      where: { botId: 'bot_btc_liquidity_sweep' },
    });
    expect(dbExecution).not.toBeNull();
    expect(dbExecution!.state).toBe('FAILED_FINAL');
    expect(dbExecution!.failureReasonCode).toBe(ExecutionFailureReason.BROKER_REJECTED);
  });
});
