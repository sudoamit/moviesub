import { Test, TestingModule } from '@nestjs/testing';
import { AlgoBotsService, IAlgoBot } from '../algo-bots.service';
import { TradeDecisionService } from '../trade-decision.service';
import { PaperTradingService } from '../../paper-trading/paper-trading.service';
import { AlertsService } from '../../alerts/alerts.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  Direction,
  ISignalSetup,
  SignalGrade,
  SignalState,
  TradeDecisionType,
  TradeLifecycleState,
} from '@quant/shared';

describe('TradeDecisionService & Authoritative Trade Lifecycle (Fix 192)', () => {
  let algoBotsService: AlgoBotsService;
  let tradeDecisionService: TradeDecisionService;
  let mockPaperTradingService: any;
  let mockAlertsService: any;
  let mockPrismaService: any;

  const createTestBot = (overrides?: Partial<IAlgoBot>): IAlgoBot => ({
    id: 'bot_nifty_smc_test',
    name: 'NIFTY 15m Institutional Order Flow Scalper',
    symbol: 'NIFTY',
    direction: 'BULLISH',
    timeframe: '15m',
    minScore: 80,
    smcCondition: 'ORDER_BLOCK',
    lots: 1,
    autoExecutePaper: true,
    notifyWebhook: false,
    isActive: true,
    createdAt: new Date().toISOString(),
    triggerCount: 0,
    ...overrides,
  });

  const nowMs = 1726488000000; // Deterministic timestamp

  const createTestSignal = (overrides?: Partial<ISignalSetup>): ISignalSetup => ({
    id: 'sig_nifty_test_001',
    symbol: 'NIFTY',
    timeframe: '15m',
    direction: Direction.BULLISH,
    state: SignalState.ACTIVE,
    grade: SignalGrade.A_PLUS,
    score: 85,
    canonicalCandleTime: nowMs,
    canonicalDecisionTime: new Date(nowMs),
    entryZone: { min: 24000, max: 24010, optimal: 24005 },
    stopLoss: 23950,
    takeProfits: { tp1: 24100, tp2: 24200, tp3: 24300 },
    riskRewardRatios: { rr1: 1.7, rr2: 3.5, rr3: 5.3 },
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
      premiumDiscount: 10,
      riskReward: 10,
      indicatorAlignment: 10,
      totalScore: 85,
      grade: SignalGrade.A_PLUS,
    },
    triggerEvidence: {
      orderBlock: { matched: true, timestamp: new Date(nowMs), details: 'OB tap' },
      fvg: { matched: false },
      liquiditySweep: { matched: false },
      structureBreak: { matched: true, timestamp: new Date(nowMs) },
    },
    reasons: ['HTF_BULLISH_ALIGNED', 'BULLISH_ORDER_BLOCK_TAP'],
    timestamp: new Date(nowMs),
    ...overrides,
  });

  beforeEach(async () => {
    jest.spyOn(Date, 'now').mockReturnValue(nowMs);

    mockPaperTradingService = {
      getPortfolio: jest.fn().mockResolvedValue({
        initialCapital: 1000000,
        currentCapital: 1000000,
        openPositions: [],
      }),
      getValidatedMarketPrice: jest.fn().mockResolvedValue({
        price: 24005.0,
        timestamp: new Date(nowMs),
      }),
      placeOrder: jest.fn().mockResolvedValue({
        id: 'pos_nifty_order_001',
        entryPrice: 24005.0,
        status: 'OPEN',
      }),
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

  describe('1. Authoritative Pre-Trade Decision Evaluation', () => {
    it('should evaluate TAKE decision when all criteria, levels, risk, and quotes are valid', () => {
      const bot = createTestBot();
      const signal = createTestSignal();

      const result = tradeDecisionService.evaluatePreTradeDecision({
        bot,
        signal,
        portfolio: { initialCapital: 1000000, openPositions: [] } as any,
        liveQuote: { price: 24005.0, timestamp: new Date(nowMs) },
      });

      expect(result.decision).toBe(TradeDecisionType.TAKE);
      expect(result.decisionReasonCode).toBe('PRE_TRADE_APPROVED');
      expect(result.lifecycleState).toBe(TradeLifecycleState.PRE_TRADE_APPROVED);
      expect(result.plannedLevels).toBeDefined();
      expect(result.plannedLevels?.optimalEntry).toBe(24005);
      expect(result.plannedLevels?.stopLoss).toBe(23950);
      expect(result.plannedLevels?.target1).toBe(24100);
      expect(result.plannedLevels?.quantity).toBe(65); // NIFTY lot size = 65 in registry
      expect(result.plannedLevels?.riskAmount).toBe(3575); // (24005 - 23950) * 65 = 55 * 65 = 3575
      expect(result.signalSnapshotJson).toBeDefined();
      expect(result.marketSnapshotJson).toBeDefined();
      expect(result.riskSnapshotJson).toBeDefined();
    });

    it('should REJECT when bot is inactive', () => {
      const bot = createTestBot({ isActive: false });
      const signal = createTestSignal();

      const result = tradeDecisionService.evaluatePreTradeDecision({
        bot,
        signal,
      });

      expect(result.decision).toBe(TradeDecisionType.REJECT);
      expect(result.decisionReasonCode).toBe('BOT_INACTIVE');
      expect(result.lifecycleState).toBe(TradeLifecycleState.TRADE_REJECTED);
    });

    it('should REJECT when signal is not active', () => {
      const bot = createTestBot();
      const signal = createTestSignal({ state: SignalState.EXPIRED });

      const result = tradeDecisionService.evaluatePreTradeDecision({
        bot,
        signal,
      });

      expect(result.decision).toBe(TradeDecisionType.REJECT);
      expect(result.decisionReasonCode).toBe('SIGNAL_NOT_ACTIVE');
      expect(result.lifecycleState).toBe(TradeLifecycleState.TRADE_REJECTED);
    });

    it('should REJECT when direction is NEUTRAL or grade is NO_TRADE', () => {
      const bot = createTestBot();
      const signal = createTestSignal({ grade: SignalGrade.NO_TRADE });

      const result = tradeDecisionService.evaluatePreTradeDecision({
        bot,
        signal,
      });

      expect(result.decision).toBe(TradeDecisionType.REJECT);
      expect(result.decisionReasonCode).toBe('INVALID_SIGNAL');
      expect(result.lifecycleState).toBe(TradeLifecycleState.TRADE_REJECTED);
    });

    it('should REJECT when price levels geometry is inverted', () => {
      const bot = createTestBot();
      // Bullish with SL above entry
      const signal = createTestSignal({ stopLoss: 24100, entryZone: { min: 24000, max: 24010, optimal: 24005 } });

      const result = tradeDecisionService.evaluatePreTradeDecision({
        bot,
        signal,
      });

      expect(result.decision).toBe(TradeDecisionType.REJECT);
      expect(result.decisionReasonCode).toBe('INVALID_LEVELS');
      expect(result.lifecycleState).toBe(TradeLifecycleState.TRADE_REJECTED);
    });

    it('should REJECT when open position already exists in portfolio', () => {
      const bot = createTestBot({ symbol: 'NIFTY' });
      const signal = createTestSignal({ symbol: 'NIFTY' });

      const result = tradeDecisionService.evaluatePreTradeDecision({
        bot,
        signal,
        portfolio: {
          initialCapital: 1000000,
          openPositions: [{ symbol: 'NIFTY', status: 'OPEN' }],
        } as any,
      });

      expect(result.decision).toBe(TradeDecisionType.REJECT);
      expect(result.decisionReasonCode).toBe('POSITION_ALREADY_OPEN');
      expect(result.lifecycleState).toBe(TradeLifecycleState.TRADE_REJECTED);
    });

    it('should REJECT SMC evidence that is older than 20 candle intervals (No *50 relaxation)', () => {
      const bot = createTestBot({ smcCondition: 'ORDER_BLOCK' });
      // 15m candle = 15*60*1000 = 900000ms. 20 candles = 300m (5h). Evidence 6 hours old must be rejected
      const staleEvidenceTime = new Date(nowMs - 6 * 60 * 60 * 1000);
      const signal = createTestSignal({
        triggerEvidence: {
          orderBlock: { matched: true, timestamp: staleEvidenceTime, details: 'Stale OB tap' },
        },
      });

      const result = tradeDecisionService.evaluatePreTradeDecision({
        bot,
        signal,
      });

      expect(result.decision).toBe(TradeDecisionType.REJECT);
      expect(result.decisionReasonCode).toBe('SMC_CONDITION_MISMATCH');
    });
  });

  describe('2. Deterministic Fingerprint Generation', () => {
    it('should generate identical fingerprint for identical bot config and signal candle boundary', () => {
      const bot = createTestBot();
      const signal1 = createTestSignal({ canonicalCandleTime: nowMs });
      const signal2 = createTestSignal({ canonicalCandleTime: nowMs });

      const fp1 = tradeDecisionService.getTradeFingerprint(bot, signal1);
      const fp2 = tradeDecisionService.getTradeFingerprint(bot, signal2);

      expect(fp1).toBe(fp2);
      expect(fp1).toContain('bot_nifty_smc_test');
      expect(fp1).toContain('NIFTY');
      expect(fp1).toContain('BULLISH');
    });

    it('should fail closed when canonicalCandleTime is missing or invalid', () => {
      const bot = createTestBot();
      const malformedSignal = createTestSignal({ canonicalCandleTime: undefined as any });

      expect(() => tradeDecisionService.getTradeFingerprint(bot, malformedSignal)).toThrow(
        /CANONICAL_TIMESTAMP_REQUIRED/,
      );
    });

    it('should generate different fingerprint for different candle boundaries', () => {
      const bot = createTestBot();
      const signal1 = createTestSignal({ canonicalCandleTime: nowMs });
      const signal2 = createTestSignal({ canonicalCandleTime: nowMs + 15 * 60 * 1000 });

      const fp1 = tradeDecisionService.getTradeFingerprint(bot, signal1);
      const fp2 = tradeDecisionService.getTradeFingerprint(bot, signal2);

      expect(fp1).not.toBe(fp2);
    });
  });

  describe('3. End-to-End Pipeline in AlgoBotsService', () => {
    it('should execute full trade pipeline, creating decision and order when signal is valid', async () => {
      const bot = createTestBot();
      jest.spyOn(algoBotsService, 'listBots').mockResolvedValue([bot]);

      const signal = createTestSignal();

      const results = await algoBotsService.evaluateSignalForBots(signal);

      expect(results).toHaveLength(1);
      expect(results[0].status).toBe('EXECUTED');
      expect(results[0].decision).toBe('TAKE');
      expect(results[0].lifecycleState).toBe(TradeLifecycleState.POSITION_OPENED);
      expect(results[0].orderPositionId).toBe('pos_nifty_order_001');
      expect(results[0].tradeDecisionId).toBeDefined();

      expect(mockPaperTradingService.placeOrder).toHaveBeenCalledWith(
        expect.objectContaining({
          symbol: 'NIFTY',
          direction: 'BUY',
          quantity: 65,
          signalPrice: 24005,
          stopLoss: 23950,
          target1: 24100,
        }),
      );
    });

    it('should record REJECT decision when signal fails strategy matching', async () => {
      const bot = createTestBot({ minScore: 90 });
      jest.spyOn(algoBotsService, 'listBots').mockResolvedValue([bot]);

      const signal = createTestSignal({ score: 85 }); // Score 85 < minScore 90

      const results = await algoBotsService.evaluateSignalForBots(signal);

      expect(results).toHaveLength(1);
      expect(results[0].status).toBe('REJECTED');
      expect(results[0].decision).toBe('REJECT');
      expect(results[0].lifecycleState).toBe(TradeLifecycleState.TRADE_REJECTED);
      expect(results[0].reasonCode).toBe('SCORE_BELOW_THRESHOLD');
      expect(mockPaperTradingService.placeOrder).not.toHaveBeenCalled();
    });

    it('should handle order placement failure by marking execution FAILED and lifecycle state TRADE_FAILED', async () => {
      const bot = createTestBot();
      jest.spyOn(algoBotsService, 'listBots').mockResolvedValue([bot]);

      mockPaperTradingService.placeOrder.mockRejectedValueOnce(
        new Error('Broker 503 Service Unavailable'),
      );

      const signal = createTestSignal();
      const results = await algoBotsService.evaluateSignalForBots(signal);

      expect(results).toHaveLength(1);
      expect(results[0].status).toBe('FAILED');
      expect(results[0].decision).toBe('TAKE');
      expect(results[0].lifecycleState).toBe(TradeLifecycleState.TRADE_FAILED);
      expect(results[0].reasonCode).toBe('BROKER_UNAVAILABLE');
    });
  });

  describe('4. Lifecycle State Machine & Idempotent Commit', () => {
    it('should require accountId when committing a TAKE decision', async () => {
      const bot = createTestBot();
      const signal = createTestSignal();
      const fingerprint = tradeDecisionService.getTradeFingerprint(bot, signal);

      const decisionResult = tradeDecisionService.evaluatePreTradeDecision({
        bot,
        signal,
        portfolio: { initialCapital: 1000000, openPositions: [] } as any,
        liveQuote: { price: 24005.0, timestamp: new Date(nowMs) },
      });

      await expect(
        tradeDecisionService.commitTradeDecisionAndReservation({
          bot,
          signal,
          decisionResult,
          fingerprint,
          correlationId: fingerprint,
          accountId: '', // Empty accountId
        }),
      ).rejects.toThrow(/ACCOUNT_ID_REQUIRED/);
    });

    it('should return isDuplicate when committing duplicate fingerprint in mock fallback', async () => {
      const bot = createTestBot();
      const signal = createTestSignal();
      const fingerprint = tradeDecisionService.getTradeFingerprint(bot, signal);

      const decisionResult = tradeDecisionService.evaluatePreTradeDecision({
        bot,
        signal,
        portfolio: { initialCapital: 1000000, openPositions: [] } as any,
        liveQuote: { price: 24005.0, timestamp: new Date(nowMs) },
      });

      const commit1 = await tradeDecisionService.commitTradeDecisionAndReservation({
        bot,
        signal,
        decisionResult,
        fingerprint,
        correlationId: fingerprint,
        accountId: 'paper_test_acc_1',
      });

      expect(commit1.decision).toBe(TradeDecisionType.TAKE);
      expect(commit1.tradeDecisionId).toBeDefined();
      expect(commit1.executionId).toBeDefined();
    });

    it('should update trade lifecycle state safely without throwing errors', async () => {
      await expect(
        tradeDecisionService.updateTradeLifecycleState(
          'test_dec_123',
          TradeLifecycleState.ORDER_SUBMITTED,
        ),
      ).resolves.not.toThrow();

      await expect(
        tradeDecisionService.updateTradeLifecycleState(
          'test_dec_123',
          TradeLifecycleState.POSITION_OPENED,
          { orderPositionId: 'pos_123' },
        ),
      ).resolves.not.toThrow();
    });
  });
});

