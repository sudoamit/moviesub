import { Test, TestingModule } from '@nestjs/testing';
import { AlgoBotsService, IAlgoBot } from '../algo-bots.service';
import { PaperTradingService } from '../../paper-trading/paper-trading.service';
import { AlertsService } from '../../alerts/alerts.service';
import { Direction, ISignalSetup, MarketDataUnavailableError, SignalGrade, SignalState } from '@quant/shared';

describe('AlgoBotsService — Strategy Condition Enforcement & Execution Pipeline (Requirements A-L)', () => {
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
    reasons: ['HTF_BULLISH_ALIGNED', 'BULLISH_ORDER_BLOCK_TAP'],
    timestamp: new Date('2026-09-15T09:00:00.000Z'),
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

  // A. Matching symbol/direction/score/timeframe + SMC condition executes
  it('A. Matching symbol/direction/score/timeframe + SMC condition executes order', async () => {
    const bot = createTestBot();
    (service as any).bots = [bot];
    const signal = createTestSignal();

    await service.evaluateSignalForBots(signal);

    expect(mockPaperTradingService.placeOrder).toHaveBeenCalledTimes(1);
    expect(mockPaperTradingService.placeOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        symbol: 'NIFTY',
        direction: 'BUY',
        quantity: 65,
        signalPrice: 24000,
      }),
    );
  });

  // B. Wrong SMC condition does NOT execute
  it('B. Wrong SMC condition does NOT execute', async () => {
    const bot = createTestBot({ smcCondition: 'FVG' });
    (service as any).bots = [bot];
    const signal = createTestSignal({
      scoreBreakdown: { orderBlock: 20, fvg: 0 } as any,
      reasoning: { triggerReason: 'Order block tap', summary: 'OB' } as any,
      reasons: ['ORDER_BLOCK_TAP'],
    });

    await service.evaluateSignalForBots(signal);

    expect(mockPaperTradingService.placeOrder).not.toHaveBeenCalled();
  });

  // C. Wrong timeframe does NOT execute
  it('C. Wrong timeframe does NOT execute', async () => {
    const bot = createTestBot({ timeframe: '15m' });
    (service as any).bots = [bot];
    const signal = createTestSignal({ timeframe: '1h' });

    await service.evaluateSignalForBots(signal);

    expect(mockPaperTradingService.placeOrder).not.toHaveBeenCalled();
  });

  // D. Wrong direction does NOT execute
  it('D. Wrong direction does NOT execute', async () => {
    const bot = createTestBot({ direction: 'BEARISH' });
    (service as any).bots = [bot];
    const signal = createTestSignal({ direction: Direction.BULLISH });

    await service.evaluateSignalForBots(signal);

    expect(mockPaperTradingService.placeOrder).not.toHaveBeenCalled();
  });

  // E. Below min-score does NOT execute
  it('E. Below min-score does NOT execute', async () => {
    const bot = createTestBot({ minScore: 90 });
    (service as any).bots = [bot];
    const signal = createTestSignal({ score: 80 });

    await service.evaluateSignalForBots(signal);

    expect(mockPaperTradingService.placeOrder).not.toHaveBeenCalled();
  });

  // F. Duplicate same signal does NOT execute twice
  it('F. Duplicate same signal does NOT execute twice', async () => {
    const bot = createTestBot();
    (service as any).bots = [bot];
    const signal = createTestSignal();

    await service.evaluateSignalForBots(signal);
    await service.evaluateSignalForBots(signal);

    expect(mockPaperTradingService.placeOrder).toHaveBeenCalledTimes(1);
  });

  // G. Concurrent evaluation of the same signal results in exactly one placeOrder() call
  it('G. Concurrent evaluation of the same signal results in exactly one placeOrder() call', async () => {
    const bot = createTestBot();
    (service as any).bots = [bot];
    const signal = createTestSignal();

    await Promise.all([
      service.evaluateSignalForBots(signal),
      service.evaluateSignalForBots(signal),
    ]);

    expect(mockPaperTradingService.placeOrder).toHaveBeenCalledTimes(1);
  });

  // H. Two different signals may execute when business rules permit
  it('H. Two different signals may execute when business rules permit', async () => {
    const bot = createTestBot();
    (service as any).bots = [bot];

    const signal1 = createTestSignal({
      id: 'sig_1',
      timestamp: new Date('2026-09-15T09:00:00.000Z'),
    });
    const signal2 = createTestSignal({
      id: 'sig_2',
      timestamp: new Date('2026-09-15T09:15:00.000Z'),
    });

    await service.evaluateSignalForBots(signal1);

    // Mock portfolio to show first trade closed so second trade is permitted
    mockPaperTradingService.getPortfolio.mockResolvedValue({ openPositions: [] });
    await service.evaluateSignalForBots(signal2);

    expect(mockPaperTradingService.placeOrder).toHaveBeenCalledTimes(2);
  });

  // I. Inactive bot never executes
  it('I. Inactive bot never executes', async () => {
    const bot = createTestBot({ isActive: false });
    (service as any).bots = [bot];
    const signal = createTestSignal();

    await service.evaluateSignalForBots(signal);

    expect(mockPaperTradingService.placeOrder).not.toHaveBeenCalled();
  });

  // J. autoExecutePaper=false never executes
  it('J. autoExecutePaper=false never executes order but increments triggerCount', async () => {
    const bot = createTestBot({ autoExecutePaper: false });
    (service as any).bots = [bot];
    const signal = createTestSignal();

    await service.evaluateSignalForBots(signal);

    expect(bot.triggerCount).toBe(1);
    expect(mockPaperTradingService.placeOrder).not.toHaveBeenCalled();
  });

  // K. Malformed / NO_TRADE signal never executes
  it('K. Malformed / NO_TRADE signal never executes', async () => {
    const bot = createTestBot();
    (service as any).bots = [bot];

    const neutralSignal = createTestSignal({ direction: Direction.NEUTRAL });
    const noTradeGradeSignal = createTestSignal({ grade: SignalGrade.NO_TRADE });
    const missingSlSignal = createTestSignal({ stopLoss: 0 });

    await service.evaluateSignalForBots(neutralSignal);
    await service.evaluateSignalForBots(noTradeGradeSignal);
    await service.evaluateSignalForBots(missingSlSignal);

    expect(mockPaperTradingService.placeOrder).not.toHaveBeenCalled();
  });

  // L. Stale / missing live market data causes fail-closed behavior
  it('L. Stale / missing live market data causes fail-closed behavior', async () => {
    const bot = createTestBot();
    (service as any).bots = [bot];
    const signal = createTestSignal();

    mockPaperTradingService.getValidatedMarketPrice.mockRejectedValue(
      new MarketDataUnavailableError('NIFTY', 'Stream disconnected'),
    );

    await service.evaluateSignalForBots(signal);

    expect(mockPaperTradingService.placeOrder).not.toHaveBeenCalled();
  });
});
