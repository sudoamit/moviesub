import { PrismaClient } from '@prisma/client';
import { AlgoBotsService } from '../algo-bots.service';
import { TradeDecisionService } from '../trade-decision.service';
import { PaperTradingService } from '../../paper-trading/paper-trading.service';
import { PaperPositionMonitorService } from '../../paper-trading/paper-position-monitor.service';
import { RealMarketStreamerService } from '../../market-data/real-market-streamer.service';
import { AlertsService } from '../../alerts/alerts.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  Direction,
  ISignalSetup,
  SignalGrade,
  SignalState,
  Timeframe,
  PositionState,
  TradeLifecycleState,
  PointInTimeCurrencyConverter,
} from '@quant/shared';

describe('Fix 202: PostgreSQL E2E Pipeline for Options-Only Algo Bot Execution', () => {
  let prisma: PrismaClient;
  let algoBotsService: AlgoBotsService;
  let tradeDecisionService: TradeDecisionService;
  let paperTradingService: PaperTradingService;
  let monitorService: PaperPositionMonitorService;
  let paperAccountId: string;

  const DB_URL =
    process.env.TEST_DATABASE_URL ||
    process.env.DATABASE_URL ||
    'postgresql://postgres:postgrespassword@localhost:5433/trading_platform?schema=public';

  const optionQuotes: Record<string, { price: number; lastUpdated: number }> = {};
  let currentSpotPrice = 24120.0;

  const mockStreamer: any = {
    getValidatedTicker: (sym: string) => ({
      symbol: sym,
      price: currentSpotPrice,
      provenance: 'LIVE_PROVIDER' as const,
      marketEventTime: Date.now(),
      lastUpdated: Date.now(),
    }),
    getOptionTicker: (contractSymbol: string) => {
      const q = optionQuotes[contractSymbol];
      if (!q) return null;
      return {
        symbol: contractSymbol,
        price: q.price,
        provenance: 'LIVE_PROVIDER' as const,
        marketEventTime: q.lastUpdated,
        lastUpdated: q.lastUpdated,
      };
    },
    updateTicker: () => {},
  };

  const mockAlertsService: any = {
    sendAlert: jest.fn().mockResolvedValue({ success: true }),
  };

  const nowMs = 1726488000000;

  beforeAll(async () => {
    process.env.PAPER_TRADING_ENABLED = 'true';
    process.env.ENABLE_PAPER_ALGO_BOTS = 'true';

    PointInTimeCurrencyConverter.getInstance().seedFixtureRates([
      { pair: 'USDT/INR', rate: 92.0, timestamp: 0, source: 'TEST_FIXTURE', version: '1.0' },
      { pair: 'USD/INR', rate: 87.0, timestamp: 0, source: 'TEST_FIXTURE', version: '1.0' },
    ]);

    prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
    await prisma.$connect();

    const prismaService = prisma as unknown as PrismaService;

    paperTradingService = new PaperTradingService(
      prismaService,
      null as any,
      mockStreamer as unknown as RealMarketStreamerService,
    );

    tradeDecisionService = new TradeDecisionService(prismaService);

    algoBotsService = new AlgoBotsService(
      paperTradingService,
      mockAlertsService as unknown as AlertsService,
      prismaService,
      null as any,
      tradeDecisionService,
    );

    monitorService = new PaperPositionMonitorService(
      prismaService,
      paperTradingService,
      mockStreamer as unknown as RealMarketStreamerService,
    );

    const account = await paperTradingService.getOrCreateAccount();
    paperAccountId = account.id;
    await prisma.paperAccount.updateMany({
      where: { id: account.id },
      data: {
        initialCapital: 10000000.0,
        cashBalance: 10000000.0,
        usedMargin: 0.0,
      },
    });
  });

  beforeEach(async () => {
    jest.restoreAllMocks();
    jest.spyOn(Date, 'now').mockReturnValue(nowMs);

    // Clean active positions
    await prisma.paperPosition.updateMany({
      where: {
        accountId: paperAccountId,
        status: { in: [PositionState.OPEN, PositionState.PARTIALLY_CLOSED, PositionState.EXIT_PENDING] },
      },
      data: { status: PositionState.CLOSED },
    });

    // Clear test bots
    await prisma.algoBot.deleteMany({
      where: { symbol: 'NIFTY_SPOT' },
    });
  });

  afterAll(async () => {
    delete process.env.PAPER_TRADING_ENABLED;
    delete process.env.ENABLE_PAPER_ALGO_BOTS;
    if (prisma) {
      await prisma.$disconnect();
    }
  });

  const createSignal = (overrides?: any): ISignalSetup => ({
    id: `sig_e2e_${Date.now()}_${Math.random().toString(36).substring(7)}`,
    symbol: 'NIFTY_SPOT',
    timeframe: Timeframe.M15,
    direction: Direction.BULLISH,
    state: SignalState.ACTIVE,
    grade: SignalGrade.A_PLUS,
    score: 85,
    canonicalCandleTime: nowMs,
    canonicalDecisionTime: new Date(nowMs),
    entryZone: { min: 24100, max: 24120, optimal: 24110 },
    stopLoss: 24000,
    takeProfits: { tp1: 24200, tp2: 24300, tp3: 24400 },
    riskRewardRatios: { rr1: 1.0, rr2: 2.0, rr3: 3.0 },
    reasoning: {
      htfStructure: 'Bullish BOS',
      liquidityReason: 'Sellside swept',
      triggerReason: '15m Bullish OB tap',
      invalidationReason: 'Below 24000',
      confirmedChecklist: ['Order Block'],
      summary: 'OB tap entry',
    },
    scoreBreakdown: {
      htfBias: 20,
      liquiditySweep: 20,
      bos: 15,
      fvg: 10,
      orderBlock: 20,
      displacement: 0,
      volumeConfirmation: 0,
      premiumDiscount: 0,
      riskReward: 0,
      indicatorAlignment: 0,
      totalScore: 85,
      grade: SignalGrade.A_PLUS,
    },
    triggerEvidence: {
      orderBlock: { matched: true, timestamp: new Date(nowMs - 60000) },
    },
    timestamp: new Date(nowMs),
    ...overrides,
  });

  it('Complete Pipeline E2E: SIGNAL -> TRADE DECISION -> TRADE TAKEN -> RESERVATION -> ORDER -> FILL -> POSITION -> TP1 leg -> TP2 leg -> TP3 leg -> CANONICAL PAPER TRADE -> JOURNAL', async () => {
    // 1. Setup Live Option Quotes
    const contractSymbol = 'NIFTY 24100 CE';
    optionQuotes[contractSymbol] = { price: 150.0, lastUpdated: nowMs };

    // 2. Create Options Algo Bot in PostgreSQL
    const bot = await prisma.algoBot.create({
      data: {
        id: `bot_opt_e2e_${Date.now()}`,
        name: 'NIFTY Bullish Options Pipeline Bot',
        symbol: 'NIFTY_SPOT',
        executionInstrument: 'NIFTY OPTION',
        executionInstrumentType: 'OPTION',
        signalSourceInstrument: 'NIFTY_SPOT',
        direction: 'ANY',
        timeframe: '15m',
        minScore: 75,
        smcCondition: 'ORDER_BLOCK',
        lots: 1, // 1 lot = 65 units for NIFTY
        autoExecutePaper: true,
        notifyWebhook: false,
        isActive: true,
        triggerCount: 0,
      },
    });

    // 3. PIPELINE STEP 1: SIGNAL
    const bullishSignal = createSignal({ direction: Direction.BULLISH });

    // 4. Trigger Execution via evaluateSignalForBots
    const results = await algoBotsService.evaluateSignalForBots(bullishSignal);

    // 5. PIPELINE STEP 2 & 3: TRADE DECISION & TRADE TAKEN
    expect(results).toHaveLength(1);
    const execRes = results[0];
    expect(execRes.botId).toBe(bot.id);
    expect(execRes.decision).toBe('TAKE');
    expect(execRes.status).toBe('EXECUTED');
    expect(execRes.orderPositionId).toBeDefined();
    const positionId = execRes.orderPositionId!;

    // Verify TradeDecision in PostgreSQL
    const dbTradeDecisions = await prisma.tradeDecision.findMany({
      where: { botId: bot.id },
      orderBy: { createdAt: 'desc' },
      take: 1,
    });
    expect(dbTradeDecisions).toHaveLength(1);
    const dbDecision = dbTradeDecisions[0];
    expect(dbDecision.decision).toBe('TAKE');
    expect(dbDecision.executionInstrument).toBe(contractSymbol);
    expect(dbDecision.executionInstrumentType).toBe('OPTION');
    expect(Number(dbDecision.strike)).toBe(24100);
    expect(dbDecision.optionType).toBe('CE');
    expect(dbDecision.signalDirection).toBe(Direction.BULLISH);
    expect(dbDecision.orderSide).toBe('BUY');

    // 6. PIPELINE STEP 4: RESERVATION
    const dbExecution = await prisma.algoBotExecution.findFirst({
      where: { botId: bot.id },
      orderBy: { createdAt: 'desc' },
    });
    expect(dbExecution).toBeDefined();
    expect(dbExecution!.state).toBe('EXECUTED');
    expect(dbExecution!.orderPositionId).toBe(positionId);
    expect(dbExecution!.executionInstrument).toBe(contractSymbol);
    expect(dbExecution!.executionInstrumentType).toBe('OPTION');
    expect(Number(dbExecution!.strike)).toBe(24100);
    expect(dbExecution!.optionType).toBe('CE');

    // 7. PIPELINE STEP 5: ORDER
    const dbPosInitial = await prisma.paperPosition.findUnique({ where: { id: positionId } });
    expect(dbPosInitial!.orderId).toBeDefined();

    const dbOrder = await prisma.paperOrder.findUnique({
      where: { id: dbPosInitial!.orderId! },
    });
    expect(dbOrder).toBeDefined();
    expect(dbOrder!.contractSymbol).toBe(contractSymbol);
    expect(dbOrder!.instrumentType).toBe('OPTION');
    expect(dbOrder!.direction).toBe(Direction.BULLISH); // BUY side
    expect(dbOrder!.strategyDirection).toBe(Direction.BULLISH);
    expect(Number(dbOrder!.requestedQuantity)).toBe(65);
    expect(Number(dbOrder!.strike)).toBe(24100);
    expect(dbOrder!.optionType).toBe('CE');

    // 8. PIPELINE STEP 6: FILL
    const dbFill = await prisma.paperFill.findFirst({
      where: { orderId: dbOrder!.id },
    });
    expect(dbFill).toBeDefined();
    expect(Number(dbFill!.fillQuantity)).toBe(65);
    expect(Number(dbFill!.fillPrice)).toBeGreaterThanOrEqual(150);

    // 9. PIPELINE STEP 7: POSITION
    let dbPos = await prisma.paperPosition.findUnique({
      where: { id: positionId },
    });
    expect(dbPos).toBeDefined();
    expect(dbPos!.contractSymbol).toBe(contractSymbol);
    expect(dbPos!.instrumentType).toBe('OPTION');
    expect(dbPos!.direction).toBe(Direction.BULLISH); // BUY
    expect(dbPos!.strategyDirection).toBe(Direction.BULLISH);
    expect(dbPos!.status).toBe(PositionState.OPEN);
    expect(Number(dbPos!.quantity)).toBe(65);
    expect(Number(dbPos!.strike)).toBe(24100);
    expect(dbPos!.optionType).toBe('CE');

    // Invariant: Levels are on option premium scale
    const entryPrice = Number(dbPos!.entryPrice);
    const stopLoss = Number(dbPos!.stopLoss);
    const target1 = Number(dbPos!.target1);
    const target2 = Number(dbPos!.target2);
    const target3 = Number(dbPos!.target3);

    expect(entryPrice).toBeGreaterThan(140);
    expect(entryPrice).toBeLessThan(160);
    expect(stopLoss).toBeLessThan(entryPrice);
    expect(entryPrice).toBeLessThan(target1);
    expect(target1).toBeLessThan(target2);
    expect(target2).toBeLessThan(target3);

    // 10. PIPELINE STEP 8: TP1 EXECUTION LEG
    // Advance option price to target1
    optionQuotes[contractSymbol] = { price: target1, lastUpdated: nowMs + 60000 };
    dbPos = await prisma.paperPosition.findUnique({ where: { id: positionId } });
    await monitorService.evaluateSinglePosition(dbPos);

    dbPos = await prisma.paperPosition.findUnique({ where: { id: positionId } });
    expect(dbPos!.status).toBe(PositionState.PARTIALLY_CLOSED);
    // 30% scale-out: 65 * 0.3 = 19.5 -> rounded to 20 units; 45 units remaining
    expect(Number(dbPos!.quantity)).toBeLessThan(65);
    // StopLoss moved to breakeven
    expect(Number(dbPos!.stopLoss)).toBe(entryPrice);

    // Verify TP1 leg recorded in executionEventsJson
    const eventsAfterTP1 = dbPos!.executionEventsJson as any;
    expect(eventsAfterTP1.partialLegs).toBeDefined();
    expect(eventsAfterTP1.partialLegs.length).toBe(1);
    expect(eventsAfterTP1.partialLegs[0].role).toBe('TP1_PARTIAL');
    expect(eventsAfterTP1.tp1FillTime).toBeDefined();

    // 11. PIPELINE STEP 9: TP2 EXECUTION LEG
    // Advance option price to target2
    optionQuotes[contractSymbol] = { price: target2, lastUpdated: nowMs + 120000 };
    dbPos = await prisma.paperPosition.findUnique({ where: { id: positionId } });
    await monitorService.evaluateSinglePosition(dbPos);

    dbPos = await prisma.paperPosition.findUnique({ where: { id: positionId } });
    expect(dbPos!.status).toBe(PositionState.PARTIALLY_CLOSED);
    expect(Number(dbPos!.quantity)).toBeLessThan(45.5);

    // Verify TP2 leg recorded
    const eventsAfterTP2 = dbPos!.executionEventsJson as any;
    expect(eventsAfterTP2.partialLegs.length).toBe(2);
    expect(eventsAfterTP2.partialLegs[1].role).toBe('TP2_PARTIAL');
    expect(eventsAfterTP2.tp2FillTime).toBeDefined();

    // 12. PIPELINE STEP 10: TP3 EXECUTION LEG (FINAL RUNNER CLOSE)
    // Advance option price to target3
    optionQuotes[contractSymbol] = { price: target3, lastUpdated: nowMs + 180000 };
    dbPos = await prisma.paperPosition.findUnique({ where: { id: positionId } });
    await monitorService.evaluateSinglePosition(dbPos);

    dbPos = await prisma.paperPosition.findUnique({ where: { id: positionId } });
    expect(dbPos!.status).toBe(PositionState.CLOSED);
    expect(dbPos!.closedAt).toBeDefined();

    // 13. PIPELINE STEP 11: CANONICAL PAPER TRADE
    // Exactly 1 PaperTrade record created for the full position lifecycle
    const paperTrades = await prisma.paperTrade.findMany({
      where: { positionId },
    });
    expect(paperTrades).toHaveLength(1);
    const trade = paperTrades[0];
    expect(trade.positionId).toBe(positionId);
    expect(trade.symbol).toBe('NIFTY_SPOT');
    expect(trade.direction).toBe(Direction.BULLISH);
    expect(trade.exitReason).toBe('Target 3 Completed');
    expect(Number(trade.realizedPnL)).toBeGreaterThan(0);
    expect(Number(trade.realizedR)).toBeGreaterThan(0);
    expect(trade.exitTime).toBeDefined();

    // 14. PIPELINE STEP 12: JOURNAL
    // Provenance verification: Order, Fills, Legs, and Trade all form an immutable audit chain
    const allFills = await prisma.paperFill.findMany({
      where: { correlationId: dbPos!.correlationId },
    });
    // Opening fill + partial TP fills
    expect(allFills.length).toBeGreaterThanOrEqual(2);
  });

  it('Complete Pipeline E2E (BEARISH): SIGNAL (BEARISH) -> TRADE DECISION -> TRADE TAKEN -> RESERVATION -> ORDER (BUY PE) -> FILL -> POSITION -> TP1 leg -> Breakeven SL leg -> CANONICAL PAPER TRADE', async () => {
    // 1. Setup Live Option Quotes for PE
    const contractSymbol = 'NIFTY 24100 PE';
    optionQuotes[contractSymbol] = { price: 160.0, lastUpdated: nowMs };

    // 2. Create Options Algo Bot in PostgreSQL
    const bot = await prisma.algoBot.create({
      data: {
        id: `bot_opt_e2e_bear_${Date.now()}`,
        name: 'NIFTY Bearish Options Pipeline Bot',
        symbol: 'NIFTY_SPOT',
        executionInstrument: 'NIFTY OPTION',
        executionInstrumentType: 'OPTION',
        signalSourceInstrument: 'NIFTY_SPOT',
        direction: 'ANY',
        timeframe: '15m',
        minScore: 75,
        smcCondition: 'ORDER_BLOCK',
        lots: 1, // 1 lot = 65 units for NIFTY
        autoExecutePaper: true,
        notifyWebhook: false,
        isActive: true,
        triggerCount: 0,
      },
    });

    // 3. PIPELINE STEP 1: BEARISH SIGNAL
    const bearishSignal = createSignal({
      direction: Direction.BEARISH,
      entryZone: { min: 24100, max: 24120, optimal: 24110 },
      stopLoss: 24200,
      takeProfits: { tp1: 24000, tp2: 23900, tp3: 23800 },
      reasoning: {
        htfStructure: 'Bearish BOS',
        liquidityReason: 'Buyside swept',
        triggerReason: '15m Bearish OB tap',
        invalidationReason: 'Above 24200',
        confirmedChecklist: ['Order Block'],
        summary: 'OB tap entry',
      },
      triggerEvidence: {
        orderBlock: { matched: true, timestamp: new Date(nowMs - 60000) },
      },
    });

    // 4. Trigger Execution
    const results = await algoBotsService.evaluateSignalForBots(bearishSignal);

    expect(results).toHaveLength(1);
    const execRes = results[0];
    expect(execRes.botId).toBe(bot.id);
    expect(execRes.decision).toBe('TAKE');
    expect(execRes.status).toBe('EXECUTED');
    const positionId = execRes.orderPositionId!;

    // 5. Verify POSITION: Direction is BUY (Long PE)
    let dbPos = await prisma.paperPosition.findUnique({
      where: { id: positionId },
    });
    expect(dbPos).toBeDefined();
    expect(dbPos!.contractSymbol).toBe(contractSymbol);
    expect(dbPos!.instrumentType).toBe('OPTION');
    expect(dbPos!.direction).toBe(Direction.BULLISH); // Options are ALWAYS bought
    expect(dbPos!.strategyDirection).toBe(Direction.BEARISH); // Underlying index bias
    expect(dbPos!.optionType).toBe('PE');

    const entryPrice = Number(dbPos!.entryPrice);
    const target1 = Number(dbPos!.target1);

    // 6. TP1 Scale-Out Leg
    optionQuotes[contractSymbol] = { price: target1, lastUpdated: nowMs + 60000 };
    dbPos = await prisma.paperPosition.findUnique({ where: { id: positionId } });
    await monitorService.evaluateSinglePosition(dbPos);

    dbPos = await prisma.paperPosition.findUnique({ where: { id: positionId } });
    expect(dbPos!.status).toBe(PositionState.PARTIALLY_CLOSED);
    expect(Number(dbPos!.stopLoss)).toBe(entryPrice); // Breakeven SL

    // 7. Price reverses back down to Breakeven SL
    optionQuotes[contractSymbol] = { price: entryPrice - 1.0, lastUpdated: nowMs + 120000 };
    dbPos = await prisma.paperPosition.findUnique({ where: { id: positionId } });
    await monitorService.evaluateSinglePosition(dbPos);

    dbPos = await prisma.paperPosition.findUnique({ where: { id: positionId } });
    expect(dbPos!.status).toBe(PositionState.CLOSED);
    expect(dbPos!.closedAt).toBeDefined();

    // 8. Canonical PaperTrade Created
    const trades = await prisma.paperTrade.findMany({ where: { positionId } });
    expect(trades).toHaveLength(1);
    expect(trades[0].symbol).toBe('NIFTY_SPOT');
    expect(trades[0].contractSymbol).toBe(contractSymbol);
    expect(trades[0].exitReason).toBe('Breakeven Stop Loss Hit');
  });
});
