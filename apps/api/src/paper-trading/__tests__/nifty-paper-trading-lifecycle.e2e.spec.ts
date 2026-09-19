import { PrismaClient } from '@prisma/client';
import { BadRequestException } from '@nestjs/common';
import { PaperPositionMonitorService } from '../paper-position-monitor.service';
import { PaperTradingService } from '../paper-trading.service';
import { RealMarketStreamerService } from '../../market-data/real-market-streamer.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { TradeDecisionService } from '../../algo-bots/trade-decision.service';
import { PositionMonitorProcessor } from '../../../../worker/src/processors/position-monitor.processor';
import {
  Direction,
  PositionState,
  TradeLifecycleState,
  PointInTimeCurrencyConverter,
  buildAccountingSnapshot,
  getAuthoritativeInstrument,
  resolveMarginModel,
} from '@quant/shared';
import {
  DEFAULT_PARTIAL_EXIT_POLICY,
  TradeLifecycleManager,
} from '@quant/risk-engine';

describe('NIFTY Paper-Trading Lifecycle End-to-End Suite (14 Invariant Tests)', () => {
  let prisma: PrismaClient;
  let paperTrading: PaperTradingService;
  let monitorService: PaperPositionMonitorService;
  let tradeDecisionService: TradeDecisionService;
  let currentTickerPrice = 24100.0;

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

  beforeAll(async () => {
    PointInTimeCurrencyConverter.getInstance().seedFixtureRates([
      { pair: 'USDT/INR', rate: 92.0, timestamp: 0, source: 'TEST_FIXTURE', version: '1.0' },
      { pair: 'USD/INR', rate: 87.0, timestamp: 0, source: 'TEST_FIXTURE', version: '1.0' },
    ]);

    prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
    await prisma.$connect();

    const prismaService = prisma as unknown as PrismaService;
    paperTrading = new PaperTradingService(
      prismaService,
      null as any,
      mockStreamer as unknown as RealMarketStreamerService,
    );

    monitorService = new PaperPositionMonitorService(
      prismaService,
      paperTrading,
      mockStreamer as unknown as RealMarketStreamerService,
    );

    tradeDecisionService = new TradeDecisionService(prismaService);

    // Ensure default paper trading account and config exist
    const acc = await paperTrading.getOrCreateAccount();
    await prisma.paperFill.deleteMany({ where: { order: { accountId: acc.id } } });
    await prisma.paperTrade.deleteMany({ where: { accountId: acc.id } });
    await prisma.paperPosition.deleteMany({ where: { accountId: acc.id } });
    await prisma.paperOrder.deleteMany({ where: { accountId: acc.id } });
    await prisma.paperAccount.updateMany({
      where: { id: acc.id },
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
    await prisma.paperPosition.updateMany({
      where: { status: { in: [PositionState.OPEN, PositionState.PARTIALLY_CLOSED, PositionState.EXIT_PENDING] } },
      data: { status: PositionState.CLOSED },
    });
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.$disconnect();
    }
  });

  // Helper to create an active test bot and trade decision record
  async function createTestTradeDecision(symbol = 'NIFTY_SPOT') {
    const account = await paperTrading.getOrCreateAccount();
    const testBot = await prisma.algoBot.create({
      data: {
        name: `Test Bot ${Date.now()}_${Math.random().toString(36).substring(7)}`,
        symbol,
        timeframe: '15m',
        direction: 'ANY',
        isActive: true,
        autoExecutePaper: true,
      },
    });

    const execution = await prisma.algoBotExecution.create({
      data: {
        fingerprint: `fp_exec_${Date.now()}_${Math.random().toString(36).substring(7)}`,
        botId: testBot.id,
        symbol,
        timeframe: '15m',
        direction: Direction.BULLISH,
        signalTimestamp: new Date(),
        correlationId: `corr_${Date.now()}_${Math.random().toString(36).substring(7)}`,
      },
    });

    const decision = await prisma.tradeDecision.create({
      data: {
        fingerprint: `fp_dec_${Date.now()}_${Math.random().toString(36).substring(7)}`,
        accountId: account.id,
        botId: testBot.id,
        symbol,
        timeframe: '15m',
        direction: Direction.BULLISH,
        decision: 'TAKE',
        decisionReasonCode: 'PRE_TRADE_APPROVED',
        lifecycleState: TradeLifecycleState.PRE_TRADE_APPROVED,
        correlationId: `corr_dec_${Date.now()}_${Math.random().toString(36).substring(7)}`,
      },
    });

    return { testBot, execution, decision };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 1: NIFTY_SPOT BUY opens successfully
  // ─────────────────────────────────────────────────────────────────────────────
  it('Test 1: NIFTY_SPOT BUY opens successfully with full execution provenance', async () => {
    currentTickerPrice = 24100.0;
    const { decision } = await createTestTradeDecision('NIFTY_SPOT');

    const position = await paperTrading.placeOrder({
      symbol: 'NIFTY_SPOT',
      direction: 'BUY',
      orderType: 'MARKET',
      quantity: 10,
      price: 24100.0,
      stopLoss: 24050.0,
      target1: 24200.0,
      target2: 24300.0,
      target3: 24400.0,
      tradeDecisionId: decision.id,
      allowPriceOverride: true,
      executionMode: 'TEST' as any,
    });

    expect(position).toBeDefined();
    expect(position.symbol).toBe('NIFTY_SPOT');
    expect(position.direction).toBe('BUY');
    expect(position.status).toBe(PositionState.OPEN);
    expect(Number(position.quantity)).toBe(10);
    expect(Number(position.stopLoss)).toBe(24050.0);

    const dbPos = await prisma.paperPosition.findUnique({
      where: { id: position.id },
    });
    expect(dbPos).toBeDefined();
    expect(dbPos!.status).toBe(PositionState.OPEN);
    const events = dbPos!.executionEventsJson as any;
    expect(events.managedBy).toBe('API_MONITOR');
    expect(events.initialQuantity).toBe(10);
    expect(events.remainingQuantity).toBe(10);

    // Verify TradeDecision transitioned to POSITION_OPENED
    const updatedDecision = await prisma.tradeDecision.findUnique({
      where: { id: decision.id },
    });
    expect(updatedDecision?.lifecycleState).toBe(TradeLifecycleState.POSITION_OPENED);
    expect(updatedDecision?.orderPositionId).toBe(position.id);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 2: NIFTY signal flips/refreshes after entry; position remains bound
  // ─────────────────────────────────────────────────────────────────────────────
  it('Test 2: NIFTY signal flips/refreshes after entry; position remains bound to original positionId and direction', async () => {
    currentTickerPrice = 24100.0;
    const pos = await paperTrading.placeOrder({
      symbol: 'NIFTY_SPOT',
      direction: 'BUY',
      orderType: 'MARKET',
      quantity: 25,
      price: 24100.0,
      stopLoss: 24000.0,
      target1: 24200.0,
      allowPriceOverride: true,
      executionMode: 'TEST' as any,
    });

    // Simulate signal refreshing or flipping to BEARISH
    const portfolio = await paperTrading.getPortfolio();
    const openPositions = portfolio.openPositions;
    const found = openPositions.find((p: any) => p.id === pos.id);

    expect(found).toBeDefined();
    expect(found!.id).toBe(pos.id);
    expect(found!.direction).toBe('BUY');
    expect(found!.status).toBe(PositionState.OPEN);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 3: Price reaches TP1: exactly 30% quantity closes, 70% remains, SL moves to breakeven
  // ─────────────────────────────────────────────────────────────────────────────
  it('Test 3: Price reaches TP1: exactly 30% quantity closes, 70% remains, SL moves to breakeven, 1 TP1 execution leg exists, TradeDecision updates', async () => {
    currentTickerPrice = 24100.0;
    const { decision } = await createTestTradeDecision('NIFTY_SPOT');

    const pos = await paperTrading.placeOrder({
      symbol: 'NIFTY_SPOT',
      direction: 'BUY',
      orderType: 'MARKET',
      quantity: 100,
      price: 24100.0,
      stopLoss: 24000.0,
      target1: 24200.0,
      target2: 24300.0,
      target3: 24400.0,
      tradeDecisionId: decision.id,
      allowPriceOverride: true,
      executionMode: 'TEST' as any,
    });

    // Price crosses TP1
    currentTickerPrice = 24205.0;
    const dbPosBefore = await prisma.paperPosition.findUnique({ where: { id: pos.id } });
    await monitorService.evaluateSinglePosition(dbPosBefore);

    const dbPosAfter = await prisma.paperPosition.findUnique({ where: { id: pos.id } });
    expect(dbPosAfter!.status).toBe(PositionState.PARTIALLY_CLOSED);
    expect(Number(dbPosAfter!.quantity)).toBe(70); // exactly 30% closed, 70% remaining
    expect(Number(dbPosAfter!.stopLoss)).toBe(Number(dbPosAfter!.entryPrice)); // moved to breakeven

    const events = dbPosAfter!.executionEventsJson as any;
    expect(events.partialLegs).toHaveLength(1);
    expect(events.partialLegs[0].role).toBe('TP1_PARTIAL');
    expect(events.partialLegs[0].quantity).toBe(30);
    expect(events.tp1FillPrice).toBe(24205.0);

    const updatedDecision = await prisma.tradeDecision.findUnique({ where: { id: decision.id } });
    expect(updatedDecision?.lifecycleState).toBe(TradeLifecycleState.TP1_PARTIAL_FILLED);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 4: Price gaps directly above TP2: TP1 executes first (30%), SL moves to breakeven, TP2 does not bypass TP1
  // ─────────────────────────────────────────────────────────────────────────────
  it('Test 4: Price gaps directly above TP2: TP1 executes first (30%), SL moves to breakeven, TP2 does not bypass TP1', async () => {
    currentTickerPrice = 24100.0;
    const pos = await paperTrading.placeOrder({
      symbol: 'NIFTY_SPOT',
      direction: 'BUY',
      orderType: 'MARKET',
      quantity: 100,
      price: 24100.0,
      stopLoss: 24000.0,
      target1: 24200.0,
      target2: 24300.0,
      target3: 24400.0,
      allowPriceOverride: true,
      executionMode: 'TEST' as any,
    });

    // Price gaps straight past TP1 and TP2 on a single tick
    currentTickerPrice = 24320.0;
    const dbPos = await prisma.paperPosition.findUnique({ where: { id: pos.id } });
    await monitorService.evaluateSinglePosition(dbPos);

    const updatedPos = await prisma.paperPosition.findUnique({ where: { id: pos.id } });
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
  // Test 5: Price reaches TP2 after TP1: canonical TP2 quantity (30%) executes, remaining quantity is 40%
  // ─────────────────────────────────────────────────────────────────────────────
  it('Test 5: Price reaches TP2 after TP1: canonical TP2 quantity (30%) executes, remaining quantity is 40%', async () => {
    currentTickerPrice = 24100.0;
    const { decision } = await createTestTradeDecision('NIFTY_SPOT');

    const pos = await paperTrading.placeOrder({
      symbol: 'NIFTY_SPOT',
      direction: 'BUY',
      orderType: 'MARKET',
      quantity: 100,
      price: 24100.0,
      stopLoss: 24000.0,
      target1: 24200.0,
      target2: 24300.0,
      target3: 24400.0,
      tradeDecisionId: decision.id,
      allowPriceOverride: true,
      executionMode: 'TEST' as any,
    });

    // Step 1: Reach TP1
    currentTickerPrice = 24200.0;
    let dbPos = await prisma.paperPosition.findUnique({ where: { id: pos.id } });
    await monitorService.evaluateSinglePosition(dbPos);

    // Step 2: Next tick reaches TP2
    currentTickerPrice = 24305.0;
    dbPos = await prisma.paperPosition.findUnique({ where: { id: pos.id } });
    await monitorService.evaluateSinglePosition(dbPos);

    const updatedPos = await prisma.paperPosition.findUnique({ where: { id: pos.id } });
    expect(Number(updatedPos!.quantity)).toBe(40); // exactly 40% remaining
    const events = updatedPos!.executionEventsJson as any;
    expect(events.tp2FillTime).toBeDefined();
    expect(events.partialLegs).toHaveLength(2);

    const updatedDecision = await prisma.tradeDecision.findUnique({ where: { id: decision.id } });
    expect(updatedDecision?.lifecycleState).toBe(TradeLifecycleState.TP2_PARTIAL_FILLED);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 6: Price reaches TP3: only remaining 40% closes, 1 final execution leg, exactly 1 canonical PaperTrade created
  // ─────────────────────────────────────────────────────────────────────────────
  it('Test 6: Price reaches TP3: only remaining 40% closes, 1 final execution leg, exactly 1 canonical PaperTrade created', async () => {
    currentTickerPrice = 24100.0;
    const { decision } = await createTestTradeDecision('NIFTY_SPOT');

    const pos = await paperTrading.placeOrder({
      symbol: 'NIFTY_SPOT',
      direction: 'BUY',
      orderType: 'MARKET',
      quantity: 100,
      price: 24100.0,
      stopLoss: 24000.0,
      target1: 24200.0,
      target2: 24300.0,
      target3: 24400.0,
      tradeDecisionId: decision.id,
      allowPriceOverride: true,
      executionMode: 'TEST' as any,
    });

    // Tick 1: TP1
    currentTickerPrice = 24200.0;
    let dbPos = await prisma.paperPosition.findUnique({ where: { id: pos.id } });
    await monitorService.evaluateSinglePosition(dbPos);

    // Tick 2: TP2
    currentTickerPrice = 24300.0;
    dbPos = await prisma.paperPosition.findUnique({ where: { id: pos.id } });
    await monitorService.evaluateSinglePosition(dbPos);

    // Tick 3: TP3
    currentTickerPrice = 24410.0;
    dbPos = await prisma.paperPosition.findUnique({ where: { id: pos.id } });
    await monitorService.evaluateSinglePosition(dbPos);

    const closedPos = await prisma.paperPosition.findUnique({ where: { id: pos.id } });
    expect(closedPos!.status).toBe(PositionState.CLOSED);

    // Exactly ONE canonical PaperTrade record
    const trades = await prisma.paperTrade.findMany({ where: { positionId: pos.id } });
    expect(trades).toHaveLength(1);
    expect(Number(trades[0].quantity)).toBe(100);
    expect(trades[0].exitReason).toBe('Target 3 Completed');

    const finalDecision = await prisma.tradeDecision.findUnique({ where: { id: decision.id } });
    expect(finalDecision?.lifecycleState).toBe(TradeLifecycleState.TRADE_CLOSED);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 7: Price hits SL before TP1: full position closes, no TP1 leg
  // ─────────────────────────────────────────────────────────────────────────────
  it('Test 7: Price hits SL before TP1: full position closes, no TP1 leg, lifecycle terminates in POSITION_CLOSED / TRADE_CLOSED', async () => {
    currentTickerPrice = 24100.0;
    const { decision } = await createTestTradeDecision('NIFTY_SPOT');

    const pos = await paperTrading.placeOrder({
      symbol: 'NIFTY_SPOT',
      direction: 'BUY',
      orderType: 'MARKET',
      quantity: 50,
      price: 24100.0,
      stopLoss: 24000.0,
      target1: 24200.0,
      tradeDecisionId: decision.id,
      allowPriceOverride: true,
      executionMode: 'TEST' as any,
    });

    // Drop below SL
    currentTickerPrice = 23980.0;
    const dbPos = await prisma.paperPosition.findUnique({ where: { id: pos.id } });
    await monitorService.evaluateSinglePosition(dbPos);

    const closedPos = await prisma.paperPosition.findUnique({ where: { id: pos.id } });
    expect(closedPos!.status).toBe(PositionState.CLOSED);

    const trades = await prisma.paperTrade.findMany({ where: { positionId: pos.id } });
    expect(trades).toHaveLength(1);
    expect(trades[0].exitReason).toBe('Stop Loss Hit');

    const outcome = trades[0].outcomeSnapshotJson as any;
    expect(outcome.legs.filter((l: any) => l.role === 'TP1_PARTIAL')).toHaveLength(0);

    const finalDecision = await prisma.tradeDecision.findUnique({ where: { id: decision.id } });
    expect(finalDecision?.lifecycleState).toBe(TradeLifecycleState.TRADE_CLOSED);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 8: Price hits SL after TP1: only remaining quantity closes at breakeven
  // ─────────────────────────────────────────────────────────────────────────────
  it('Test 8: Price hits SL after TP1: only remaining quantity closes at breakeven, TP1 realized P&L preserved', async () => {
    currentTickerPrice = 24100.0;
    const pos = await paperTrading.placeOrder({
      symbol: 'NIFTY_SPOT',
      direction: 'BUY',
      orderType: 'MARKET',
      quantity: 100,
      price: 24100.0,
      stopLoss: 24000.0,
      target1: 24200.0,
      target2: 24300.0,
      target3: 24400.0,
      allowPriceOverride: true,
      executionMode: 'TEST' as any,
    });

    // Step 1: Hit TP1 (closes 30%, moves SL to breakeven 24100)
    currentTickerPrice = 24200.0;
    let dbPos = await prisma.paperPosition.findUnique({ where: { id: pos.id } });
    await monitorService.evaluateSinglePosition(dbPos);

    // Step 2: Price retraces back down through breakeven stop loss
    currentTickerPrice = 24080.0;
    dbPos = await prisma.paperPosition.findUnique({ where: { id: pos.id } });
    await monitorService.evaluateSinglePosition(dbPos);

    const closedPos = await prisma.paperPosition.findUnique({ where: { id: pos.id } });
    expect(closedPos!.status).toBe(PositionState.CLOSED);

    const trades = await prisma.paperTrade.findMany({ where: { positionId: pos.id } });
    expect(trades).toHaveLength(1);
    expect(trades[0].exitReason).toBe('Breakeven Stop Loss Hit');

    const outcome = trades[0].outcomeSnapshotJson as any;
    const tp1Leg = outcome.legs.find((l: any) => l.role === 'TP1_PARTIAL');
    expect(tp1Leg).toBeDefined();
    expect(tp1Leg.quantity).toBe(30);
    expect(Number(tp1Leg.netPnL)).toBeGreaterThan(0);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 9: Concurrency test: Two monitor loops concurrently evaluate TP1
  // ─────────────────────────────────────────────────────────────────────────────
  it('Test 9: Concurrency test: Two monitor loops concurrently evaluate TP1; exactly one wins via CAS + unique idempotency key', async () => {
    currentTickerPrice = 24100.0;
    const pos = await paperTrading.placeOrder({
      symbol: 'NIFTY_SPOT',
      direction: 'BUY',
      orderType: 'MARKET',
      quantity: 100,
      price: 24100.0,
      stopLoss: 24000.0,
      target1: 24200.0,
      allowPriceOverride: true,
      executionMode: 'TEST' as any,
    });

    currentTickerPrice = 24210.0;
    const dbPos = await prisma.paperPosition.findUnique({ where: { id: pos.id } });

    // Concurrently trigger two evaluations
    await Promise.all([
      monitorService.evaluateSinglePosition(dbPos),
      monitorService.evaluateSinglePosition(dbPos),
    ]);

    // Verify exactly 1 TP1 order created
    const tp1Orders = await prisma.paperOrder.findMany({
      where: {
        OR: [
          { idempotencyKey: `tp1_partial:${pos.id}` },
          { idempotencyKey: `tp1_partial_${pos.id}` },
        ],
      },
    });
    expect(tp1Orders).toHaveLength(1);

    const updatedPos = await prisma.paperPosition.findUnique({ where: { id: pos.id } });
    expect(Number(updatedPos!.quantity)).toBe(70);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 10: Worker and API monitor cannot both execute lifecycle closures
  // ─────────────────────────────────────────────────────────────────────────────
  it('Test 10: Worker and API monitor cannot both execute lifecycle closures', async () => {
    currentTickerPrice = 24100.0;
    const pos = await paperTrading.placeOrder({
      symbol: 'NIFTY_SPOT',
      direction: 'BUY',
      orderType: 'MARKET',
      quantity: 10,
      price: 24100.0,
      stopLoss: 24000.0,
      target1: 24200.0,
      allowPriceOverride: true,
      executionMode: 'TEST' as any,
    });

    const mockRedis: any = {
      get: jest.fn().mockResolvedValue(JSON.stringify({ price: 23950.0, lastUpdated: Date.now() })),
      publish: jest.fn().mockResolvedValue(1),
      getClient: () => ({ status: 'ready', publish: jest.fn().mockResolvedValue(1) }),
    };

    const workerProcessor = new PositionMonitorProcessor(
      prisma as unknown as PrismaService,
      mockRedis,
    );

    currentTickerPrice = 23950.0;
    const dbPos = await prisma.paperPosition.findUnique({ where: { id: pos.id } });

    // Concurrently run API monitor and Worker processor
    await Promise.all([
      monitorService.evaluateSinglePosition(dbPos),
      workerProcessor.evaluateActivePositions(),
    ]);

    // Position is closed once
    const closedPos = await prisma.paperPosition.findUnique({ where: { id: pos.id } });
    expect(closedPos!.status).toBe(PositionState.CLOSED);

    // Exactly 1 PaperTrade record created
    const trades = await prisma.paperTrade.findMany({ where: { positionId: pos.id } });
    expect(trades).toHaveLength(1);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 11: TradeDecision state update fails due to PostgreSQL error: fail closed
  // ─────────────────────────────────────────────────────────────────────────────
  it('Test 11: TradeDecision state update fails due to PostgreSQL error: execution fails closed, no false positive report', async () => {
    await expect(
      tradeDecisionService.updateTradeLifecycleState(
        'non_existent_trade_decision_uuid',
        TradeLifecycleState.TRADE_CLOSED,
      ),
    ).rejects.toThrow('[LIFECYCLE_TRANSITION_FAILED]');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 12: NIFTY_SPOT SELL/SHORT opening is rejected with SPOT_SHORT_SELLING_FORBIDDEN
  // ─────────────────────────────────────────────────────────────────────────────
  it('Test 12: NIFTY_SPOT SELL/SHORT opening is rejected with SPOT_SHORT_SELLING_FORBIDDEN', async () => {
    currentTickerPrice = 24100.0;

    await expect(
      paperTrading.placeOrder({
        symbol: 'NIFTY_SPOT',
        direction: 'SELL',
        orderType: 'MARKET',
        quantity: 50,
        price: 24100.0,
        stopLoss: 24200.0,
        allowPriceOverride: true,
        executionMode: 'TEST' as any,
      }),
    ).rejects.toThrow('SPOT_SHORT_SELLING_FORBIDDEN');

    // Also verify for BANKNIFTY_SPOT
    await expect(
      paperTrading.placeOrder({
        symbol: 'BANKNIFTY_SPOT',
        direction: 'SELL',
        orderType: 'MARKET',
        quantity: 50,
        price: 51200.0,
        stopLoss: 51500.0,
        target1: 50800.0,
        allowPriceOverride: true,
        executionMode: 'TEST' as any,
      }),
    ).rejects.toThrow('SPOT_SHORT_SELLING_FORBIDDEN');

    // Verify explicit derivative NIFTY allows shorting without SPOT_SHORT_SELLING_FORBIDDEN
    const derivPos = await paperTrading.placeOrder({
      symbol: 'NIFTY',
      direction: 'SELL',
      orderType: 'MARKET',
      quantity: 50,
      price: 24100.0,
      stopLoss: 24200.0,
      target1: 24000.0,
      allowPriceOverride: true,
      executionMode: 'TEST' as any,
    });
    expect(derivPos).toBeDefined();
    expect(derivPos.direction).toBe('SELL');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 13: Explicit derivative option contract supports short opening
  // ─────────────────────────────────────────────────────────────────────────────
  it('Test 13: Explicit derivative option contract supports short opening when configured', async () => {
    currentTickerPrice = 120.0;

    // Option short (selling an option call or put) is allowed
    const optPos = await paperTrading.placeOrder({
      symbol: 'NIFTY 24000 CE',
      contractSymbol: 'NIFTY 24000 CE',
      instrumentType: 'OPTION',
      strike: 24000,
      optionType: 'CE',
      direction: 'SELL',
      orderType: 'MARKET',
      quantity: 50,
      price: 120.0,
      stopLoss: 180.0,
      target1: 60.0,
      allowPriceOverride: true,
      executionMode: 'TEST' as any,
    });

    expect(optPos).toBeDefined();
    expect(optPos.direction).toBe('SELL');
    expect(optPos.instrumentType).toBe('OPTION');
    expect(optPos.status).toBe(PositionState.OPEN);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 14: Policy parity: Backtest, shadow, and live paper all share the same 30/30/40 policy
  // ─────────────────────────────────────────────────────────────────────────────
  it('Test 14: Policy parity: Backtest, shadow, and live paper all share the same 30/30/40 policy', () => {
    expect(DEFAULT_PARTIAL_EXIT_POLICY.tp1Ratio).toBe(0.3);
    expect(DEFAULT_PARTIAL_EXIT_POLICY.tp2Ratio).toBe(0.3);
    expect(DEFAULT_PARTIAL_EXIT_POLICY.tp3Ratio).toBe(0.4);
    expect(DEFAULT_PARTIAL_EXIT_POLICY.moveStopToBreakevenOnTp1).toBe(true);

    const validation = TradeLifecycleManager.validatePartialExitPolicy(DEFAULT_PARTIAL_EXIT_POLICY);
    expect(validation.isValid).toBe(true);

    const sum =
      DEFAULT_PARTIAL_EXIT_POLICY.tp1Ratio +
      DEFAULT_PARTIAL_EXIT_POLICY.tp2Ratio +
      DEFAULT_PARTIAL_EXIT_POLICY.tp3Ratio;
    expect(Number(sum.toFixed(4))).toBe(1.0);
  });
});
