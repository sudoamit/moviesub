import { Test, TestingModule } from '@nestjs/testing';
import { AlgoBotsService, IAlgoBot } from '../algo-bots.service';
import { PaperTradingService } from '../../paper-trading/paper-trading.service';
import { AlertsService } from '../../alerts/alerts.service';
import { Direction, ISignalSetup, MarketDataUnavailableError, SignalGrade, SignalState } from '@quant/shared';
import { SignalGenerator } from '@quant/trading-engine';

describe('AlgoBotsService — Production-Grade Execution Safety (Fix 174)', () => {
  let service: AlgoBotsService;
  let mockPaperTradingService: any;
  let mockAlertsService: any;

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
      orderBlock: { matched: true, details: 'OB tap' },
      fvg: { matched: false },
      liquiditySweep: { matched: false },
      structureBreak: { matched: true },
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

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AlgoBotsService,
        { provide: PaperTradingService, useValue: mockPaperTradingService },
        { provide: AlertsService, useValue: mockAlertsService },
      ],
    }).compile();

    service = module.get<AlgoBotsService>(AlgoBotsService);
  });

  // A. SMC Canonical Trigger Evidence Matching
  describe('A. Canonical SMC Trigger Evidence Matching', () => {
    it('should execute when bot requires ORDER_BLOCK and signal has orderBlock.matched = true', async () => {
      const bot = createTestBot({ smcCondition: 'ORDER_BLOCK' });
      jest.spyOn(service, 'listBots').mockResolvedValue([bot]);
      const signal = createTestSignal();

      await service.evaluateSignalForBots(signal);

      expect(mockPaperTradingService.placeOrder).toHaveBeenCalledTimes(1);
      expect(mockPaperTradingService.placeOrder).toHaveBeenCalledWith(
        expect.objectContaining({
          symbol: 'NIFTY',
          quantity: 65, // 1 lot * 65 lotSize
        }),
      );
    });

    it('should REJECT when bot requires FVG but signal has fvg.matched = false even if scoreBreakdown.fvg > 0', async () => {
      const bot = createTestBot({ smcCondition: 'FVG' });
      jest.spyOn(service, 'listBots').mockResolvedValue([bot]);
      const signal = createTestSignal({
        triggerEvidence: {
          orderBlock: { matched: true },
          fvg: { matched: false },
        },
      });

      await service.evaluateSignalForBots(signal);

      expect(mockPaperTradingService.placeOrder).not.toHaveBeenCalled();
    });

    it('should REJECT ANY_CONFLUENCE when all trigger evidence matched properties are false', async () => {
      const bot = createTestBot({ smcCondition: 'ANY_CONFLUENCE' });
      jest.spyOn(service, 'listBots').mockResolvedValue([bot]);
      const signal = createTestSignal({
        triggerEvidence: {
          orderBlock: { matched: false },
          fvg: { matched: false },
          liquiditySweep: { matched: false },
          structureBreak: { matched: false },
        },
      });

      await service.evaluateSignalForBots(signal);

      expect(mockPaperTradingService.placeOrder).not.toHaveBeenCalled();
    });
  });

  // B. Signal State Enforcement (P0 #6)
  describe('B. Signal State Enforcement', () => {
    it('should REJECT non-ACTIVE signal states (PENDING, TP1_HIT, EXPIRED, CANCELLED)', async () => {
      const bot = createTestBot();
      jest.spyOn(service, 'listBots').mockResolvedValue([bot]);

      const pendingSignal = createTestSignal({ state: SignalState.PENDING });
      const tp1Signal = createTestSignal({ state: SignalState.TP1_HIT });
      const expiredSignal = createTestSignal({ state: SignalState.EXPIRED });
      const cancelledSignal = createTestSignal({ state: SignalState.CANCELLED });

      await service.evaluateSignalForBots(pendingSignal);
      await service.evaluateSignalForBots(tp1Signal);
      await service.evaluateSignalForBots(expiredSignal);
      await service.evaluateSignalForBots(cancelledSignal);

      expect(mockPaperTradingService.placeOrder).not.toHaveBeenCalled();
    });
  });

  // C. Signal Freshness & Maximum Age (P0 #7)
  describe('C. Signal Freshness & Maximum Age Policy', () => {
    it('should REJECT stale signal exceeding max age for timeframe', async () => {
      const bot = createTestBot({ timeframe: '15m' });
      jest.spyOn(service, 'listBots').mockResolvedValue([bot]);

      // 16 minutes old (max allowed for 15m is 15 minutes)
      const staleTimestamp = new Date(Date.now() - 16 * 60 * 1000);
      const staleSignal = createTestSignal({ timestamp: staleTimestamp });

      await service.evaluateSignalForBots(staleSignal);

      expect(mockPaperTradingService.placeOrder).not.toHaveBeenCalled();
    });

    it('should REJECT signal with timestamp in the future (>5s ahead)', async () => {
      const bot = createTestBot();
      jest.spyOn(service, 'listBots').mockResolvedValue([bot]);

      const futureTimestamp = new Date(Date.now() + 60 * 1000);
      const futureSignal = createTestSignal({ timestamp: futureTimestamp });

      await service.evaluateSignalForBots(futureSignal);

      expect(mockPaperTradingService.placeOrder).not.toHaveBeenCalled();
    });
  });

  // D. Canonical Decision Fingerprint (P0 #8)
  describe('D. Canonical Decision Fingerprint', () => {
    it('should generate identical fingerprints for two scans of the same candle decision boundary', () => {
      const bot = createTestBot();
      const signal1 = createTestSignal({ id: 'sig_1', timestamp: new Date('2026-09-15T09:05:00.000Z') });
      const signal2 = createTestSignal({ id: 'sig_2', timestamp: new Date('2026-09-15T09:08:00.000Z') });

      const fp1 = service.getSignalFingerprint(bot, signal1);
      const fp2 = service.getSignalFingerprint(bot, signal2);

      // Both belong to the 09:00 - 09:15 15m candle boundary
      expect(fp1).toBe(fp2);
    });

    it('should generate different fingerprints for distinct candle boundaries', () => {
      const bot = createTestBot();
      const signal1 = createTestSignal({ timestamp: new Date('2026-09-15T09:05:00.000Z') });
      const signal2 = createTestSignal({ timestamp: new Date('2026-09-15T09:20:00.000Z') });

      const fp1 = service.getSignalFingerprint(bot, signal1);
      const fp2 = service.getSignalFingerprint(bot, signal2);

      expect(fp1).not.toBe(fp2);
    });
  });

  // G. Authoritative Order Quantity Resolution (P0 #4)
  describe('G. Authoritative Instrument Quantity Resolution', () => {
    it('should compute exact canonical quantities for NIFTY, BANKNIFTY, and BTCUSDT', () => {
      const botNifty = createTestBot({ symbol: 'NIFTY', lots: 2 });
      const instNifty = { symbol: 'NIFTY', lotSize: 65, minimumQuantity: 65, quantityPrecision: 0 } as any;
      expect(service.resolveBotOrderQuantity(botNifty, instNifty)).toBe(130);

      const botBank = createTestBot({ symbol: 'BANKNIFTY', lots: 3 });
      const instBank = { symbol: 'BANKNIFTY', lotSize: 15, minimumQuantity: 15, quantityPrecision: 0 } as any;
      expect(service.resolveBotOrderQuantity(botBank, instBank)).toBe(45);

      const botBtc = createTestBot({ symbol: 'BTCUSDT', lots: 5 });
      const instBtc = { symbol: 'BTCUSDT', lotSize: 0.001, minimumQuantity: 0.001, quantityPrecision: 3 } as any;
      expect(service.resolveBotOrderQuantity(botBtc, instBtc)).toBe(0.005);
    });

    it('should throw on invalid lots or unsupported instrument', () => {
      const botInvalid = createTestBot({ lots: 0 });
      const instNifty = { symbol: 'NIFTY', lotSize: 65 } as any;
      expect(() => service.resolveBotOrderQuantity(botInvalid, instNifty)).toThrow('INVALID_BOT_LOTS');
    });
  });

  // P0 #3: autoExecutePaper=false check before reservation
  describe('P0 #3. autoExecutePaper Guard', () => {
    it('should NOT consume an execution reservation when autoExecutePaper is false', async () => {
      const bot = createTestBot({ autoExecutePaper: false });
      jest.spyOn(service, 'listBots').mockResolvedValue([bot]);
      const reserveSpy = jest.spyOn(service, 'reserveExecutionLock');
      const signal = createTestSignal();

      await service.evaluateSignalForBots(signal);

      expect(reserveSpy).not.toHaveBeenCalled();
      expect(mockPaperTradingService.placeOrder).not.toHaveBeenCalled();
    });
  });

  // P1 #16: Test-only guard for deterministic signals
  describe('P1 #16. Production Guard for Deterministic Signals', () => {
    it('should throw error when deterministic signals are injected in production mode', () => {
      const originalNodeEnv = process.env.NODE_ENV;
      const originalAppEnv = process.env.APP_ENV;

      process.env.NODE_ENV = 'production';
      process.env.APP_ENV = 'production';

      try {
        expect(() => {
          SignalGenerator.generateSignal({
            symbol: 'NIFTY',
            executionCandles: [{ timestamp: new Date(), open: 24000, high: 24010, low: 23990, close: 24005, volume: 1000 }],
            strategyConfig: { deterministicSignal: { timestamp: new Date() } },
          });
        }).toThrow('DETERMINISTIC_SIGNAL_INJECTION_PROHIBITED');
      } finally {
        process.env.NODE_ENV = originalNodeEnv;
        process.env.APP_ENV = originalAppEnv;
      }
    });
  });
});
