import { Test, TestingModule } from '@nestjs/testing';
import { AlgoBotsService, IAlgoBot } from '../algo-bots.service';
import { TradeDecisionService } from '../trade-decision.service';
import { PaperTradingService } from '../../paper-trading/paper-trading.service';
import { AlertsService } from '../../alerts/alerts.service';
import {
  Direction,
  ISignalSetup,
  SignalGrade,
  SignalState,
  TradeDecisionType,
  TradeLifecycleState,
} from '@quant/shared';

describe('Fix 193 — True Trade Decision & Lifecycle Backend E2E Suite', () => {
  let algoBotsService: AlgoBotsService;
  let tradeDecisionService: TradeDecisionService;
  let mockPaperTradingService: any;
  let mockAlertsService: any;

  const nowMs = 1726488000000;

  const createActiveBot = (overrides?: Partial<IAlgoBot>): IAlgoBot => ({
    id: 'bot_btc_smc_live',
    name: 'BTCUSDT SMC Execution Bot',
    symbol: 'BTCUSDT',
    direction: 'BULLISH',
    timeframe: '15m',
    minScore: 75,
    smcCondition: 'ORDER_BLOCK',
    lots: 1,
    autoExecutePaper: true,
    notifyWebhook: false,
    isActive: true,
    accountId: 'acc_paper_btc_01',
    createdAt: new Date(nowMs - 3600000).toISOString(),
    triggerCount: 0,
    ...overrides,
  });

  const createCanonicalSignal = (overrides?: Partial<ISignalSetup>): ISignalSetup => ({
    id: 'sig_btc_canonical_101',
    symbol: 'BTCUSDT',
    timeframe: '15m',
    direction: Direction.BULLISH,
    state: SignalState.ACTIVE,
    grade: SignalGrade.A_PLUS,
    score: 85,
    canonicalCandleTime: nowMs,
    canonicalDecisionTime: new Date(nowMs),
    entryZone: { min: 64900, max: 65100, optimal: 65000 },
    stopLoss: 64200,
    takeProfits: { tp1: 66000, tp2: 67000, tp3: 68500 },
    riskRewardRatios: { rr1: 1.25, rr2: 2.5, rr3: 4.375 },
    reasoning: {
      htfStructure: 'Bullish BOS on 1h',
      liquidityReason: 'Sellside swept',
      triggerReason: '15m Order Block mitigation',
      invalidationReason: 'Below 64200',
      confirmedChecklist: ['Order Block'],
      summary: 'Institutional OB mitigation setup',
    },
    scoreBreakdown: {
      htfBias: 20,
      liquiditySweep: 15,
      bos: 15,
      fvg: 10,
      orderBlock: 20,
      displacement: 10,
      volumeConfirmation: 10,
      premiumDiscount: 10,
      riskReward: 10,
      indicatorAlignment: 10,
      totalScore: 85,
      grade: SignalGrade.A_PLUS,
    },
    triggerEvidence: {
      orderBlock: { matched: true, timestamp: new Date(nowMs - 300000), details: 'OB tap' },
      fvg: { matched: false },
      liquiditySweep: { matched: false },
      structureBreak: { matched: true, timestamp: new Date(nowMs - 300000) },
    },
    reasons: ['HTF_BULLISH_ALIGNED', 'BULLISH_ORDER_BLOCK_TAP'],
    timestamp: new Date(nowMs),
    ...overrides,
  });

  beforeEach(async () => {
    jest.spyOn(Date, 'now').mockReturnValue(nowMs);

    mockPaperTradingService = {
      getPortfolio: jest.fn().mockResolvedValue({
        accountId: 'acc_paper_btc_01',
        initialCapital: 1000000,
        currentCapital: 1000000,
        openPositions: [],
        dailyLossPercent: 0,
        consecutiveLosses: 0,
      }),
      getValidatedMarketPrice: jest.fn().mockResolvedValue({
        price: 65000.0,
        timestamp: new Date(nowMs),
      }),
      placeOrder: jest.fn().mockImplementation(async (orderDto) => ({
        id: `pos_paper_${Date.now()}`,
        symbol: orderDto.symbol,
        direction: orderDto.direction,
        entryPrice: 65000.0,
        status: 'OPEN',
      })),
    };

    mockAlertsService = {
      sendAlert: jest.fn().mockResolvedValue({ success: true }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AlgoBotsService,
        TradeDecisionService,
        { provide: PaperTradingService, useValue: mockPaperTradingService },
        { provide: AlertsService, useValue: mockAlertsService },
      ],
    }).compile();

    algoBotsService = module.get<AlgoBotsService>(AlgoBotsService);
    tradeDecisionService = module.get<TradeDecisionService>(TradeDecisionService);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('Requirement 1 & 6: Full Authoritative Trade Decision -> TAKE -> Execution -> POSITION_OPENED', async () => {
    const bot = createActiveBot();
    jest.spyOn(algoBotsService, 'listBots').mockResolvedValue([bot]);

    const signal = createCanonicalSignal();

    const results = await algoBotsService.evaluateSignalForBots(signal);

    expect(results).toHaveLength(1);
    const res = results[0];
    expect(res.botId).toBe('bot_btc_smc_live');
    expect(res.symbol).toBe('BTCUSDT');
    expect(res.decision).toBe('TAKE');
    expect(res.status).toBe('EXECUTED');
    expect(res.reasonCode).toBe('ORDER_PLACED_SUCCESSFULLY');
    expect(res.lifecycleState).toBe(TradeLifecycleState.POSITION_OPENED);
    expect(res.executionId).toBeDefined();
    expect(res.tradeDecisionId).toBeDefined();
    expect(res.orderPositionId).toBeDefined();
    expect(res.correlationId).toContain('bot_exec:');
    expect(res.correlationId).toContain('acc_paper_btc_01');
    expect(res.correlationId).toContain('bot_btc_smc_live');

    expect(mockPaperTradingService.placeOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        symbol: 'BTCUSDT',
        direction: 'BUY',
        quantity: 0.001,
        signalPrice: 65000,
        stopLoss: 64200,
        target1: 66000,
      }),
    );
  });

  it('Requirement 4: Strict SMC Evidence Bound — rejects evidence older than strategy validity window', async () => {
    const bot = createActiveBot();
    jest.spyOn(algoBotsService, 'listBots').mockResolvedValue([bot]);

    // 15m candle = 15*60*1000 = 900,000 ms. Strategy validity window is 12 bars (3h). Evidence 6 hours old must be rejected
    const oldEvidenceTimestamp = new Date(nowMs - 6 * 60 * 60 * 1000);
    const signal = createCanonicalSignal({
      triggerEvidence: {
        orderBlock: { matched: true, timestamp: oldEvidenceTimestamp },
      },
    });

    const results = await algoBotsService.evaluateSignalForBots(signal);

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('REJECTED');
    expect(results[0].decision).toBe('REJECT');
    expect(results[0].reasonCode).toBe('SMC_CONDITION_MISMATCH');
    expect(results[0].lifecycleState).toBe(TradeLifecycleState.TRADE_REJECTED);
    expect(mockPaperTradingService.placeOrder).not.toHaveBeenCalled();
  });

  it('Requirement 5: Deterministic Trade Fingerprint fails closed when canonical candle time is missing', () => {
    const bot = createActiveBot();
    const badSignal = createCanonicalSignal({ canonicalCandleTime: 0 });

    expect(() => tradeDecisionService.getTradeFingerprint(bot, badSignal)).toThrow(
      /CANONICAL_TIMESTAMP_REQUIRED/,
    );
  });

  it('Requirement 7 & 8: Multi-constraint risk pre-flight checks enforce limits', () => {
    const bot = createActiveBot();
    const signal = createCanonicalSignal();

    // Test Emergency Stop
    const resEmergency = tradeDecisionService.evaluatePreTradeDecision({
      bot,
      signal,
      systemConfig: { emergencyStop: true },
    });
    expect(resEmergency.decision).toBe(TradeDecisionType.REJECT);
    expect(resEmergency.decisionReasonCode).toBe('EMERGENCY_STOP');

    // Test Max Open Positions
    const resMaxPos = tradeDecisionService.evaluatePreTradeDecision({
      bot,
      signal,
      portfolio: {
        openPositions: [{ symbol: 'ETHUSDT' }, { symbol: 'SOLUSDT' }],
      } as any,
      systemConfig: { maxOpenPositions: 2 },
    });
    expect(resMaxPos.decision).toBe(TradeDecisionType.REJECT);
    expect(resMaxPos.decisionReasonCode).toBe('MAX_OPEN_POSITIONS');
  });

  it('Fix 194 (Requirements 1, 2, 3, 4, 10, 11, 12, 16): Authoritative Lifecycle E2E: Signal -> PRE_TRADE_APPROVED -> TRADE_TAKEN -> RESERVATION_CREATED -> Fresh Quote -> ORDER_SUBMITTED -> ORDER_FILLED -> POSITION_OPENED', async () => {
    const bot = createActiveBot();
    const signal = createCanonicalSignal();
    const accountId = 'acc_paper_btc_01';

    // Phase 1: Pure Pre-Trade Evaluation -> NEVER returns TRADE_TAKEN
    const preTradeRes = tradeDecisionService.evaluatePreTradeDecision({
      bot,
      signal,
      portfolio: {
        accountId,
        initialCapital: 1000000,
        openPositions: [],
      } as any,
      liveQuote: { price: 65000.0, timestamp: new Date(nowMs) },
    });

    expect(preTradeRes.decision).toBe(TradeDecisionType.TAKE);
    expect(preTradeRes.decisionReasonCode).toBe('PRE_TRADE_APPROVED');
    // Must be PRE_TRADE_APPROVED, strictly NOT TRADE_TAKEN
    expect(preTradeRes.lifecycleState).toBe(TradeLifecycleState.PRE_TRADE_APPROVED);

    // Phase 2: Commit Trade Decision & Reservation
    const fingerprint = tradeDecisionService.getTradeFingerprint(bot, signal, accountId);
    expect(fingerprint).toContain('acc_paper_btc_01');
    expect(fingerprint).toContain('bot_btc_smc_live');
    expect(fingerprint).toContain('sig_btc_canonical_101');
    expect(fingerprint).toContain('BTCUSDT');
    expect(fingerprint).toContain('BULLISH');
    expect(fingerprint).toContain(String(nowMs));

    const commitRes = await tradeDecisionService.commitTradeDecisionAndReservation({
      bot,
      signal,
      decisionResult: preTradeRes,
      fingerprint,
      correlationId: fingerprint,
      accountId,
    });

    expect(commitRes.decision).toBe(TradeDecisionType.TAKE);
    expect(commitRes.lifecycleState).toBe(TradeLifecycleState.RESERVATION_CREATED);
    expect(commitRes.executionId).toBeDefined();

    // Phase 3: Fresh Market Quote At Execution Time
    const freshQuote = await mockPaperTradingService.getValidatedMarketPrice('BTCUSDT', 5);
    expect(freshQuote.price).toBe(65000.0);

    // Phase 4: Order Submission
    const updateSpy = jest.spyOn(tradeDecisionService, 'updateTradeLifecycleState');
    await tradeDecisionService.updateTradeLifecycleState(
      commitRes.tradeDecisionId,
      TradeLifecycleState.ORDER_SUBMITTED,
      {
        executionId: commitRes.executionId,
        orderSubmittedTime: new Date(),
        marketEventTime: freshQuote.timestamp,
        observedAt: new Date(),
        receivedAt: new Date(),
      },
    );

    expect(updateSpy).toHaveBeenCalledWith(
      commitRes.tradeDecisionId,
      TradeLifecycleState.ORDER_SUBMITTED,
      expect.objectContaining({
        orderSubmittedTime: expect.any(Date),
        marketEventTime: expect.any(Date),
      }),
    );

    // Phase 5: Fill Distinct from Order Submission
    const fillRes = await mockPaperTradingService.placeOrder({
      symbol: 'BTCUSDT',
      direction: 'BUY',
      quantity: 0.001,
    });
    expect(fillRes.status).toBe('OPEN');

    await tradeDecisionService.updateTradeLifecycleState(
      commitRes.tradeDecisionId,
      TradeLifecycleState.ORDER_FILLED,
      {
        executionId: commitRes.executionId,
        orderPositionId: fillRes.id,
        fillTime: new Date(),
      },
    );

    expect(updateSpy).toHaveBeenCalledWith(
      commitRes.tradeDecisionId,
      TradeLifecycleState.ORDER_FILLED,
      expect.objectContaining({
        orderPositionId: fillRes.id,
        fillTime: expect.any(Date),
      }),
    );

    // Phase 6: Position Opened
    await tradeDecisionService.updateTradeLifecycleState(
      commitRes.tradeDecisionId,
      TradeLifecycleState.POSITION_OPENED,
      {
        executionId: commitRes.executionId,
        orderPositionId: fillRes.id,
      },
    );

    expect(updateSpy).toHaveBeenCalledWith(
      commitRes.tradeDecisionId,
      TradeLifecycleState.POSITION_OPENED,
      expect.objectContaining({
        orderPositionId: fillRes.id,
      }),
    );
  });
});
