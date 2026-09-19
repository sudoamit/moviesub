import { PrismaClient } from '@prisma/client';
import { AlgoBotsService, IAlgoBot } from '../algo-bots.service';
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

describe('Fix 193 Requirements 28-35: NIFTY Bearish -> Bullish Signal Decoupled Lifecycle E2E Suite', () => {
  let prisma: PrismaClient;
  let algoBotsService: AlgoBotsService;
  let tradeDecisionService: TradeDecisionService;
  let paperTradingService: PaperTradingService;
  let monitorService: PaperPositionMonitorService;
  let currentTickerPrice = 24100.0;
  let paperAccountId: string;

  const DB_URL =
    process.env.TEST_DATABASE_URL ||
    process.env.DATABASE_URL ||
    'postgresql://postgres:postgrespassword@localhost:5433/trading_platform?schema=public';

  const mockStreamer: any = {
    getValidatedTicker: (sym: string) => ({
      symbol: sym,
      price: currentTickerPrice,
      provenance: 'LIVE_PROVIDER' as const,
      marketEventTime: Date.now(),
      lastUpdated: Date.now(),
    }),
    getOptionTicker: () => null,
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

    monitorService = new PaperPositionMonitorService(
      prismaService,
      paperTradingService,
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

    // Initialize paper trading account with sufficient capital
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

    await prisma.tradingSystemConfig.upsert({
      where: { id: 'SYSTEM_DEFAULT' },
      create: {
        id: 'SYSTEM_DEFAULT',
        maxPositionRiskPercent: 10.0,
        maxTotalExposurePercent: 90.0,
        maxDailyLossPercent: 50.0,
        maxTradesPerDay: 1000,
        maxOpenPositions: 100,
        maxConsecutiveLosses: 10,
        paperTradingEnabled: true,
      },
      update: {
        maxPositionRiskPercent: 10.0,
        maxTotalExposurePercent: 90.0,
        maxDailyLossPercent: 50.0,
        maxTradesPerDay: 1000,
        maxOpenPositions: 100,
        maxConsecutiveLosses: 10,
        paperTradingEnabled: true,
      },
    });
  });

  beforeEach(async () => {
    // Reset date mock
    jest.spyOn(Date, 'now').mockReturnValue(nowMs);
    currentTickerPrice = 24100.0;

    // Clean active positions
    await prisma.paperPosition.updateMany({
      where: {
        accountId: paperAccountId,
        status: { in: [PositionState.OPEN, PositionState.PARTIALLY_CLOSED, PositionState.EXIT_PENDING] },
      },
      data: { status: PositionState.CLOSED },
    });

    // Clean any prior NIFTY_SPOT bots for test isolation
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

  const createNiftyBot = async (overrides?: Partial<any>) => {
    const botId = `bot_nifty_decoupled_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    return prisma.algoBot.create({
      data: {
        id: botId,
        name: 'NIFTY Decoupled Lifecycle Bot',
        symbol: 'NIFTY_SPOT',
        executionInstrument: 'NIFTY',
        signalSourceInstrument: 'NIFTY_SPOT',
        direction: 'ANY',
        timeframe: '15m',
        minScore: 75,
        smcCondition: 'ORDER_BLOCK',
        lots: 100, // lotSize: 1, so 100 lots = 100 quantity
        autoExecutePaper: true,
        notifyWebhook: false,
        isActive: true,
        triggerCount: 0,
        ...overrides,
      },
    });
  };

  const createNiftyBearishSignal = (overrides?: Partial<ISignalSetup>): ISignalSetup => ({
    id: `sig_nifty_bear_${Date.now()}_${Math.random().toString(36).substring(7)}`,
    symbol: 'NIFTY_SPOT',
    timeframe: Timeframe.M15,
    direction: Direction.BEARISH,
    state: SignalState.ACTIVE,
    grade: SignalGrade.A_PLUS,
    score: 85,
    canonicalCandleTime: nowMs,
    canonicalDecisionTime: new Date(nowMs),
    entryZone: { min: 24090, max: 24110, optimal: 24100 },
    stopLoss: 24200,
    takeProfits: { tp1: 24000, tp2: 23900, tp3: 23800 },
    riskRewardRatios: { rr1: 1.0, rr2: 2.0, rr3: 3.0 },
    reasoning: {
      htfStructure: 'Bearish BOS',
      liquidityReason: 'Buyside liquidity swept',
      triggerReason: '15m Bearish Order Block tap',
      invalidationReason: 'Above 24200',
      confirmedChecklist: ['Order Block'],
      summary: 'Institutional Order Block short entry',
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

  const createNiftyBullishSignal = (overrides?: Partial<ISignalSetup>): ISignalSetup => ({
    id: `sig_nifty_bull_${Date.now()}_${Math.random().toString(36).substring(7)}`,
    symbol: 'NIFTY_SPOT',
    timeframe: Timeframe.M15,
    direction: Direction.BULLISH,
    state: SignalState.ACTIVE,
    grade: SignalGrade.A_PLUS,
    score: 90,
    canonicalCandleTime: nowMs + 900000, // 1 candle later (15 min)
    canonicalDecisionTime: new Date(nowMs + 900000),
    entryZone: { min: 24090, max: 24110, optimal: 24100 },
    stopLoss: 24000,
    takeProfits: { tp1: 24200, tp2: 24300, tp3: 24400 },
    riskRewardRatios: { rr1: 1.0, rr2: 2.0, rr3: 3.0 },
    reasoning: {
      htfStructure: 'Bullish BOS',
      liquidityReason: 'Sellside liquidity swept',
      triggerReason: '15m Bullish Order Block tap',
      invalidationReason: 'Below 24000',
      confirmedChecklist: ['Order Block'],
      summary: 'Institutional Order Block long entry',
    },
    scoreBreakdown: {
      htfBias: 20,
      liquiditySweep: 20,
      bos: 15,
      fvg: 15,
      orderBlock: 20,
      displacement: 0,
      volumeConfirmation: 0,
      premiumDiscount: 0,
      riskReward: 0,
      indicatorAlignment: 0,
      totalScore: 90,
      grade: SignalGrade.A_PLUS,
    },
    triggerEvidence: {
      orderBlock: { matched: true, timestamp: new Date(nowMs + 840000) },
    },
    timestamp: new Date(nowMs + 900000),
    ...overrides,
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Requirement 28: Active NIFTY bot executes valid BEARISH signal -> creates SELL position in PostgreSQL
  // ─────────────────────────────────────────────────────────────────────────────
  it('Requirement 28: Active NIFTY bot executes valid BEARISH signal -> creates SELL position in PostgreSQL', async () => {
    currentTickerPrice = 24100.0;
    const bot = await createNiftyBot();

    const bearishSignal = createNiftyBearishSignal();
    const results = await algoBotsService.evaluateSignalForBots(bearishSignal);

    expect(results).toHaveLength(1);
    const res = results[0];
    expect(res.botId).toBe(bot.id);
    expect(res.decision).toBe('TAKE');
    expect(res.status).toBe('EXECUTED');
    expect(res.lifecycleState).toBe(TradeLifecycleState.POSITION_OPENED);
    expect(res.orderPositionId).toBeDefined();

    // Verify in PostgreSQL
    const dbPos = await prisma.paperPosition.findUnique({
      where: { id: res.orderPositionId! },
    });
    expect(dbPos).toBeDefined();
    expect(dbPos!.symbol).toBe('NIFTY_SPOT');
    expect(dbPos!.direction).toBe(Direction.BEARISH); // SELL
    expect(dbPos!.status).toBe(PositionState.OPEN);
    expect(Number(dbPos!.quantity)).toBe(100);
    expect(Number(dbPos!.entryPrice)).toBeGreaterThan(24000);
    expect(Number(dbPos!.entryPrice)).toBeLessThan(24200);
    expect(Number(dbPos!.stopLoss)).toBe(24200.0);
    expect(Number(dbPos!.target1)).toBe(24000.0);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Requirement 29 & 30: New BULLISH signal arrives -> Decoupled Signal vs Position, No Reversal, Position Immutability
  // ─────────────────────────────────────────────────────────────────────────────
  it('Requirements 29 & 30: New BULLISH signal arrives -> active position direction remains SELL, no reversal, position levels immutable', async () => {
    currentTickerPrice = 24100.0;
    const bot = await createNiftyBot();

    // 1. Enter BEARISH trade
    const bearishSignal = createNiftyBearishSignal();
    const results1 = await algoBotsService.evaluateSignalForBots(bearishSignal);
    expect(results1[0].status).toBe('EXECUTED');
    const positionId = results1[0].orderPositionId!;

    const posBefore = await prisma.paperPosition.findUnique({ where: { id: positionId } });
    expect(posBefore!.direction).toBe(Direction.BEARISH);
    expect(posBefore!.status).toBe(PositionState.OPEN);

    // 2. New BULLISH signal arrives 15 minutes later
    jest.spyOn(Date, 'now').mockReturnValue(nowMs + 900000);
    const bullishSignal = createNiftyBullishSignal();

    const results2 = await algoBotsService.evaluateSignalForBots(bullishSignal);

    // Assert: Signal direction is BULLISH
    expect(bullishSignal.direction).toBe(Direction.BULLISH);

    // Assert: Execution rejected because position is already open (reversal strictly prevented)
    expect(results2).toHaveLength(1);
    expect(results2[0].decision).toBe('REJECT');
    expect(results2[0].status).toBe('REJECTED');
    expect(results2[0].reasonCode).toBe('POSITION_ALREADY_OPEN');

    // Assert: Database active position remains unchanged
    const posAfter = await prisma.paperPosition.findUnique({ where: { id: positionId } });
    expect(posAfter).toBeDefined();
    expect(posAfter!.id).toBe(positionId);
    expect(posAfter!.direction).toBe(Direction.BEARISH); // Direction remains SELL!
    expect(posAfter!.status).toBe(PositionState.OPEN);

    // Assert: Immutability of position fields
    expect(Number(posAfter!.entryPrice)).toBe(Number(posBefore!.entryPrice));
    expect(Number(posAfter!.stopLoss)).toBe(Number(posBefore!.stopLoss));
    expect(Number(posAfter!.target1)).toBe(Number(posBefore!.target1));
    expect(Number(posAfter!.target2)).toBe(Number(posBefore!.target2));
    expect(Number(posAfter!.quantity)).toBe(Number(posBefore!.quantity));

    // Assert: No new BUY position was created
    const allNiftyPositions = await prisma.paperPosition.findMany({
      where: {
        accountId: paperAccountId,
        symbol: 'NIFTY_SPOT',
        status: { in: [PositionState.OPEN, PositionState.PARTIALLY_CLOSED] },
      },
    });
    expect(allNiftyPositions).toHaveLength(1);
    expect(allNiftyPositions[0].direction).toBe(Direction.BEARISH);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Requirement 31: TP1 Execution (30% scale-out, breakeven SL for remaining 70%)
  // ─────────────────────────────────────────────────────────────────────────────
  it('Requirement 31: Price reaches TP1: exactly 30% scales out, SL moves to breakeven, 70% quantity remains', async () => {
    currentTickerPrice = 24100.0;
    const bot = await createNiftyBot();

    const bearishSignal = createNiftyBearishSignal();
    const results = await algoBotsService.evaluateSignalForBots(bearishSignal);
    const positionId = results[0].orderPositionId!;
    const tradeDecisionId = results[0].tradeDecisionId!;

    // Bearish TP1 is 24000. Price drops to 23995 (crossing TP1 downward)
    currentTickerPrice = 23995.0;
    const dbPosBefore = await prisma.paperPosition.findUnique({ where: { id: positionId } });
    await monitorService.evaluateSinglePosition(dbPosBefore);

    const dbPosAfter = await prisma.paperPosition.findUnique({ where: { id: positionId } });
    expect(dbPosAfter!.status).toBe(PositionState.PARTIALLY_CLOSED);
    expect(Number(dbPosAfter!.quantity)).toBe(70); // 100 initial - 30% (30 qty) = 70 qty remaining
    expect(Number(dbPosAfter!.stopLoss)).toBe(Number(dbPosAfter!.entryPrice)); // Moved to breakeven (entryPrice)

    const events = dbPosAfter!.executionEventsJson as any;
    expect(events.partialLegs).toHaveLength(1);
    expect(events.partialLegs[0].role).toBe('TP1_PARTIAL');
    expect(events.partialLegs[0].quantity).toBe(30);
    expect(events.tp1FillPrice).toBe(23995.0);

    const updatedDecision = await prisma.tradeDecision.findUnique({
      where: { id: tradeDecisionId },
    });
    expect(updatedDecision?.lifecycleState).toBe(TradeLifecycleState.TP1_PARTIAL_FILLED);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Requirement 32: TP2 Bypass Prevention (TP1 must execute before TP2)
  // ─────────────────────────────────────────────────────────────────────────────
  it('Requirement 32: Price gaps directly past TP2: TP1 executes first (30%), TP2 does not bypass TP1', async () => {
    currentTickerPrice = 24100.0;
    const bot = await createNiftyBot();

    const bearishSignal = createNiftyBearishSignal();
    const results = await algoBotsService.evaluateSignalForBots(bearishSignal);
    const positionId = results[0].orderPositionId!;

    // Bearish TP1 is 24000, TP2 is 23900. Price gaps straight to 23880 in one tick
    currentTickerPrice = 23880.0;
    const dbPos = await prisma.paperPosition.findUnique({ where: { id: positionId } });
    await monitorService.evaluateSinglePosition(dbPos);

    const updatedPos = await prisma.paperPosition.findUnique({ where: { id: positionId } });
    const events = updatedPos!.executionEventsJson as any;

    // Must have executed TP1 first!
    expect(events.tp1FillTime).toBeDefined();
    const tp1Leg = events.partialLegs.find((l: any) => l.role === 'TP1_PARTIAL');
    expect(tp1Leg).toBeDefined();
    expect(tp1Leg.quantity).toBe(30);

    // Sequential cascade also evaluated TP2 (30%)
    const tp2Leg = events.partialLegs.find((l: any) => l.role === 'TP2_PARTIAL');
    expect(tp2Leg).toBeDefined();
    expect(tp2Leg.quantity).toBe(30);
    expect(Number(updatedPos!.quantity)).toBe(40); // 100 - 30 - 30 = 40 remaining
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Requirement 33: SL after TP1 closes only remaining 70% quantity
  // ─────────────────────────────────────────────────────────────────────────────
  it('Requirement 33: Price hits breakeven SL after TP1: only remaining 70% quantity closes at breakeven', async () => {
    currentTickerPrice = 24100.0;
    const bot = await createNiftyBot();

    const bearishSignal = createNiftyBearishSignal();
    const results = await algoBotsService.evaluateSignalForBots(bearishSignal);
    const positionId = results[0].orderPositionId!;

    // Step 1: Hit TP1 at 24000 (closes 30%, remaining is 70%, SL moved to 24100)
    currentTickerPrice = 24000.0;
    let dbPos = await prisma.paperPosition.findUnique({ where: { id: positionId } });
    await monitorService.evaluateSinglePosition(dbPos);

    // Step 2: Price rises back up through breakeven SL (24100) to 24120
    currentTickerPrice = 24120.0;
    dbPos = await prisma.paperPosition.findUnique({ where: { id: positionId } });
    await monitorService.evaluateSinglePosition(dbPos);

    const closedPos = await prisma.paperPosition.findUnique({ where: { id: positionId } });
    expect(closedPos!.status).toBe(PositionState.CLOSED);

    // Exactly 1 PaperTrade recorded aggregating the full lifecycle
    const trades = await prisma.paperTrade.findMany({ where: { positionId } });
    expect(trades).toHaveLength(1);
    expect(trades[0].exitReason).toBe('Breakeven Stop Loss Hit');

    const outcome = trades[0].outcomeSnapshotJson as any;
    const tp1Leg = outcome.legs.find((l: any) => l.role === 'TP1_PARTIAL');
    expect(tp1Leg).toBeDefined();
    expect(tp1Leg.quantity).toBe(30);

    const finalLeg = outcome.legs.find((l: any) => l.role === 'FINAL_EXIT');
    expect(finalLeg).toBeDefined();
    expect(finalLeg.quantity).toBe(70); // Closed remaining 70%
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Requirement 34: Concurrent TP1 calls result in exactly 1 TP1 execution leg
  // ─────────────────────────────────────────────────────────────────────────────
  it('Requirement 34: Concurrent TP1 calls result in exactly 1 TP1 execution leg via CAS + idempotency key', async () => {
    currentTickerPrice = 24100.0;
    const bot = await createNiftyBot();

    const bearishSignal = createNiftyBearishSignal();
    const results = await algoBotsService.evaluateSignalForBots(bearishSignal);
    const positionId = results[0].orderPositionId!;

    // Price hits TP1
    currentTickerPrice = 23995.0;
    const dbPos = await prisma.paperPosition.findUnique({ where: { id: positionId } });

    // Fire 2 concurrent monitor evaluations
    await Promise.all([
      monitorService.evaluateSinglePosition(dbPos),
      monitorService.evaluateSinglePosition(dbPos),
    ]);

    // Verify exactly 1 TP1 order created
    const tp1Orders = await prisma.paperOrder.findMany({
      where: {
        OR: [
          { idempotencyKey: `tp1_partial:${positionId}` },
          { idempotencyKey: `tp1_partial_${positionId}` },
        ],
      },
    });
    expect(tp1Orders).toHaveLength(1);

    const updatedPos = await prisma.paperPosition.findUnique({ where: { id: positionId } });
    expect(Number(updatedPos!.quantity)).toBe(70); // Remaining is 70, not reduced twice
    const events = updatedPos!.executionEventsJson as any;
    expect(events.partialLegs).toHaveLength(1);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Requirement 35: Final PaperTrade Aggregation (1 PaperTrade for full lifecycle)
  // ─────────────────────────────────────────────────────────────────────────────
  it('Requirement 35: Full TP1 -> TP2 -> TP3 cascade records exactly 1 PaperTrade for the full lifecycle', async () => {
    currentTickerPrice = 24100.0;
    const bot = await createNiftyBot();

    const bearishSignal = createNiftyBearishSignal();
    const results = await algoBotsService.evaluateSignalForBots(bearishSignal);
    const positionId = results[0].orderPositionId!;
    const tradeDecisionId = results[0].tradeDecisionId!;

    // Tick 1: TP1 (24000)
    currentTickerPrice = 24000.0;
    let dbPos = await prisma.paperPosition.findUnique({ where: { id: positionId } });
    await monitorService.evaluateSinglePosition(dbPos);

    // Tick 2: TP2 (23900)
    currentTickerPrice = 23900.0;
    dbPos = await prisma.paperPosition.findUnique({ where: { id: positionId } });
    await monitorService.evaluateSinglePosition(dbPos);

    // Tick 3: TP3 (23800)
    currentTickerPrice = 23790.0;
    dbPos = await prisma.paperPosition.findUnique({ where: { id: positionId } });
    await monitorService.evaluateSinglePosition(dbPos);

    // Position is closed
    const closedPos = await prisma.paperPosition.findUnique({ where: { id: positionId } });
    expect(closedPos!.status).toBe(PositionState.CLOSED);

    // Exactly 1 aggregated PaperTrade record
    const trades = await prisma.paperTrade.findMany({ where: { positionId } });
    expect(trades).toHaveLength(1);
    expect(Number(trades[0].quantity)).toBe(100);
    expect(trades[0].exitReason).toBe('Target 3 Completed');

    const finalDecision = await prisma.tradeDecision.findUnique({
      where: { id: tradeDecisionId },
    });
    expect(finalDecision?.lifecycleState).toBe(TradeLifecycleState.TRADE_CLOSED);
  });
});
