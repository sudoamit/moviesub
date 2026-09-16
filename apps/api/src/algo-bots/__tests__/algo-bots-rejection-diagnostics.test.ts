import { AlgoBotsService, IAlgoBot } from '../algo-bots.service';
import { Direction, ISignalSetup, SignalGrade, SignalState } from '@quant/shared';

describe('Fix 177 — Diagnostic Rejection Gate Suite (NIFTY, BANKNIFTY, BTCUSDT)', () => {
  let algoBotsService: AlgoBotsService;
  let mockPaperTradingService: any;
  let mockAlertsService: any;

  beforeEach(() => {
    mockPaperTradingService = {
      getPortfolio: jest.fn().mockResolvedValue({ openPositions: [] }),
      getValidatedMarketPrice: jest
        .fn()
        .mockResolvedValue({ price: 24000.0, timestamp: new Date() }),
      placeOrder: jest.fn().mockResolvedValue({ id: 'pos_diag', entryPrice: 24000.0 }),
    };

    mockAlertsService = {
      sendAlert: jest.fn().mockResolvedValue({ success: true }),
    };

    algoBotsService = new AlgoBotsService(
      mockPaperTradingService,
      mockAlertsService,
      undefined,
      null as any,
    );
  });

  const createDefaultPresetBots = (): IAlgoBot[] => [
    {
      id: 'bot_nifty_smc_pro',
      name: 'NIFTY 15m Institutional Order Flow Scalper',
      symbol: 'NIFTY',
      direction: 'ANY',
      timeframe: '15m',
      minScore: 80,
      smcCondition: 'ORDER_BLOCK',
      lots: 1,
      autoExecutePaper: false,
      notifyWebhook: true,
      isActive: false,
      createdAt: new Date().toISOString(),
      triggerCount: 0,
    },
    {
      id: 'bot_banknifty_fvg',
      name: 'BANKNIFTY 15m Fair Value Gap Hunter',
      symbol: 'BANKNIFTY',
      direction: 'BEARISH',
      timeframe: '15m',
      minScore: 85,
      smcCondition: 'FVG',
      lots: 1,
      autoExecutePaper: false,
      notifyWebhook: true,
      isActive: false,
      createdAt: new Date().toISOString(),
      triggerCount: 0,
    },
    {
      id: 'bot_btc_liquidity_sweep',
      name: 'BTCUSDT 15m Liquidity Pool Sweeper',
      symbol: 'BTCUSDT',
      direction: 'BULLISH',
      timeframe: '15m',
      minScore: 75,
      smcCondition: 'LIQUIDITY_SWEEP',
      lots: 1,
      autoExecutePaper: false,
      notifyWebhook: false,
      isActive: false,
      createdAt: new Date().toISOString(),
      triggerCount: 0,
    },
  ];

  it('1. Proves why zero trades occurred with default unactivated seeded bots (BOT_INACTIVE & AUTO_EXECUTE_DISABLED)', async () => {
    const presetBots = createDefaultPresetBots();

    const sampleSignal: ISignalSetup = {
      id: 'sig_nifty_test',
      symbol: 'NIFTY',
      timeframe: '15m',
      direction: Direction.BULLISH,
      state: SignalState.ACTIVE,
      grade: SignalGrade.A_PLUS,
      score: 85,
      canonicalCandleTime: Date.now(),
      entryZone: { min: 23990, max: 24010, optimal: 24000 },
      stopLoss: 23950,
      takeProfits: { tp1: 24100, tp2: 24200, tp3: 24300 },
      riskRewardRatios: { rr1: 1.5, rr2: 2.5, rr3: 4.0 },
      reasoning: {} as any,
      scoreBreakdown: {} as any,
      triggerEvidence: {
        orderBlock: { matched: true, timestamp: new Date() },
      },
    };

    for (const bot of presetBots) {
      const diag = await algoBotsService.evaluateBotForSignalDiagnostics(bot, sampleSignal);
      console.log(`[DIAGNOSTIC UNCONFIGURED] ${bot.id} -> matches=${diag.matches}, reasons=${diag.reasons.join(', ')}`);
      expect(diag.matches).toBe(false);
      expect(diag.reasons).toContain('BOT_INACTIVE');
      expect(diag.reasons).toContain('AUTO_EXECUTE_DISABLED');
    }
  });

  it('2. Evaluates rejection gates for NIFTY, BANKNIFTY, BTCUSDT when activated', async () => {
    const niftyBot: IAlgoBot = {
      ...createDefaultPresetBots()[0],
      isActive: true,
      autoExecutePaper: true,
    };
    const bankniftyBot: IAlgoBot = {
      ...createDefaultPresetBots()[1],
      isActive: true,
      autoExecutePaper: true,
    };
    const btcBot: IAlgoBot = {
      ...createDefaultPresetBots()[2],
      isActive: true,
      autoExecutePaper: true,
    };

    const candleTime = Date.now();

    // NIFTY Signal missing ORDER_BLOCK evidence -> SMC_CONDITION_MISMATCH
    const niftySignalNoOB: ISignalSetup = {
      id: 'sig_nifty_no_ob',
      symbol: 'NIFTY',
      timeframe: '15m',
      direction: Direction.BULLISH,
      state: SignalState.ACTIVE,
      grade: SignalGrade.A_PLUS,
      score: 85,
      canonicalCandleTime: candleTime,
      entryZone: { min: 23990, max: 24010, optimal: 24000 },
      stopLoss: 23950,
      takeProfits: { tp1: 24100, tp2: 24200, tp3: 24300 },
      riskRewardRatios: { rr1: 1.5, rr2: 2.5, rr3: 4.0 },
      reasoning: {} as any,
      scoreBreakdown: {} as any,
      triggerEvidence: {
        orderBlock: { matched: false },
        fvg: { matched: true },
      },
    };

    const niftyDiag = await algoBotsService.evaluateBotForSignalDiagnostics(niftyBot, niftySignalNoOB);
    console.log(`[DIAGNOSTIC NIFTY] matches=${niftyDiag.matches}, reasons=${niftyDiag.reasons.join(', ')}`);
    expect(niftyDiag.matches).toBe(false);
    expect(niftyDiag.reasons).toContain('SMC_CONDITION_MISMATCH');

    // BANKNIFTY Signal with BULLISH direction when Bot requires BEARISH -> DIRECTION_MISMATCH
    const bankniftyBullSignal: ISignalSetup = {
      id: 'sig_banknifty_bull',
      symbol: 'BANKNIFTY',
      timeframe: '15m',
      direction: Direction.BULLISH,
      state: SignalState.ACTIVE,
      grade: SignalGrade.A_PLUS,
      score: 90,
      canonicalCandleTime: candleTime,
      entryZone: { min: 51000, max: 51050, optimal: 51025 },
      stopLoss: 50900,
      takeProfits: { tp1: 51200, tp2: 51400, tp3: 51600 },
      riskRewardRatios: { rr1: 1.5, rr2: 2.5, rr3: 4.0 },
      reasoning: {} as any,
      scoreBreakdown: {} as any,
      triggerEvidence: {
        fvg: { matched: true, timestamp: new Date() },
      },
    };

    const bankniftyDiag = await algoBotsService.evaluateBotForSignalDiagnostics(bankniftyBot, bankniftyBullSignal);
    console.log(`[DIAGNOSTIC BANKNIFTY] matches=${bankniftyDiag.matches}, reasons=${bankniftyDiag.reasons.join(', ')}`);
    expect(bankniftyDiag.matches).toBe(false);
    expect(bankniftyDiag.reasons).toContain('DIRECTION_MISMATCH');

    // BTCUSDT Signal satisfying all conditions -> ORDER_EXECUTED
    const btcValidSignal: ISignalSetup = {
      id: 'sig_btc_valid',
      symbol: 'BTCUSDT',
      timeframe: '15m',
      direction: Direction.BULLISH,
      state: SignalState.ACTIVE,
      grade: SignalGrade.A_PLUS,
      score: 80,
      canonicalCandleTime: candleTime,
      entryZone: { min: 64900, max: 65100, optimal: 65000 },
      stopLoss: 64000,
      takeProfits: { tp1: 66000, tp2: 67000, tp3: 68000 },
      riskRewardRatios: { rr1: 1.5, rr2: 2.5, rr3: 4.0 },
      reasoning: {} as any,
      scoreBreakdown: {} as any,
      triggerEvidence: {
        liquiditySweep: { matched: true, timestamp: new Date() },
      },
    };

    const btcDiag = await algoBotsService.evaluateBotForSignalDiagnostics(btcBot, btcValidSignal);
    console.log(`[DIAGNOSTIC BTCUSDT] matches=${btcDiag.matches}, reasons=${btcDiag.reasons.join(', ')}`);
    expect(btcDiag.matches).toBe(true);
    expect(btcDiag.reasons).toContain('ORDER_EXECUTED');
  });
});
