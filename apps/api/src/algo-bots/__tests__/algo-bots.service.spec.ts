import { Test, TestingModule } from '@nestjs/testing';
import { AlgoBotsService, IAlgoBot, classifyExecutionFailure } from '../algo-bots.service';
import { PaperTradingService } from '../../paper-trading/paper-trading.service';
import { AlertsService } from '../../alerts/alerts.service';
import { Direction, ISignalSetup, MarketDataUnavailableError, SignalGrade, SignalState } from '@quant/shared';
import { SignalGenerator } from '@quant/trading-engine';
import { InternalServerErrorException } from '@nestjs/common';

describe('AlgoBotsService — Production-Grade Execution Safety & Verification (Fix 174 Pass 2)', () => {
  let service: AlgoBotsService;
  let mockPaperTradingService: any;
  let mockAlertsService: any;
  let mockPrismaService: any;

  const createTestBot = (overrides?: Partial<IAlgoBot>): IAlgoBot => ({
    id: 'bot_nifty_ob_test',
    name: 'NIFTY Order Block Scalper',
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

  const createTestSignal = (overrides?: Partial<ISignalSetup>): ISignalSetup => ({
    id: 'sig_nifty_1001',
    symbol: 'NIFTY',
    timeframe: '15m',
    direction: Direction.BULLISH,
    state: SignalState.ACTIVE,
    grade: SignalGrade.A_PLUS,
    score: 85,
    entryZone: { min: 23990, max: 24010, optimal: 24000 },
    stopLoss: 23950,
    takeProfits: { tp1: 24100, tp2: 24200, tp3: 24300 },
    riskRewardRatios: { rr1: 1.5, rr2: 2.5, rr3: 4.0 },
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
      orderBlock: { matched: true, timestamp: new Date(), details: 'OB tap' },
      fvg: { matched: false },
      liquiditySweep: { matched: false },
      structureBreak: { matched: true, timestamp: new Date() },
    },
    reasons: ['HTF_BULLISH_ALIGNED', 'BULLISH_ORDER_BLOCK_TAP'],
    timestamp: new Date(),
    ...overrides,
  });

  beforeEach(async () => {
    mockPaperTradingService = {
      getPortfolio: jest.fn().mockResolvedValue({ openPositions: [] }),
      getValidatedMarketPrice: jest.fn().mockResolvedValue({ price: 24000.0, timestamp: new Date() }),
      placeOrder: jest.fn().mockResolvedValue({ id: 'pos_123', entryPrice: 24000.0 }),
    };

    mockAlertsService = {
      sendAlert: jest.fn().mockResolvedValue({ success: true }),
    };

    mockPrismaService = null;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AlgoBotsService,
        { provide: PaperTradingService, useValue: mockPaperTradingService },
        { provide: AlertsService, useValue: mockAlertsService },
      ],
    }).compile();

    service = module.get<AlgoBotsService>(AlgoBotsService);
  });

  // 1. Canonical SMC Evidence & Timestamp Provenance
  describe('1. Canonical SMC Trigger Evidence & Provenance', () => {
    it('should REJECT signal when triggerEvidence object is completely absent', async () => {
      const bot = createTestBot({ smcCondition: 'ORDER_BLOCK' });
      jest.spyOn(service, 'listBots').mockResolvedValue([bot]);
      const signal = createTestSignal({ triggerEvidence: undefined });

      await service.evaluateSignalForBots(signal);

      expect(mockPaperTradingService.placeOrder).not.toHaveBeenCalled();
    });

    it('should REJECT when SMC trigger evidence timestamp is stale (> maxSignalAgeMs)', async () => {
      const bot = createTestBot({ smcCondition: 'ORDER_BLOCK' });
      jest.spyOn(service, 'listBots').mockResolvedValue([bot]);
      const staleEvidenceTime = new Date(Date.now() - 30 * 60 * 1000); // 30 minutes old
      const signal = createTestSignal({
        triggerEvidence: {
          orderBlock: { matched: true, timestamp: staleEvidenceTime },
        },
      });

      await service.evaluateSignalForBots(signal);

      expect(mockPaperTradingService.placeOrder).not.toHaveBeenCalled();
    });
  });

  // 2. Decision Boundary Window & Signal State
  describe('2. Decision Boundary Window & Signal State', () => {
    it('should REJECT when signal state is not SignalState.ACTIVE', async () => {
      const bot = createTestBot();
      jest.spyOn(service, 'listBots').mockResolvedValue([bot]);
      const pendingSignal = createTestSignal({ state: SignalState.PENDING });

      await service.evaluateSignalForBots(pendingSignal);

      expect(mockPaperTradingService.placeOrder).not.toHaveBeenCalled();
    });

    it('should REJECT signal that has passed its timeframe decision boundary window', async () => {
      const bot = createTestBot({ timeframe: '15m' });
      jest.spyOn(service, 'listBots').mockResolvedValue([bot]);
      const expiredWindowTimestamp = new Date(Date.now() - 16 * 60 * 1000); // 16 mins ago
      const expiredSignal = createTestSignal({ timestamp: expiredWindowTimestamp });

      await service.evaluateSignalForBots(expiredSignal);

      expect(mockPaperTradingService.placeOrder).not.toHaveBeenCalled();
    });
  });

  // 3. Strategy Config Versioning in Fingerprint
  describe('3. Strategy Config Versioning in Fingerprint', () => {
    it('should include bot configuration version hash in execution fingerprint', () => {
      const bot1 = createTestBot({ minScore: 80 });
      const bot2 = createTestBot({ minScore: 90 });
      const bot = createTestBot();
      const signal = createTestSignal();

      const fingerprint = service.getSignalFingerprint(bot, signal);

      expect(fingerprint).toMatch(/^bot_exec:bot_nifty_ob_test:v[a-f0-9]{8}:NIFTY:15m:BULLISH:\d+$/);
    });
  });

  // 4. Order of Operations & Position Check Prior to Reservation
  describe('4. Order of Operations & Position Check Prior to Reservation', () => {
    it('should NOT attempt database reservation if open position already exists for symbol', async () => {
      const bot = createTestBot();
      jest.spyOn(service, 'listBots').mockResolvedValue([bot]);
      mockPaperTradingService.getPortfolio.mockResolvedValue({
        openPositions: [{ symbol: 'NIFTY' }],
      });
      const reserveSpy = jest.spyOn(service, 'reserveExecutionLock');
      const signal = createTestSignal();

      await service.evaluateSignalForBots(signal);

      expect(reserveSpy).not.toHaveBeenCalled();
      expect(mockPaperTradingService.placeOrder).not.toHaveBeenCalled();
    });

    it('should NOT attempt database reservation when autoExecutePaper is false', async () => {
      const bot = createTestBot({ autoExecutePaper: false });
      jest.spyOn(service, 'listBots').mockResolvedValue([bot]);
      const reserveSpy = jest.spyOn(service, 'reserveExecutionLock');
      const signal = createTestSignal();

      await service.evaluateSignalForBots(signal);

      expect(reserveSpy).not.toHaveBeenCalled();
      expect(mockPaperTradingService.placeOrder).not.toHaveBeenCalled();
    });
  });

  // 5. DB Fail-Closed for Bot Configuration Operations
  describe('5. Database Fail-Closed for Bot Configuration', () => {
    it('should throw InternalServerErrorException when database query fails during listBots()', async () => {
      const dbMockPrisma = {
        algoBot: {
          findMany: jest.fn().mockRejectedValue(new Error('Connection terminated')),
        },
      };

      const testService = new AlgoBotsService(
        mockPaperTradingService,
        mockAlertsService,
        dbMockPrisma as any,
      );

      await expect(testService.listBots()).rejects.toThrow(InternalServerErrorException);
    });
  });

  // 6. Mandatory Canonical Decision Timestamp Policy (Fix 177)
  describe('6. Mandatory Canonical Decision Timestamp Policy', () => {
    it('should REJECT auto-execution when canonicalCandleTime is missing', () => {
      const bot = createTestBot({ autoExecutePaper: true });
      const signal = createTestSignal({ canonicalCandleTime: undefined });

      const eligibility = service.validateExecutionEligibility(bot, signal);

      expect(eligibility.matches).toBe(false);
      expect(eligibility.reasonCode).toBe('CANONICAL_DECISION_TIMESTAMP_REQUIRED');
    });

    it('should ACCEPT auto-execution when valid canonicalCandleTime is present', () => {
      const bot = createTestBot({ autoExecutePaper: true });
      const signal = createTestSignal({ canonicalCandleTime: Date.now() });

      const eligibility = service.validateExecutionEligibility(bot, signal);

      expect(eligibility.matches).toBe(true);
    });
  });

  // 7. Deterministic Failure Reason Classification (Fix 177)
  describe('7. Deterministic Failure Reason Classification', () => {
    it('should classify MarketDataUnavailableError as retryable MARKET_DATA_UNAVAILABLE', () => {
      const err = new MarketDataUnavailableError('BTCUSDT', 'Streamer timeout');
      const classification = classifyExecutionFailure(err);

      expect(classification.retryable).toBe(true);
      expect(classification.reasonCode).toBe('MARKET_DATA_UNAVAILABLE');
    });

    it('should classify generic Error as non-retryable UNKNOWN_EXECUTION_ERROR', () => {
      const err = new Error('Random error message containing network');
      const classification = classifyExecutionFailure(err);

      expect(classification.retryable).toBe(false);
      expect(classification.reasonCode).toBe('UNKNOWN_EXECUTION_ERROR');
    });
  });

  // 8. Finite State Machine Graph Edge Validation (Fix 177)
  describe('8. Finite State Machine Graph Edge Validation', () => {
    it('should REJECT prohibited graph transition (EXECUTED -> EXECUTING)', async () => {
      await expect(
        service.transitionExecutionState('test_exec_123', 'EXECUTED' as any, 'EXECUTING'),
      ).rejects.toThrow(InternalServerErrorException);
    });

    it('should REJECT prohibited graph transition (FAILED_FINAL -> RESERVED)', async () => {
      await expect(
        service.transitionExecutionState('test_exec_123', 'FAILED_FINAL' as any, 'RESERVED'),
      ).rejects.toThrow(InternalServerErrorException);
    });
  });
});
