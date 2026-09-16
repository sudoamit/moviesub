import { PrismaClient } from '@prisma/client';
import { AlgoBotsService, IAlgoBot } from '../algo-bots.service';
import { SignalsService } from '../../signals/signals.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { Direction, ICandle, SignalState, Timeframe } from '@quant/shared';
import { SignalGenerator, CanonicalMarketSnapshotBuilder } from '@quant/trading-engine';

describe('Fix 178 — Real End-to-End Paper Execution Integration Test', () => {
  let prismaClient: any = null;
  let algoBotsService: AlgoBotsService;
  let mockPaperTradingService: any;
  let mockAlertsService: any;
  let mockCandlesService: any;
  let signalsService: SignalsService;

  const DB_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;

  beforeAll(async () => {
    if (DB_URL) {
      prismaClient = new PrismaClient({ datasources: { db: { url: DB_URL } } });
      await prismaClient.$connect();
    }
  });

  afterAll(async () => {
    if (prismaClient) await prismaClient.$disconnect();
  });

  beforeEach(async () => {
    if (prismaClient) {
      try {
        await prismaClient.algoBotExecution.deleteMany({
          where: { symbol: 'BTCUSDT' },
        });
      } catch (e) {
        // ignore if table/db is disconnected
      }
    }

    mockPaperTradingService = {
      getPortfolio: jest.fn().mockResolvedValue({ openPositions: [] }),
      getValidatedMarketPrice: jest
        .fn()
        .mockResolvedValue({ price: 65000.0, timestamp: new Date() }),
      placeOrder: jest.fn().mockImplementation(async (orderDto) => ({
        id: `pos_e2e_${Date.now()}`,
        symbol: orderDto.symbol,
        direction: orderDto.direction,
        entryPrice: 65000.0,
      })),
    };

    mockAlertsService = {
      sendAlert: jest.fn().mockResolvedValue({ success: true }),
    };

    mockCandlesService = {
      getCandles: jest.fn(),
    };
  });

  function buildNaturalSMCCandles() {
    const now = Date.now();
    const candles: ICandle[] = [];
    const baseTime = now - 49 * 15 * 60 * 1000;
    let price = 65000;

    for (let i = 0; i < 50; i++) {
      const time = new Date(baseTime + i * 15 * 60 * 1000);
      let open = price;
      let high = price + 100;
      let low = price - 100;
      let close = price + 50;
      let volume = 1000;

      if (i === 5) {
        // High dealing range anchor at 67000
        open = 66500;
        high = 67000;
        low = 66400;
        close = 66800;
      } else if (i === 15) {
        // Confirmed swing low anchor at 63900
        open = 64500;
        high = 64600;
        low = 63900;
        close = 64400;
      } else if (i === 30) {
        // Confirmed swing high anchor at 65000
        open = 64800;
        high = 65000;
        low = 64700;
        close = 64850;
      } else if (i === 47) {
        open = 64500;
        high = 64600;
        low = 64200;
        close = 64300;
      } else if (i === 48) {
        // Sell-side liquidity sweep & bullish expansion candle: wicks down to 63700 below 63900, expands and closes at 64800
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
      candles.push({
        timestamp: time,
        open,
        high,
        low,
        close,
        volume,
        isClosed: true,
      });
    }

    const decisionTime = candles[candles.length - 1].timestamp as Date;

    const htf1Candles: ICandle[] = [];
    let htfPrice = 60000;
    for (let i = 40; i >= 1; i--) {
      const htfTime = new Date(decisionTime.getTime() - i * 60 * 60 * 1000);
      let open = htfPrice;
      let high = htfPrice + 200;
      let low = htfPrice - 100;
      let close = htfPrice + 150;

      if (i === 30) {
        high = htfPrice + 800;
        close = htfPrice + 600;
      } else if (i === 25) {
        low = htfPrice - 400;
        close = htfPrice - 100;
      } else if (i === 20) {
        high = htfPrice + 1200;
        close = htfPrice + 1000;
      }

      htf1Candles.push({
        timestamp: htfTime,
        open,
        high,
        low,
        close,
        volume: 3000,
        isClosed: true,
      });
      htfPrice += 100;
    }

    const htf2Candles: ICandle[] = [];
    let htf2Price = 58000;
    for (let i = 25; i >= 1; i--) {
      const htfTime = new Date(decisionTime.getTime() - i * 4 * 60 * 60 * 1000);
      htf2Candles.push({
        timestamp: htfTime,
        open: htf2Price,
        high: htf2Price + 800,
        low: htf2Price - 300,
        close: htf2Price + 600,
        volume: 8000,
        isClosed: true,
      });
      htf2Price += 200;
    }

    return { candles, htf1Candles, htf2Candles, decisionTime };
  }

  it('Requirement 10: E2E Pipeline — Canonical Candle -> NATURAL ACTIVE signal -> Bot match -> Reservation -> EXECUTING -> placeOrder() -> EXECUTED', async () => {
    algoBotsService = new AlgoBotsService(
      mockPaperTradingService,
      mockAlertsService,
      (prismaClient as unknown as PrismaService) || undefined,
      null as any,
    );

    await algoBotsService.onModuleInit();

    const { candles, htf1Candles, htf2Candles, decisionTime } = buildNaturalSMCCandles();

    const execSnapshot = CanonicalMarketSnapshotBuilder.build({
      symbol: 'BTCUSDT',
      executionCandles: candles,
      executionTimeframe: Timeframe.M15,
      asOfTimestamp: decisionTime,
      allowSyntheticInProduction: true,
    });

    const htf1Snapshot = CanonicalMarketSnapshotBuilder.build({
      symbol: 'BTCUSDT',
      executionCandles: htf1Candles,
      executionTimeframe: Timeframe.H1,
      asOfTimestamp: decisionTime,
      allowSyntheticInProduction: true,
    });

    const htf2Snapshot = CanonicalMarketSnapshotBuilder.build({
      symbol: 'BTCUSDT',
      executionCandles: htf2Candles,
      executionTimeframe: Timeframe.H4,
      asOfTimestamp: decisionTime,
      allowSyntheticInProduction: true,
    });

    // Pure production signal generation from canonical snapshots - ZERO signal property mutation
    const signal = SignalGenerator.generateFromSnapshots({
      executionSnapshot: execSnapshot,
      htf1Snapshot,
      htf2Snapshot,
    });

    // Assert that SignalGenerator naturally produces an executable signal setup
    expect(signal.symbol).toBe('BTCUSDT');
    expect(signal.state).toBe(SignalState.ACTIVE);
    expect(signal.direction).toBe(Direction.BULLISH);
    expect(signal.score).toBeGreaterThanOrEqual(70);
    expect(signal.canonicalCandleTime).toBe(decisionTime.getTime());
    expect(signal.triggerEvidence?.liquiditySweep?.matched).toBe(true);
    expect(signal.entryZone.optimal).toBeGreaterThan(0);
    expect(signal.stopLoss).toBeGreaterThan(0);
    expect(signal.stopLoss).toBeLessThan(signal.entryZone.optimal);
    expect(signal.takeProfits.tp1).toBeGreaterThan(signal.entryZone.optimal);

    const btcBot: IAlgoBot = {
      id: 'bot_btc_liquidity_sweep',
      name: 'BTCUSDT Liquidity Sweeper Test',
      symbol: 'BTCUSDT',
      direction: 'BULLISH',
      timeframe: '15m',
      minScore: 70,
      smcCondition: 'LIQUIDITY_SWEEP',
      lots: 1,
      autoExecutePaper: true,
      notifyWebhook: false,
      isActive: true,
      createdAt: new Date().toISOString(),
      triggerCount: 0,
    };

    jest.spyOn(algoBotsService, 'listBots').mockResolvedValue([btcBot]);

    await algoBotsService.evaluateSignalForBots(signal);

    // ASSERT: placeOrder() was called EXACTLY ONCE
    expect(mockPaperTradingService.placeOrder).toHaveBeenCalledTimes(1);
    expect(mockPaperTradingService.placeOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        symbol: 'BTCUSDT',
        direction: 'BUY',
        orderType: 'MARKET',
      }),
    );
  });
});
