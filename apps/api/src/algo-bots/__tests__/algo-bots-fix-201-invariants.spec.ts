import { PrismaClient } from '@prisma/client';
import { AlgoBotsService } from '../algo-bots.service';
import { TradeDecisionService } from '../trade-decision.service';
import { PaperTradingService } from '../../paper-trading/paper-trading.service';
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
  TradeDecisionType,
  PointInTimeCurrencyConverter,
} from '@quant/shared';

describe('Fix 201 Invariant Suite: Algo Bot Execution Authority & NIFTY Lifecycle', () => {
  let prisma: PrismaClient;
  let algoBotsService: AlgoBotsService;
  let tradeDecisionService: TradeDecisionService;
  let paperTradingService: PaperTradingService;
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

    tradeDecisionService = new TradeDecisionService(prismaService);

    algoBotsService = new AlgoBotsService(
      paperTradingService,
      mockAlertsService as unknown as AlertsService,
      prismaService,
      null as any,
      tradeDecisionService,
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
    jest.spyOn(Date, 'now').mockReturnValue(nowMs);
    currentTickerPrice = 24100.0;

    await prisma.paperPosition.updateMany({
      where: {
        accountId: paperAccountId,
        status: { in: [PositionState.OPEN, PositionState.PARTIALLY_CLOSED, PositionState.EXIT_PENDING] },
      },
      data: { status: PositionState.CLOSED },
    });

    await prisma.algoBot.deleteMany({
      where: {
        OR: [
          { name: { contains: 'Fix 201' } },
          { name: { contains: 'NIFTY Decoupled' } },
        ],
      },
    });
  });

  afterAll(async () => {
    delete process.env.PAPER_TRADING_ENABLED;
    delete process.env.ENABLE_PAPER_ALGO_BOTS;
    if (prisma) {
      await prisma.$disconnect();
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Invariant 1: One Reservation Authority (TradeDecisionService)
  // ─────────────────────────────────────────────────────────────────────────────
  it('Invariant 1: TradeDecisionService is the sole canonical reservation authority; AlgoBotsService delegates cleanly', async () => {
    const botId = `bot_fix201_auth_${Math.random().toString(36).substring(2, 9)}`;
    const bot = await prisma.algoBot.create({
      data: {
        id: botId,
        name: 'Fix 201 Auth Bot',
        symbol: 'BTCUSDT',
        direction: 'BULLISH',
        timeframe: '15m',
        minScore: 70,
        smcCondition: 'ORDER_BLOCK',
        lots: 1,
        autoExecutePaper: true,
        notifyWebhook: false,
        isActive: true,
        triggerCount: 0,
      },
    });

    const signal: ISignalSetup = {
      id: `sig_fix201_auth_${Math.random().toString(36).substring(2, 9)}`,
      symbol: 'BTCUSDT',
      timeframe: Timeframe.M15,
      direction: Direction.BULLISH,
      state: SignalState.ACTIVE,
      grade: SignalGrade.A_PLUS,
      score: 85,
      canonicalCandleTime: nowMs,
      canonicalDecisionTime: new Date(nowMs),
      entryZone: { min: 64000, max: 64200, optimal: 64100 },
      stopLoss: 63800,
      takeProfits: { tp1: 64500, tp2: 64800, tp3: 65200 },
      riskRewardRatios: { rr1: 1.5, rr2: 2.5, rr3: 4.0 },
      reasoning: {
        htfStructure: 'Bullish',
        liquidityReason: 'Swept',
        triggerReason: 'OB Tap',
        invalidationReason: 'Below 63800',
        confirmedChecklist: ['Order Block'],
        summary: 'Bullish OB',
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
    };

    const fingerprint = tradeDecisionService.getTradeFingerprint(bot as any, signal, paperAccountId);

    // Delegate through algoBotsService.reserveExecutionLock
    const res = await algoBotsService.reserveExecutionLock(bot as any, signal, fingerprint, paperAccountId);
    expect(res.success).toBe(true);
    expect(res.executionId).toBeDefined();

    // Verify persisted TradeDecision in PostgreSQL
    const decision = await prisma.tradeDecision.findUnique({
      where: { fingerprint },
    });
    expect(decision).toBeDefined();
    expect(decision!.lifecycleState).toBe(TradeLifecycleState.RESERVATION_CREATED);
    expect(decision!.tradeTakenTime).toBeDefined();
    expect(decision!.reservationTime).toBeDefined();
    expect(decision!.executionId).toBe(res.executionId);

    // Verify duplicate reservation rejection
    const dupRes = await algoBotsService.reserveExecutionLock(bot as any, signal, fingerprint, paperAccountId);
    expect(dupRes.success).toBe(false);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Invariant 2: Fail-Closed Expected-State CAS across Lifecycle Transitions
  // ─────────────────────────────────────────────────────────────────────────────
  it('Invariant 2: Expected-State CAS enforces valid transition graph and fails closed on invalid state or count = 0', async () => {
    const botId = `bot_fix201_cas_${Math.random().toString(36).substring(2, 9)}`;
    const bot = await prisma.algoBot.create({
      data: {
        id: botId,
        name: 'Fix 201 CAS Bot',
        symbol: 'BTCUSDT',
        direction: 'BULLISH',
        timeframe: '15m',
        minScore: 70,
        smcCondition: 'ORDER_BLOCK',
        lots: 1,
        autoExecutePaper: true,
        notifyWebhook: false,
        isActive: true,
        triggerCount: 0,
      },
    });

    const signal: ISignalSetup = {
      id: `sig_fix201_cas_${Math.random().toString(36).substring(2, 9)}`,
      symbol: 'BTCUSDT',
      timeframe: Timeframe.M15,
      direction: Direction.BULLISH,
      state: SignalState.ACTIVE,
      grade: SignalGrade.A_PLUS,
      score: 85,
      canonicalCandleTime: nowMs,
      canonicalDecisionTime: new Date(nowMs),
      entryZone: { min: 64000, max: 64200, optimal: 64100 },
      stopLoss: 63800,
      takeProfits: { tp1: 64500, tp2: 64800, tp3: 65200 },
      riskRewardRatios: { rr1: 1.5, rr2: 2.5, rr3: 4.0 },
      reasoning: {
        htfStructure: 'Bullish',
        liquidityReason: 'Swept',
        triggerReason: 'OB Tap',
        invalidationReason: 'Below 63800',
        confirmedChecklist: ['Order Block'],
        summary: 'Bullish OB',
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
    };

    const fingerprint = tradeDecisionService.getTradeFingerprint(bot as any, signal, paperAccountId);
    await algoBotsService.reserveExecutionLock(bot as any, signal, fingerprint, paperAccountId);
    const decision = await prisma.tradeDecision.findUnique({ where: { fingerprint } });
    const decisionId = decision!.id;

    // 1. Valid CAS transition: RESERVATION_CREATED -> ORDER_SUBMITTED
    await tradeDecisionService.updateTradeLifecycleState(
      decisionId,
      TradeLifecycleState.ORDER_SUBMITTED,
      { orderSubmittedTime: new Date() },
      TradeLifecycleState.RESERVATION_CREATED,
    );

    // 2. Illegal transition: Prohibited edge (ORDER_SUBMITTED -> TRADE_CLOSED) throws [INVALID_LIFECYCLE_TRANSITION]
    await expect(
      tradeDecisionService.updateTradeLifecycleState(
        decisionId,
        TradeLifecycleState.TRADE_CLOSED,
        {},
        TradeLifecycleState.ORDER_SUBMITTED,
      ),
    ).rejects.toThrow('[INVALID_LIFECYCLE_TRANSITION]');

    // 3. Stale CAS expectation: expectedCurrentState mismatch throws [LIFECYCLE_TRANSITION_FAILED]
    await expect(
      tradeDecisionService.updateTradeLifecycleState(
        decisionId,
        TradeLifecycleState.ORDER_FILLED,
        { fillTime: new Date() },
        TradeLifecycleState.ORDER_PARTIALLY_FILLED, // Valid edge to ORDER_FILLED, but DB state is ORDER_SUBMITTED!
      ),
    ).rejects.toThrow('[LIFECYCLE_TRANSITION_FAILED]');

    // 4. Correct CAS transition: ORDER_SUBMITTED -> ORDER_FILLED -> POSITION_OPENED
    await tradeDecisionService.updateTradeLifecycleState(
      decisionId,
      TradeLifecycleState.ORDER_FILLED,
      { fillTime: new Date() },
      TradeLifecycleState.ORDER_SUBMITTED,
    );

    await tradeDecisionService.updateTradeLifecycleState(
      decisionId,
      TradeLifecycleState.POSITION_OPENED,
      {},
      TradeLifecycleState.ORDER_FILLED,
    );

    const finalDecision = await prisma.tradeDecision.findUnique({ where: { id: decisionId } });
    expect(finalDecision?.lifecycleState).toBe(TradeLifecycleState.POSITION_OPENED);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Invariant 3: Spot Short Protection (NIFTY_SPOT, BANKNIFTY_SPOT, BTCUSDT_SPOT)
  // ─────────────────────────────────────────────────────────────────────────────
  it('Invariant 3: Spot short selling is strictly forbidden on NIFTY_SPOT, BANKNIFTY_SPOT, BTCUSDT_SPOT; explicit derivative NIFTY allows shorting', async () => {
    // 1. Direct placeOrder rejection for spot symbols
    await expect(
      paperTradingService.placeOrder({
        symbol: 'NIFTY_SPOT',
        direction: 'SELL',
        orderType: 'MARKET',
        quantity: 10,
        price: 24100,
        stopLoss: 24200,
        target1: 24000,
        allowPriceOverride: true,
        executionMode: 'TEST' as any,
      }),
    ).rejects.toThrow('SPOT_SHORT_SELLING_FORBIDDEN');

    await expect(
      paperTradingService.placeOrder({
        symbol: 'BANKNIFTY_SPOT',
        direction: 'SELL',
        orderType: 'MARKET',
        quantity: 10,
        price: 51200,
        stopLoss: 51500,
        target1: 50800,
        allowPriceOverride: true,
        executionMode: 'TEST' as any,
      }),
    ).rejects.toThrow('SPOT_SHORT_SELLING_FORBIDDEN');

    await expect(
      paperTradingService.placeOrder({
        symbol: 'BTCUSDT_SPOT',
        direction: 'SELL',
        orderType: 'MARKET',
        quantity: 0.1,
        price: 64000,
        stopLoss: 64500,
        target1: 63000,
        allowPriceOverride: true,
        executionMode: 'TEST' as any,
      }),
    ).rejects.toThrow('SPOT_SHORT_SELLING_FORBIDDEN');

    // 2. Pre-trade gate rejection for spot shorting
    const spotBot = {
      id: 'bot_spot_test',
      symbol: 'NIFTY_SPOT',
      lots: 1,
      isActive: true,
      autoExecutePaper: true,
      minScore: 70,
      direction: 'ANY',
      timeframe: '15m',
      smcCondition: 'ORDER_BLOCK',
    } as any;

    const shortSignal: ISignalSetup = {
      id: 'sig_spot_short',
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
      reasoning: { summary: 'Short' } as any,
      scoreBreakdown: { totalScore: 85 } as any,
      triggerEvidence: {
        orderBlock: { matched: true, timestamp: new Date(nowMs - 60000) },
      },
      timestamp: new Date(nowMs),
    };

    const gateResult = tradeDecisionService.evaluatePreTradeDecision({
      bot: spotBot,
      signal: shortSignal,
      portfolio: { accountId: paperAccountId, cashBalance: 1000000, activePositionsCount: 0, openPositionsCount: 0 } as any,
      liveQuote: { symbol: 'NIFTY_SPOT', price: 24100, timestamp: new Date() } as any,
    });
    expect(gateResult.decision).toBe(TradeDecisionType.REJECT);
    expect(gateResult.decisionReasonCode).toBe('SPOT_SHORT_SELLING_FORBIDDEN');

    // 3. Explicit derivative NIFTY allows shorting
    const derivPos = await paperTradingService.placeOrder({
      symbol: 'NIFTY',
      direction: 'SELL',
      orderType: 'MARKET',
      quantity: 65,
      price: 24100,
      stopLoss: 24200,
      target1: 24000,
      allowPriceOverride: true,
      executionMode: 'TEST' as any,
    });
    expect(derivPos).toBeDefined();
    expect(derivPos.direction).toBe('SELL');
    expect(derivPos.symbol).toBe('NIFTY');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Invariant 4: Instrument Identity Distinction (NIFTY != NIFTY_SPOT)
  // ─────────────────────────────────────────────────────────────────────────────
  it('Invariant 4: Instrument identity is strictly distinguished across signalSourceInstrument and executionInstrument', async () => {
    // Delete any existing NIFTY_SPOT bots for clean isolation
    await prisma.algoBot.deleteMany({
      where: { symbol: 'NIFTY_SPOT' },
    });

    const botId = `bot_fix201_decoupled_${Math.random().toString(36).substring(2, 9)}`;
    await prisma.algoBot.create({
      data: {
        id: botId,
        name: 'Fix 201 NIFTY Decoupled Bot',
        symbol: 'NIFTY_SPOT',
        executionInstrument: 'NIFTY',
        signalSourceInstrument: 'NIFTY_SPOT',
        direction: 'ANY',
        timeframe: '15m',
        minScore: 75,
        smcCondition: 'ORDER_BLOCK',
        lots: 1,
        autoExecutePaper: true,
        notifyWebhook: false,
        isActive: true,
        triggerCount: 0,
      },
    });

    const shortSignal: ISignalSetup = {
      id: `sig_fix201_nifty_${Math.random().toString(36).substring(2, 9)}`,
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
        liquidityReason: 'Swept',
        triggerReason: 'OB Tap',
        invalidationReason: 'Above 24200',
        confirmedChecklist: ['Order Block'],
        summary: 'Bearish OB',
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
    };

    const results = await algoBotsService.evaluateSignalForBots(shortSignal);
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('EXECUTED');
    expect(results[0].decision).toBe('TAKE');

    // Verify PostgreSQL records have separate executionInstrument and signalSourceInstrument
    const dbDecision = await prisma.tradeDecision.findUnique({
      where: { id: results[0].tradeDecisionId! },
    });
    expect(dbDecision).toBeDefined();
    expect(dbDecision!.executionInstrument).toBe('NIFTY');
    expect(dbDecision!.signalSourceInstrument).toBe('NIFTY_SPOT');

    const dbExecution = await prisma.algoBotExecution.findUnique({
      where: { id: results[0].executionId! },
    });
    expect(dbExecution).toBeDefined();
    expect(dbExecution!.executionInstrument).toBe('NIFTY');

    const dbPosition = await prisma.paperPosition.findUnique({
      where: { id: results[0].orderPositionId! },
    });
    expect(dbPosition).toBeDefined();
    expect(dbPosition!.executionInstrument).toBe('NIFTY');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Invariant 5: Fail Closed on Missing Authoritative Account Identity
  // ─────────────────────────────────────────────────────────────────────────────
  it('Invariant 5: evaluateSignalForBots fails closed with ACCOUNT_ID_REQUIRED if accountId cannot be authoritatively resolved', async () => {
    const bot = {
      id: 'bot_no_acc',
      symbol: 'BTCUSDT',
      direction: 'ANY',
      timeframe: '15m',
      minScore: 70,
      smcCondition: 'ORDER_BLOCK',
      lots: 1,
      autoExecutePaper: true,
      notifyWebhook: false,
      isActive: true,
    } as any;

    const signal: ISignalSetup = {
      id: 'sig_no_acc',
      symbol: 'BTCUSDT',
      timeframe: Timeframe.M15,
      direction: Direction.BULLISH,
      state: SignalState.ACTIVE,
      grade: SignalGrade.A_PLUS,
      score: 85,
      canonicalCandleTime: nowMs,
      canonicalDecisionTime: new Date(nowMs),
      entryZone: { min: 64000, max: 64200, optimal: 64100 },
      stopLoss: 63800,
      takeProfits: { tp1: 64500, tp2: 64800, tp3: 65200 },
      riskRewardRatios: { rr1: 1.5, rr2: 2.5, rr3: 4.0 },
      reasoning: { summary: 'OB' } as any,
      scoreBreakdown: { totalScore: 85 } as any,
      triggerEvidence: {},
      timestamp: new Date(nowMs),
    };

    // Spy on getPortfolio to return empty accountId
    jest.spyOn(paperTradingService, 'getPortfolio').mockResolvedValueOnce({
      accountId: '',
    } as any);
    jest.spyOn(algoBotsService, 'listBots').mockResolvedValueOnce([bot]);

    const results = await algoBotsService.evaluateSignalForBots(signal);
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('REJECTED');
    expect(results[0].reasonCode).toBe('ACCOUNT_ID_REQUIRED');
  });
});
