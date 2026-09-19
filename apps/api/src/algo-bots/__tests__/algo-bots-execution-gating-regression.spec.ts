import { PrismaClient } from '@prisma/client';
import { AlgoBotsService, IAlgoBot } from '../algo-bots.service';
import { PaperTradingService } from '../../paper-trading/paper-trading.service';
import { AlertsService } from '../../alerts/alerts.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  Direction,
  ISignalSetup,
  SignalGrade,
  SignalState,
  TradeLifecycleState,
  Timeframe,
} from '@quant/shared';

describe('Algo Bot Auto-Execution Gating Regression Suite (Fix Bug cc4e5fade6a3f33d08fe422b82ad3b0d42798758)', () => {
  const DB_URL =
    process.env.TEST_DATABASE_URL ||
    process.env.DATABASE_URL ||
    'postgresql://postgres:postgrespassword@localhost:5433/trading_platform?schema=public';

  let prisma: PrismaClient;
  let algoBotsService: AlgoBotsService;
  let mockPaperTradingService: any;
  let mockAlertsService: any;

  const originalEnv = { ...process.env };

  const buildValidSignal = (overrides?: Partial<ISignalSetup>): ISignalSetup => {
    const now = Date.now();
    const candleTime = Math.floor(now / (15 * 60 * 1000)) * (15 * 60 * 1000);
    return {
      id: `sig_regr_${now}`,
      symbol: 'NIFTY',
      direction: Direction.BULLISH,
      grade: SignalGrade.A_PLUS,
      score: 85,
      entryZone: { min: 24000, max: 24010, optimal: 24005 },
      stopLoss: 23950,
      takeProfits: { tp1: 24100, tp2: 24200, tp3: 24300 },
      riskRewardRatios: { rr1: 1.9, rr2: 3.9, rr3: 5.9 },
      timeframe: Timeframe.M15,
      timestamp: new Date(candleTime),
      canonicalCandleTime: candleTime,
      canonicalDecisionTime: new Date(candleTime),
      state: SignalState.ACTIVE,
      triggerEvidence: {
        orderBlock: { matched: true, timestamp: new Date(candleTime), details: 'OB tap' },
      },
      reasoning: {
        htfStructure: 'Bullish BOS',
        liquidityReason: 'Sell side liquidity swept',
        triggerReason: 'Institutional Bullish Order Block tap',
        invalidationReason: 'Below 23950',
        confirmedChecklist: ['Order Block'],
        summary: 'Bullish Order Block setup',
      },
      scoreBreakdown: {
        htfBias: 20,
        liquiditySweep: 15,
        bos: 15,
        fvg: 10,
        orderBlock: 20,
        displacement: 10,
        volumeConfirmation: 10,
        premiumDiscount: 0,
        riskReward: 0,
        indicatorAlignment: 0,
        totalScore: 85,
        grade: SignalGrade.A_PLUS,
      },
      ...overrides,
    };
  };

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
    await prisma.$connect();
  });

  afterAll(async () => {
    process.env = { ...originalEnv };
    if (prisma) {
      await prisma.$disconnect();
    }
  });

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };

    mockPaperTradingService = {
      getPortfolio: jest.fn().mockResolvedValue({
        initialCapital: 1000000,
        currentCapital: 1000000,
        openPositions: [],
        accountId: 'acc_authoritative_01',
      }),
      getValidatedMarketPrice: jest.fn().mockResolvedValue({
        price: 24005,
        timestamp: new Date(),
      }),
      placeOrder: jest.fn().mockResolvedValue({
        id: `pos_order_${Date.now()}`,
        status: 'FILLED',
        entryPrice: 24005,
      }),
    };

    mockAlertsService = {
      sendAlert: jest.fn().mockResolvedValue({ success: true }),
    };

    algoBotsService = new AlgoBotsService(
      mockPaperTradingService as unknown as PaperTradingService,
      mockAlertsService as unknown as AlertsService,
      prisma as unknown as PrismaService,
    );
  });

  describe('Requirement 11: Regression Test Suite', () => {
    // 11.A
    it('11.A: PAPER_TRADING_ENABLED=true + ENABLE_PAPER_ALGO_BOTS=false => NIFTY/BANKNIFTY cannot place a trade', async () => {
      process.env.PAPER_TRADING_ENABLED = 'true';
      process.env.ENABLE_PAPER_ALGO_BOTS = 'false';

      const botId = `bot_test_11a_${Date.now()}`;
      await prisma.algoBot.create({
        data: {
          id: botId,
          name: 'NIFTY Active Test Bot',
          symbol: 'NIFTY',
          direction: 'ANY',
          timeframe: '15m',
          minScore: 80,
          smcCondition: 'ORDER_BLOCK',
          lots: 1,
          isActive: true,
          autoExecutePaper: true,
        },
      });

      try {
        const signal = buildValidSignal({ symbol: 'NIFTY' });
        const results = await algoBotsService.evaluateSignalForBots(signal);

        const botResult = results.find((r) => r.botId === botId);
        expect(botResult).toBeDefined();
        expect(botResult!.status).toBe('REJECTED');
        expect(botResult!.reasonCode).toBe('PAPER_ALGO_BOTS_DISABLED');
        expect(botResult!.decision).toBe('REJECT');
        expect(botResult!.lifecycleState).toBe(TradeLifecycleState.TRADE_REJECTED);

        expect(mockPaperTradingService.placeOrder).not.toHaveBeenCalled();
      } finally {
        await prisma.algoBot.deleteMany({ where: { id: botId } });
      }
    });

    // 11.B
    it('11.B: PAPER_TRADING_ENABLED=true + ENABLE_PAPER_ALGO_BOTS=true + bot.isActive=false => cannot place a trade', async () => {
      process.env.PAPER_TRADING_ENABLED = 'true';
      process.env.ENABLE_PAPER_ALGO_BOTS = 'true';

      const botId = `bot_test_11b_${Date.now()}`;
      await prisma.algoBot.create({
        data: {
          id: botId,
          name: 'NIFTY Inactive Test Bot',
          symbol: 'NIFTY',
          direction: 'ANY',
          timeframe: '15m',
          minScore: 80,
          smcCondition: 'ORDER_BLOCK',
          lots: 1,
          isActive: false, // Inactive bot
          autoExecutePaper: true,
        },
      });

      try {
        const signal = buildValidSignal({ symbol: 'NIFTY' });
        const results = await algoBotsService.evaluateSignalForBots(signal);

        const botResult = results.find((r) => r.botId === botId);
        expect(botResult).toBeDefined();
        expect(botResult!.status).toBe('REJECTED');
        expect(botResult!.reasonCode).toBe('BOT_INACTIVE');
        expect(botResult!.decision).toBe('REJECT');
        expect(botResult!.lifecycleState).toBe(TradeLifecycleState.TRADE_REJECTED);

        expect(mockPaperTradingService.placeOrder).not.toHaveBeenCalled();
      } finally {
        await prisma.algoBot.deleteMany({ where: { id: botId } });
      }
    });

    // 11.C
    it('11.C: PAPER_TRADING_ENABLED=true + ENABLE_PAPER_ALGO_BOTS=true + bot.autoExecutePaper=false => cannot place a trade', async () => {
      process.env.PAPER_TRADING_ENABLED = 'true';
      process.env.ENABLE_PAPER_ALGO_BOTS = 'true';

      const botId = `bot_test_11c_${Date.now()}`;
      await prisma.algoBot.create({
        data: {
          id: botId,
          name: 'NIFTY No-AutoExecute Test Bot',
          symbol: 'NIFTY',
          direction: 'ANY',
          timeframe: '15m',
          minScore: 80,
          smcCondition: 'ORDER_BLOCK',
          lots: 1,
          isActive: true,
          autoExecutePaper: false, // AutoExecute disabled
        },
      });

      try {
        const signal = buildValidSignal({ symbol: 'NIFTY' });
        const results = await algoBotsService.evaluateSignalForBots(signal);

        const botResult = results.find((r) => r.botId === botId);
        expect(botResult).toBeDefined();
        expect(botResult!.status).toBe('SKIPPED');
        expect(botResult!.reasonCode).toBe('AUTO_EXECUTE_PAPER_DISABLED');
        expect(botResult!.decision).toBe('REJECT');
        expect(botResult!.lifecycleState).toBe(TradeLifecycleState.TRADE_REJECTED);

        expect(mockPaperTradingService.placeOrder).not.toHaveBeenCalled();
      } finally {
        await prisma.algoBot.deleteMany({ where: { id: botId } });
      }
    });

    // 11.D
    it('11.D: All four gates enabled => valid signal may proceed to TradeDecision and placeOrder', async () => {
      process.env.PAPER_TRADING_ENABLED = 'true';
      process.env.ENABLE_PAPER_ALGO_BOTS = 'true';

      const botId = `bot_test_11d_${Date.now()}`;
      await prisma.algoBot.create({
        data: {
          id: botId,
          name: 'NIFTY Fully-Enabled Test Bot',
          symbol: 'NIFTY',
          direction: 'ANY',
          timeframe: '15m',
          minScore: 80,
          smcCondition: 'ORDER_BLOCK',
          lots: 1,
          isActive: true,
          autoExecutePaper: true,
        },
      });

      try {
        const signal = buildValidSignal({ symbol: 'NIFTY' });
        const results = await algoBotsService.evaluateSignalForBots(signal);

        const botResult = results.find((r) => r.botId === botId);
        expect(botResult).toBeDefined();
        expect(botResult!.status).toBe('EXECUTED');
        expect(botResult!.reasonCode).toBe('ORDER_PLACED_SUCCESSFULLY');
        expect(botResult!.decision).toBe('TAKE');
        expect(botResult!.lifecycleState).toBe(TradeLifecycleState.POSITION_OPENED);
        expect(botResult!.executionId).toBeDefined();
        expect(botResult!.orderPositionId).toBeDefined();

        expect(mockPaperTradingService.placeOrder).toHaveBeenCalledTimes(1);
        expect(mockPaperTradingService.placeOrder).toHaveBeenCalledWith(
          expect.objectContaining({
            symbol: 'NIFTY',
            direction: 'BUY',
          }),
        );
      } finally {
        await prisma.algoBotExecution.deleteMany({ where: { botId } });
        await prisma.tradeDecision.deleteMany({ where: { botId } });
        await prisma.algoBot.deleteMany({ where: { id: botId } });
      }
    });

    // 11.E
    it('11.E: Restart/onModuleInit never changes persisted isActive/autoExecutePaper values', async () => {
      const testBotId = `bot_test_11e_${Date.now()}`;
      await prisma.algoBot.create({
        data: {
          id: testBotId,
          name: 'Configured DB Bot',
          symbol: 'NIFTY',
          direction: 'ANY',
          timeframe: '15m',
          minScore: 80,
          smcCondition: 'ORDER_BLOCK',
          lots: 1,
          isActive: false,
          autoExecutePaper: false,
        },
      });

      try {
        // Run with PAPER_TRADING_ENABLED=true & ENABLE_PAPER_ALGO_BOTS=true
        process.env.PAPER_TRADING_ENABLED = 'true';
        process.env.ENABLE_PAPER_ALGO_BOTS = 'true';
        await algoBotsService.onModuleInit();

        let botInDb = await prisma.algoBot.findUnique({ where: { id: testBotId } });
        expect(botInDb!.isActive).toBe(false);
        expect(botInDb!.autoExecutePaper).toBe(false);

        // Run with PAPER_TRADING_ENABLED=false & ENABLE_PAPER_ALGO_BOTS=false
        process.env.PAPER_TRADING_ENABLED = 'false';
        process.env.ENABLE_PAPER_ALGO_BOTS = 'false';
        await algoBotsService.onModuleInit();

        botInDb = await prisma.algoBot.findUnique({ where: { id: testBotId } });
        expect(botInDb!.isActive).toBe(false);
        expect(botInDb!.autoExecutePaper).toBe(false);
      } finally {
        await prisma.algoBot.deleteMany({ where: { id: testBotId } });
      }
    });

    // 11.F
    it('11.F: Missing accountId => deterministic ACCOUNT_ID_REQUIRED rejection', async () => {
      process.env.PAPER_TRADING_ENABLED = 'true';
      process.env.ENABLE_PAPER_ALGO_BOTS = 'true';

      // Mock portfolio returns no accountId and bot has no accountId
      mockPaperTradingService.getPortfolio.mockResolvedValue({
        initialCapital: 1000000,
        currentCapital: 1000000,
        openPositions: [],
        accountId: undefined, // Missing account identity
      });

      const botId = `bot_test_11f_${Date.now()}`;
      await prisma.algoBot.create({
        data: {
          id: botId,
          name: 'Bot Without Account',
          symbol: 'NIFTY',
          direction: 'ANY',
          timeframe: '15m',
          minScore: 80,
          smcCondition: 'ORDER_BLOCK',
          lots: 1,
          isActive: true,
          autoExecutePaper: true,
        },
      });

      try {
        const signal = buildValidSignal({ symbol: 'NIFTY' });
        const results = await algoBotsService.evaluateSignalForBots(signal);

        const botResult = results.find((r) => r.botId === botId);
        expect(botResult).toBeDefined();
        expect(botResult!.status).toBe('REJECTED');
        expect(botResult!.reasonCode).toBe('ACCOUNT_ID_REQUIRED');
        expect(botResult!.decision).toBe('REJECT');
        expect(botResult!.lifecycleState).toBe(TradeLifecycleState.TRADE_REJECTED);

        expect(mockPaperTradingService.placeOrder).not.toHaveBeenCalled();
      } finally {
        await prisma.algoBot.deleteMany({ where: { id: botId } });
      }
    });

    // 11.G
    it('11.G: Reproduce the current bug: start with persisted NIFTY isActive=false/autoExecutePaper=false, initialize service with PAPER_TRADING_ENABLED=true, assert DB state remains false/false', async () => {
      // Ensure NIFTY bot is persisted as false/false
      await prisma.algoBot.upsert({
        where: { id: 'bot_nifty_smc_pro' },
        create: {
          id: 'bot_nifty_smc_pro',
          name: 'NIFTY 15m Institutional Order Flow Scalper',
          symbol: 'NIFTY',
          direction: 'ANY',
          timeframe: '15m',
          minScore: 80,
          smcCondition: 'ORDER_BLOCK',
          lots: 1,
          isActive: false,
          autoExecutePaper: false,
        },
        update: {
          isActive: false,
          autoExecutePaper: false,
        },
      });

      // Initialize service with PAPER_TRADING_ENABLED=true
      process.env.PAPER_TRADING_ENABLED = 'true';
      process.env.ENABLE_PAPER_ALGO_BOTS = 'false';

      await algoBotsService.onModuleInit();

      // Assert DB state remains false/false
      const niftyBot = await prisma.algoBot.findUnique({
        where: { id: 'bot_nifty_smc_pro' },
      });

      expect(niftyBot).toBeDefined();
      expect(niftyBot!.isActive).toBe(false);
      expect(niftyBot!.autoExecutePaper).toBe(false);
    });
  });

  describe('Requirement 12: Real PostgreSQL Prisma Integration Test', () => {
    it('verifies that after service initialization: NIFTY isActive=false, autoExecutePaper=false, BANKNIFTY isActive=false, autoExecutePaper=false', async () => {
      process.env.PAPER_TRADING_ENABLED = 'true';
      process.env.ENABLE_PAPER_ALGO_BOTS = 'true';

      await algoBotsService.onModuleInit();

      const niftyBot = await prisma.algoBot.findUnique({
        where: { id: 'bot_nifty_smc_pro' },
      });
      const bankNiftyBot = await prisma.algoBot.findUnique({
        where: { id: 'bot_banknifty_fvg' },
      });

      expect(niftyBot).toBeDefined();
      expect(niftyBot!.symbol).toBe('NIFTY');
      expect(niftyBot!.timeframe).toBe('15m');
      expect(niftyBot!.direction).toBe('ANY');
      expect(niftyBot!.minScore).toBe(80);
      expect(niftyBot!.smcCondition).toBe('ORDER_BLOCK');
      expect(niftyBot!.lots).toBe(1);
      expect(niftyBot!.isActive).toBe(false);
      expect(niftyBot!.autoExecutePaper).toBe(false);

      expect(bankNiftyBot).toBeDefined();
      expect(bankNiftyBot!.symbol).toBe('BANKNIFTY');
      expect(bankNiftyBot!.timeframe).toBe('15m');
      expect(bankNiftyBot!.direction).toBe('BEARISH');
      expect(bankNiftyBot!.minScore).toBe(85);
      expect(bankNiftyBot!.smcCondition).toBe('FVG');
      expect(bankNiftyBot!.lots).toBe(1);
      expect(bankNiftyBot!.isActive).toBe(false);
      expect(bankNiftyBot!.autoExecutePaper).toBe(false);
    });
  });
});
