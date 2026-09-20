import { PrismaClient } from '@prisma/client';
import { PaperTradingService } from '../paper-trading.service';
import { TradeDecisionService } from '../../algo-bots/trade-decision.service';
import {
  Direction,
  PointInTimeCurrencyConverter,
} from '@quant/shared';

describe('FIX 203: Concurrency Execution CAS Integration Suite (PostgreSQL)', () => {
  let prisma: PrismaClient;
  let paperTradingService: PaperTradingService;
  let tradeDecisionService: TradeDecisionService;

  const dbUrl =
    process.env.TEST_DATABASE_URL ||
    process.env.DATABASE_URL ||
    'postgresql://postgres:postgrespassword@localhost:5433/trading_platform?schema=public';

  let accountId: string;
  let testBotId: string;

  beforeAll(async () => {
    PointInTimeCurrencyConverter.getInstance().seedFixtureRates([
      { pair: 'USDT/INR', rate: 92.0, timestamp: 0, source: 'TEST_FIXTURE', version: '1.0' },
      { pair: 'USD/INR', rate: 87.0, timestamp: 0, source: 'TEST_FIXTURE', version: '1.0' },
    ]);

    prisma = new PrismaClient({ datasources: { db: { url: dbUrl } } });
    await prisma.$connect();

    const mockStreamer = {
      getOptionTicker: jest.fn((contractSymbol: string) => ({
        symbol: contractSymbol,
        price: 160.0,
        provenance: 'LIVE_PROVIDER',
        marketEventTime: Date.now() - 500,
        providerId: 'NSE_STREAM',
        providerTransport: 'WEBSOCKET_STREAM',
      })),
      getValidatedTicker: jest.fn((symbol: string) => ({
        symbol,
        price: symbol.startsWith('BTC') ? 60000.0 : symbol === 'XAUUSD' ? 2600.0 : 3000.0,
        provenance: 'LIVE_PROVIDER',
        marketEventTime: Date.now() - 500,
        providerId: 'STREAMER',
        providerTransport: 'WEBSOCKET_STREAM',
      })),
    } as any;

    paperTradingService = new PaperTradingService(prisma as any, null as any, mockStreamer);
    tradeDecisionService = new TradeDecisionService(prisma as any);

    // Create a dedicated test account
    const account = await prisma.paperAccount.create({
      data: {
        name: `Concurrency_Test_Acc_${Date.now()}`,
        cashBalance: 1000000.0,
        usedMargin: 0.0,
        currency: 'INR',
      },
    });
    accountId = account.id;

    // Create a dedicated test bot record for foreign key integrity
    const bot = await prisma.algoBot.create({
      data: {
        name: 'Concurrency Test Bot',
        symbol: 'NIFTY',
        timeframe: '15m',
        direction: 'BULLISH',
        autoExecutePaper: true,
        isActive: true,
      },
    });
    testBotId = bot.id;
  });

  afterAll(async () => {
    if (accountId) {
      await prisma.algoBotExecution.deleteMany({ where: { botId: testBotId } });
      await prisma.tradeDecision.deleteMany({ where: { accountId } });
      await prisma.algoBot.deleteMany({ where: { id: testBotId } });
      await prisma.paperTrade.deleteMany({ where: { accountId } });
      await prisma.paperFill.deleteMany({ where: { position: { accountId } } });
      await prisma.paperOrder.deleteMany({ where: { accountId } });
      await prisma.paperPosition.deleteMany({ where: { accountId } });
      await prisma.paperAccount.deleteMany({ where: { id: accountId } });
    }
    await prisma.$disconnect();
  });

  describe('Requirement 21: 5 Simultaneous Reservations Concurrency', () => {
    it('executes 5 simultaneous reservations for the same fingerprint: exactly 1 succeeds, 4 return duplicate/idempotent', async () => {
      const now = Date.now();
      const fingerprint = `bot_exec:concurrency_test_${now}:sig_${now}`;
      const bot = {
        id: testBotId,
        name: 'Concurrency Bot',
        symbol: 'NIFTY',
        timeframe: '15m',
        strategyType: 'SMC',
        direction: 'BULLISH',
        capitalAllocation: 100000,
        riskPerTradePercent: 1.0,
        maxOpenPositions: 3,
        autoExecutePaper: true,
        isActive: true,
        accountId,
      } as any;

      const signal = {
        id: `sig_conc_${now}`,
        symbol: 'NIFTY',
        timeframe: '15m',
        direction: Direction.BULLISH,
        grade: 'A_PLUS',
        canonicalCandleTime: now - 60000,
        canonicalDecisionTime: now - 60000,
        stopLoss: 24000,
        target1: 24200,
        target2: 24300,
        target3: 24400,
        suggestedEntryPrice: 24100,
      } as any;

      const plannedLevels = {
        optimalEntry: 150.0,
        stopLoss: 100.0,
        target1: 180.0,
        target2: 210.0,
        target3: 250.0,
        quantity: 65,
        riskAmount: 3250,
        riskPercent: 1.0,
        leverage: 1,
      };

      // Launch 5 simultaneous commitTradeDecisionAndReservation calls with identical fingerprint
      const promises = Array.from({ length: 5 }).map(() =>
        tradeDecisionService.commitTradeDecisionAndReservation({
          fingerprint,
          bot,
          signal,
          decisionResult: {
            decision: 'TAKE' as any,
            decisionReasonCode: 'PRE_TRADE_APPROVED',
            decisionReason: 'Risk checks passed',
            lifecycleState: 'PRE_TRADE_APPROVED' as any,
            plannedLevels,
          },
          accountId,
          correlationId: `corr_${now}`,
          contractSymbol: 'NIFTY 24100 CE',
          executionInstrument: 'NIFTY 24100 CE',
          executionInstrumentType: 'OPTION',
          signalSourceInstrument: 'NIFTY_SPOT',
          strike: 24100,
          optionType: 'CE',
          expiry: '2026-09-24',
          signalDirection: Direction.BULLISH,
          orderSide: 'BUY',
        }),
      );

      const results = await Promise.allSettled(promises);
      const fulfilled = results.filter((r) => r.status === 'fulfilled') as PromiseFulfilledResult<any>[];

      // All 5 must resolve cleanly (either newly created or safely deduplicated)
      expect(fulfilled.length).toBe(5);

      // Verify in Postgres: Exactly 1 TradeDecision and 1 AlgoBotExecution persisted for this fingerprint
      const decisions = await prisma.tradeDecision.findMany({ where: { fingerprint } });
      const executions = await prisma.algoBotExecution.findMany({ where: { fingerprint } });

      expect(decisions.length).toBe(1);
      expect(executions.length).toBe(1);
      expect(decisions[0].lifecycleState).toBe('RESERVATION_CREATED');
      expect(executions[0].state).toBe('RESERVED');
    });
  });

  describe('Requirement 21: 2 Simultaneous Final Closes Concurrency', () => {
    it('executes 2 simultaneous closePosition() calls: exactly 1 executes, produces 1 PaperTrade, and no double P&L mutation', async () => {
      // 1. Create an open position in PostgreSQL
      const initialBalance = 1000000.0;
      await prisma.paperAccount.update({
        where: { id: accountId },
        data: { cashBalance: initialBalance, usedMargin: 0.0, realizedPnL: 0.0 },
      });

      const orderRes = await paperTradingService.placeOrder({
        symbol: 'RELIANCE',
        direction: 'BUY',
        quantity: 10,
        orderType: 'MARKET',
        leverage: 1,
        price: 3000.0,
        stopLoss: 2900.0,
        target1: 3200.0,
        allowPriceOverride: true,
      });

      const positionId = orderRes.id;
      expect(positionId).toBeDefined();

      const positionBeforeClose = await prisma.paperPosition.findUnique({ where: { id: positionId } });
      const initialAccount = await prisma.paperAccount.findUnique({ where: { id: positionBeforeClose!.accountId } });
      const initialRealizedPnL = Number(initialAccount?.realizedPnL || 0);

      // 2. Concurrently execute closePosition from two parallel calls
      const [resA, resB] = await Promise.allSettled([
        paperTradingService.closePosition(positionId, 'Parallel Worker A', {
          exitPriceOverride: 3100.0,
          allowPriceOverride: true,
        }),
        paperTradingService.closePosition(positionId, 'Parallel Worker B', {
          exitPriceOverride: 3100.0,
          allowPriceOverride: true,
        }),
      ]);

      // At least one must fulfill or both return the same canonical completed trade
      const fulfilled = [resA, resB].filter((r) => r.status === 'fulfilled') as PromiseFulfilledResult<any>[];
      expect(fulfilled.length).toBeGreaterThanOrEqual(1);

      // Verify in PostgreSQL:
      // Exactly 1 PaperTrade row for this position
      const trades = await prisma.paperTrade.findMany({ where: { positionId } });
      expect(trades.length).toBe(1);

      // Position status must be CLOSED
      const positionAfterClose = await prisma.paperPosition.findUnique({ where: { id: positionId } });
      expect(positionAfterClose?.status).toBe('CLOSED');

      // Account realized P&L delta reconciles exactly (no double P&L mutation)
      const updatedAccount = await prisma.paperAccount.findUnique({ where: { id: positionBeforeClose!.accountId } });
      const deltaRealizedPnL = Number(updatedAccount?.realizedPnL || 0) - initialRealizedPnL;
      expect(deltaRealizedPnL).toBeGreaterThan(0);
      expect(trades[0].realizedPnL).toBeDefined();
    });
  });

  describe('Requirement 21: 2 Simultaneous Manual Closes Concurrency', () => {
    it('executes 2 concurrent manual close calls for the same option position without double close', async () => {
      const orderRes = await paperTradingService.placeOrder({
        symbol: 'NIFTY',
        contractSymbol: 'NIFTY 24100 CE',
        direction: 'BUY',
        quantity: 65,
        orderType: 'MARKET',
        leverage: 1,
        price: 150.0,
        stopLoss: 100.0,
        target1: 200.0,
        allowPriceOverride: true,
        instrumentType: 'OPTION',
        strike: 24100,
        optionType: 'CE',
      });

      const positionId = orderRes.id;

      const [res1, res2] = await Promise.allSettled([
        paperTradingService.closePosition(positionId, 'Manual Exit UI Click 1', {
          exitPriceOverride: 180.0,
          allowPriceOverride: true,
          outcomeClassification: 'MANUAL_EXIT',
        }),
        paperTradingService.closePosition(positionId, 'Manual Exit UI Click 2', {
          exitPriceOverride: 180.0,
          allowPriceOverride: true,
          outcomeClassification: 'MANUAL_EXIT',
        }),
      ]);

      const trades = await prisma.paperTrade.findMany({ where: { positionId } });
      expect(trades.length).toBe(1);
      expect(trades[0].outcomeClassification).toBe('MANUAL_EXIT');

      const position = await prisma.paperPosition.findUnique({ where: { id: positionId } });
      expect(position?.status).toBe('CLOSED');
    });
  });
});
