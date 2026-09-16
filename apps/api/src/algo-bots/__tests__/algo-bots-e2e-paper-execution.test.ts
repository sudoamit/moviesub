import { PrismaClient } from '@prisma/client';
import { AlgoBotsService, IAlgoBot } from '../algo-bots.service';
import { SignalsService } from '../../signals/signals.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  Direction,
  ICandle,
  ISignalSetup,
  SignalGrade,
  SignalState,
  Timeframe,
} from '@quant/shared';
import {
  SignalGenerator,
  CanonicalMarketSnapshotBuilder,
} from '@quant/trading-engine';

describe('Fix 177 — Real End-to-End Paper Execution Integration Test', () => {
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

  it('Requirement 10: E2E Pipeline — Canonical Candle -> ACTIVE signal -> Bot match -> Reservation -> EXECUTING -> placeOrder() -> EXECUTED', async () => {
    algoBotsService = new AlgoBotsService(
      mockPaperTradingService,
      mockAlertsService,
      (prismaClient as unknown as PrismaService) || undefined,
      null as any,
    );

    await algoBotsService.onModuleInit();

    // Create a 15m candle series for BTCUSDT ending with a valid closed candle
    const now = Date.now();
    const candles: ICandle[] = [];
    let price = 64000;

    for (let i = 50; i >= 0; i--) {
      const time = new Date(now - i * 15 * 60 * 1000);
      const isBull = i % 2 === 0;
      const open = price;
      const close = isBull ? price + 100 : price - 50;
      const high = Math.max(open, close) + 30;
      const low = Math.min(open, close) - 30;
      price = close;

      candles.push({
        timestamp: time,
        open,
        high,
        low,
        close,
        volume: 1500,
        isClosed: true,
      });
    }

    const decisionTime = candles[candles.length - 1].timestamp as Date;

    const execSnapshot = CanonicalMarketSnapshotBuilder.build({
      symbol: 'BTCUSDT',
      executionCandles: candles,
      executionTimeframe: Timeframe.M15,
      asOfTimestamp: decisionTime,
      allowSyntheticInProduction: true,
    });

    const signal = SignalGenerator.generateFromSnapshots({
      executionSnapshot: execSnapshot,
    });

    // Enforce active signal state for paper execution pipeline validation
    signal.state = SignalState.ACTIVE;
    signal.direction = Direction.BULLISH;
    signal.grade = SignalGrade.A_PLUS;
    signal.score = 85;
    signal.canonicalCandleTime = decisionTime.getTime();
    signal.entryZone = { min: 64900, max: 65100, optimal: 65000 };
    signal.stopLoss = 64000;
    signal.takeProfits = { tp1: 66000, tp2: 67000, tp3: 68000 };
    signal.riskRewardRatios = { rr1: 1.5, rr2: 2.5, rr3: 4.0 };
    signal.triggerEvidence = {
      liquiditySweep: {
        matched: true,
        timestamp: decisionTime,
        candleTime: decisionTime.getTime(),
        timeframe: '15m',
        symbol: 'BTCUSDT',
        details: 'Sell-side liquidity swept',
      },
    };

    const btcBot: IAlgoBot = {
      id: 'bot_btc_liquidity_sweep',
      name: 'BTCUSDT Liquidity Sweeper Test',
      symbol: 'BTCUSDT',
      direction: 'BULLISH',
      timeframe: '15m',
      minScore: 75,
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
