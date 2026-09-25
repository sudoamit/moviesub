import { PrismaClient } from '@prisma/client';
import { PaperTradingService } from '../paper-trading.service';
import { PaperPositionMonitorService } from '../paper-position-monitor.service';
import { PaperTradingController } from '../paper-trading.controller';
import { JournalService } from '../../trading-domain/journal.service';
import { Direction, PointInTimeCurrencyConverter } from '@quant/shared';

describe('Trade Cut Logic & Journal Entry Verification Suite', () => {
  jest.setTimeout(30000);

  let prisma: PrismaClient;
  let paperTradingService: PaperTradingService;
  let paperPositionMonitorService: PaperPositionMonitorService;
  let controller: PaperTradingController;
  let journalService: JournalService;

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
        price: 150.0,
        provenance: 'LIVE_PROVIDER',
        marketEventTime: Date.now() - 500,
        providerId: 'NSE_STREAM',
        providerTransport: 'WEBSOCKET_STREAM',
      })),
      getValidatedTicker: jest.fn((symbol: string) => ({
        symbol,
        price: symbol.startsWith('BTC') ? 60000.0 : symbol === 'XAUUSD' ? 2600.0 : 24000.0,
        provenance: 'LIVE_PROVIDER',
        marketEventTime: Date.now() - 500,
        providerId: 'STREAMER',
        providerTransport: 'WEBSOCKET_STREAM',
      })),
      isExecutionDataHealthy: jest.fn(() => true),
    } as any;

    journalService = new JournalService(prisma as any);
    paperTradingService = new PaperTradingService(
      prisma as any,
      null as any,
      mockStreamer,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      journalService,
    );
    paperPositionMonitorService = new PaperPositionMonitorService(
      prisma as any,
      paperTradingService,
      mockStreamer,
    );
    controller = new PaperTradingController(paperTradingService, paperPositionMonitorService);

    const account = await prisma.paperAccount.create({
      data: {
        name: `Cut_Journal_Test_Acc_${Date.now()}`,
        cashBalance: 10000000.0,
        usedMargin: 0.0,
        currency: 'INR',
      },
    });
    accountId = account.id;

    const bot = await prisma.algoBot.create({
      data: {
        name: 'Cut Journal Bot',
        symbol: 'BTCUSDT',
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
      await prisma.paperTrade.deleteMany({ where: { accountId } });
      await prisma.paperFill.deleteMany({ where: { position: { accountId } } });
      await prisma.paperOrder.deleteMany({ where: { accountId } });
      await prisma.paperPosition.deleteMany({ where: { accountId } });
      await prisma.paperAccount.delete({ where: { id: accountId } });
    }
    if (testBotId) {
      await prisma.algoBot.delete({ where: { id: testBotId } });
    }
    await prisma.$disconnect();
  });

  describe('1. Trade Cut & Full Lifecycle Journal Entry Creation', () => {
    it(
      'creates completed trade with complete metadata, non-null fees, and exact relational IDs',
      async () => {
      // 1. Open a position
      const order = await paperTradingService.placeOrder({
        accountId,
        symbol: 'NIFTY_SPOT',
        direction: 'BUY',
        quantity: 10,
        price: 24000,
        stopLoss: 23800,
        target1: 24200,
        orderType: 'MARKET',
        strategyDirection: 'BULLISH',
        tradeDecisionId: 'td_test_cut_1',
        featureSnapshotJson: {
          tradeReason: 'SMC Liquidity Sweep Order Flow Setup',
          score: 92,
          grade: 'A+',
        },
      });

      expect(order.status).toBe('OPEN');

      const openPositions = await prisma.paperPosition.findMany({
        where: { accountId, status: 'OPEN' },
      });
      expect(openPositions.length).toBeGreaterThanOrEqual(1);
      const position = openPositions[0];

      // 2. Perform a full market cut via controller
      const closedTrade: any = await controller.closePositionById(position.id, {
        reason: 'Manual Market Cut @ Current Price',
        exitPrice: 24200,
        allowPriceOverride: true,
      });

      expect(closedTrade).toBeDefined();
      expect(Number(closedTrade.exitPrice)).toBeCloseTo(24200, -2);

      // 3. Verify Position is CLOSED
      const updatedPos = await prisma.paperPosition.findUnique({
        where: { id: position.id },
      });
      expect(updatedPos?.status).toBe('CLOSED');
      expect(Number(updatedPos?.unrealizedPnL)).toBe(0);

      // 4. Verify canonical PaperTrade in PostgreSQL
      const dbTrade = await prisma.paperTrade.findFirst({
        where: { positionId: position.id },
      });

      expect(dbTrade).toBeDefined();
      expect(dbTrade?.symbol).toBe('NIFTY_SPOT');
      expect(dbTrade?.orderSide).toBe('BUY');
      expect(dbTrade?.fees).toBeDefined();
      expect(Number(dbTrade?.fees)).toBeGreaterThan(0);
      expect(dbTrade?.exitReason).toContain('Manual Market Cut');
      expect(Number(dbTrade?.realizedPnL)).toBeGreaterThan(0);

      // 5. Verify getCompletedTrades returns rich metadata
      const completedResult = await controller.getCompletedTrades(accountId);
      expect(completedResult.trades.length).toBeGreaterThanOrEqual(1);

      const targetTrade = completedResult.trades.find((t) => t.positionId === position.id);
      expect(targetTrade).toBeDefined();
      expect(targetTrade?.state).toBe('CLOSED');
      expect(targetTrade?.actualEntryPrice).toBeDefined();
      expect(targetTrade?.actualExitPrice).toBeCloseTo(24200, -2);
      expect(targetTrade?.netPnlAccount).toBeDefined();
      expect(targetTrade?.tradeReason).toContain('SMC');
      expect(targetTrade?.fees).toBeGreaterThan(0);
      expect(completedResult.stats.totalTrades).toBeGreaterThanOrEqual(1);
      expect(completedResult.stats.totalVerifiedTrades).toBeGreaterThanOrEqual(1);
    }, 30000);

    it('recovers orphaned CLOSING position and closes cleanly', async () => {
      // Create a position stuck in CLOSING with updatedAt in the past
      const pos = await prisma.paperPosition.create({
        data: {
          accountId,
          symbol: 'NIFTY_SPOT',
          contractSymbol: 'NIFTY_SPOT',
          direction: Direction.BULLISH,
          quantity: 25,
          entryPrice: 24100,
          currentPrice: 24150,
          usedMargin: 602500,
          status: 'CLOSING',
          correlationId: 'corr_test_orphan',
          updatedAt: new Date(Date.now() - 10000), // 10s ago
          executionEventsJson: {
            accountingSnapshot: {
              accountCurrency: 'INR',
              quoteCurrency: 'INR',
              fxRate: 1.0,
              contractSize: 1,
              instrumentType: 'SPOT',
              symbol: 'NIFTY_SPOT',
              calculatedAt: new Date().toISOString(),
              snapshotHash: 'hash_test_orphan',
            },
          },
        },
      });

      // Calling close on orphaned CLOSING position should heal and close cleanly
      const trade = await paperTradingService.closePosition(pos.id, 'Recovered Market Cut', {
        exitPriceOverride: 24150,
        allowPriceOverride: true,
      });

      expect(trade).toBeDefined();
      const healedPos = await prisma.paperPosition.findUnique({ where: { id: pos.id } });
      expect(healedPos?.status).toBe('CLOSED');
    });
  });

  describe('2. Partial Scale-Out Trade Cut Logic', () => {
    it('executes 50% partial scale-out without closing position or creating duplicate PaperTrade', async () => {
      const order = await paperTradingService.placeOrder({
        accountId,
        symbol: 'NIFTY_SPOT',
        direction: 'BUY',
        quantity: 20,
        price: 24000,
        stopLoss: 23800,
        target1: 24200,
        orderType: 'MARKET',
      });

      const position = await prisma.paperPosition.findUnique({
        where: { id: order.id },
      });
      expect(position).toBeDefined();

      // Execute 50% scale-out cut via controller
      const scaleOutRes = await controller.scaleOutPositionById(position!.id, {
        ratio: 0.5,
        exitPrice: 24100,
        reason: 'Manual 50% Scale Out',
      });

      expect(scaleOutRes).toBeDefined();

      // Position should be PARTIALLY_CLOSED with remaining quantity = 10
      const partiallyClosedPos = await prisma.paperPosition.findUnique({
        where: { id: position!.id },
      });
      expect(partiallyClosedPos?.status).toBe('PARTIALLY_CLOSED');
      expect(Number(partiallyClosedPos?.quantity)).toBe(10);

      // Invariant: ZERO PaperTrade created on partial scale-out
      const tradeCountBeforeFinal = await prisma.paperTrade.count({
        where: { positionId: position!.id },
      });
      expect(tradeCountBeforeFinal).toBe(0);

      // Now close remaining 50% runner
      const finalTrade = await controller.closePositionById(position!.id, {
        reason: 'Runner Final Exit',
        exitPrice: 24200,
        allowPriceOverride: true,
      });

      expect(finalTrade).toBeDefined();

      // Exactly ONE PaperTrade created covering all legs
      const finalTradeCount = await prisma.paperTrade.count({
        where: { positionId: position!.id },
      });
      expect(finalTradeCount).toBe(1);

      const canonicalTrade = await prisma.paperTrade.findFirst({
        where: { positionId: position!.id },
      });
      expect(Number(canonicalTrade?.quantity)).toBe(20);
      expect((canonicalTrade?.chargesJson as any)?.partialExitCharges).toBeGreaterThan(0);
    }, 30000);
  });

  describe('3. Journal Deduplication & Enrichment Logic', () => {
    it('deduplicates journal entries and enriches missing metadata', async () => {
      // Create a real position in DB for foreign key constraint
      const pos = await prisma.paperPosition.create({
        data: {
          accountId,
          symbol: 'BTCUSDT',
          contractSymbol: 'BTCUSDT',
          direction: Direction.BULLISH,
          quantity: 0.1,
          entryPrice: 60000,
          currentPrice: 60000,
          usedMargin: 6000,
          status: 'OPEN',
          correlationId: 'corr_dedup_pos',
          executionEventsJson: {
            accountingSnapshot: {
              accountCurrency: 'INR',
              quoteCurrency: 'USDT',
              fxRate: 92.0,
              contractSize: 1,
              instrumentType: 'CRYPTO',
              symbol: 'BTCUSDT',
              calculatedAt: new Date().toISOString(),
              snapshotHash: 'hash_test_dedup',
            },
          },
        },
      });

      const entry1 = await journalService.createJournalEntry({
        accountId,
        positionId: pos.id,
        symbol: 'BTCUSDT',
        contractSymbol: 'BTCUSDT',
        instrumentType: 'CRYPTO',
        direction: Direction.BULLISH,
        quantity: 0.1,
        entryPrice: 60000,
        exitPrice: 61000,
        realizedPnL: 100,
        fees: 2.5,
        exitReason: 'Target 1 Reached',
        correlationId: 'corr_dedup_1',
      });

      expect(entry1).toBeDefined();
      expect(entry1.sourceBotId).toBeNull();

      // Second call with enriched metadata
      const entry2 = await journalService.createJournalEntry({
        accountId,
        positionId: pos.id,
        symbol: 'BTCUSDT',
        contractSymbol: 'BTCUSDT',
        instrumentType: 'CRYPTO',
        direction: Direction.BULLISH,
        sourceBotId: testBotId,
        executionId: 'exec_dedup_enriched',
        tradeDecisionId: 'td_dedup_enriched',
        quantity: 0.1,
        entryPrice: 60000,
        exitPrice: 61000,
        realizedPnL: 100,
        fees: 2.5,
        exitReason: 'Target 1 Reached',
        correlationId: 'corr_dedup_2',
      });

      // Same canonical record ID, enriched with bot & execution IDs
      expect(entry2.id).toBe(entry1.id);
      expect(entry2.sourceBotId).toBe(testBotId);
      expect(entry2.executionId).toBe('exec_dedup_enriched');
    });
  });
});
