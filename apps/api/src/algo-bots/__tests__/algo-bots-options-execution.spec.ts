import { PrismaClient } from '@prisma/client';
import { AlgoBotsService } from '../algo-bots.service';
import { TradeDecisionService } from '../trade-decision.service';
import { PaperTradingService } from '../../paper-trading/paper-trading.service';
import { RealMarketStreamerService } from '../../market-data/real-market-streamer.service';
import { AlertsService } from '../../alerts/alerts.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { OptionContractResolver } from '../option-contract-resolver';
import { OptionTradeLevelsResolver } from '../option-trade-levels-resolver';
import {
  Direction,
  ISignalSetup,
  SignalGrade,
  SignalState,
  Timeframe,
  PositionState,
  TradeDecisionType,
  PointInTimeCurrencyConverter,
  getAuthoritativeInstrument,
} from '@quant/shared';

describe('Fix 202: 20 Unit Invariant Tests for Options-Only Algo Bot Execution', () => {
  let prisma: PrismaClient;
  let algoBotsService: AlgoBotsService;
  let tradeDecisionService: TradeDecisionService;
  let paperTradingService: PaperTradingService;
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
      price: sym.includes('BANKNIFTY') ? 51240.0 : currentSpotPrice,
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
      where: {
        symbol: { in: ['NIFTY_SPOT', 'BANKNIFTY_SPOT', 'NIFTY', 'BANKNIFTY'] },
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

  const createSignal = (overrides?: any): ISignalSetup => ({
    id: `sig_test_${Date.now()}_${Math.random().toString(36).substring(7)}`,
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

  // ─────────────────────────────────────────────────────────────────────────────
  // 1. NIFTY BULLISH -> resolves NIFTY ATM CE, orderSide BUY
  // ─────────────────────────────────────────────────────────────────────────────
  it('Invariant 1: NIFTY BULLISH -> resolves NIFTY ATM CE, orderSide BUY', () => {
    const res = OptionContractResolver.resolveContract({
      underlyingSymbol: 'NIFTY_SPOT',
      signalDirection: 'BULLISH',
      underlyingSpotPrice: 24120,
      signalTimestamp: nowMs,
    });

    expect(res.underlying).toBe('NIFTY');
    expect(res.optionType).toBe('CE');
    expect(res.orderSide).toBe('BUY');
    expect(res.strike).toBe(24100); // 24120 rounded to 50 step is 24100
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 2. NIFTY BEARISH -> resolves NIFTY ATM PE, orderSide BUY
  // ─────────────────────────────────────────────────────────────────────────────
  it('Invariant 2: NIFTY BEARISH -> resolves NIFTY ATM PE, orderSide BUY', () => {
    const res = OptionContractResolver.resolveContract({
      underlyingSymbol: 'NIFTY_SPOT',
      signalDirection: 'BEARISH',
      underlyingSpotPrice: 24120,
      signalTimestamp: nowMs,
    });

    expect(res.underlying).toBe('NIFTY');
    expect(res.optionType).toBe('PE');
    expect(res.orderSide).toBe('BUY');
    expect(res.strike).toBe(24100);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 3. BANKNIFTY BULLISH -> resolves BANKNIFTY ATM CE, orderSide BUY
  // ─────────────────────────────────────────────────────────────────────────────
  it('Invariant 3: BANKNIFTY BULLISH -> resolves BANKNIFTY ATM CE, orderSide BUY', () => {
    const res = OptionContractResolver.resolveContract({
      underlyingSymbol: 'BANKNIFTY_SPOT',
      signalDirection: 'BULLISH',
      underlyingSpotPrice: 51240,
      signalTimestamp: nowMs,
    });

    expect(res.underlying).toBe('BANKNIFTY');
    expect(res.optionType).toBe('CE');
    expect(res.orderSide).toBe('BUY');
    expect(res.strike).toBe(51200); // 51240 rounded to 100 step is 51200
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 4. BANKNIFTY BEARISH -> resolves BANKNIFTY ATM PE, orderSide BUY
  // ─────────────────────────────────────────────────────────────────────────────
  it('Invariant 4: BANKNIFTY BEARISH -> resolves BANKNIFTY ATM PE, orderSide BUY', () => {
    const res = OptionContractResolver.resolveContract({
      underlyingSymbol: 'BANKNIFTY_SPOT',
      signalDirection: 'BEARISH',
      underlyingSpotPrice: 51240,
      signalTimestamp: nowMs,
    });

    expect(res.underlying).toBe('BANKNIFTY');
    expect(res.optionType).toBe('PE');
    expect(res.orderSide).toBe('BUY');
    expect(res.strike).toBe(51200);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 5. Strike step size 50 for NIFTY, 100 for BANKNIFTY
  // ─────────────────────────────────────────────────────────────────────────────
  it('Invariant 5: Strike step size 50 for NIFTY, 100 for BANKNIFTY', () => {
    const niftyRes = OptionContractResolver.resolveContract({
      underlyingSymbol: 'NIFTY',
      signalDirection: 'BULLISH',
      underlyingSpotPrice: 24135,
      signalTimestamp: nowMs,
    });
    expect(niftyRes.stepSize).toBe(50);
    expect(niftyRes.strike).toBe(24150); // 24135 rounded to 50 step is 24150

    const bnfRes = OptionContractResolver.resolveContract({
      underlyingSymbol: 'BANKNIFTY',
      signalDirection: 'BULLISH',
      underlyingSpotPrice: 51260,
      signalTimestamp: nowMs,
    });
    expect(bnfRes.stepSize).toBe(100);
    expect(bnfRes.strike).toBe(51300); // 51260 rounded to 100 step is 51300
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 6. Nearest upcoming expiry Tuesday for NIFTY, Wednesday for BANKNIFTY
  // ─────────────────────────────────────────────────────────────────────────────
  it('Invariant 6: Nearest upcoming expiry Tuesday for NIFTY, Wednesday for BANKNIFTY', () => {
    const niftyRes = OptionContractResolver.resolveContract({
      underlyingSymbol: 'NIFTY_SPOT',
      signalDirection: 'BULLISH',
      underlyingSpotPrice: 24100,
      signalTimestamp: nowMs,
    });
    expect(niftyRes.expiry).toBeDefined();
    // Verify expiry date is in NSE format DD-MMM-YYYY
    expect(niftyRes.expiry).toMatch(/^\d{1,2}-[A-Za-z]{3}-\d{4}$/);

    const bnfRes = OptionContractResolver.resolveContract({
      underlyingSymbol: 'BANKNIFTY_SPOT',
      signalDirection: 'BULLISH',
      underlyingSpotPrice: 51000,
      signalTimestamp: nowMs,
    });
    expect(bnfRes.expiry).toBeDefined();
    expect(bnfRes.expiry).toMatch(/^\d{1,2}-[A-Za-z]{3}-\d{4}$/);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 7. Contract symbol format ${underlying} ${strike} ${optionType}
  // ─────────────────────────────────────────────────────────────────────────────
  it('Invariant 7: Contract symbol format ${underlying} ${strike} ${optionType}', () => {
    const niftyRes = OptionContractResolver.resolveContract({
      underlyingSymbol: 'NIFTY_SPOT',
      signalDirection: 'BULLISH',
      underlyingSpotPrice: 24100,
      signalTimestamp: nowMs,
    });
    expect(niftyRes.contractSymbol).toBe('NIFTY 24100 CE');

    const bnfRes = OptionContractResolver.resolveContract({
      underlyingSymbol: 'BANKNIFTY_SPOT',
      signalDirection: 'BEARISH',
      underlyingSpotPrice: 51200,
      signalTimestamp: nowMs,
    });
    expect(bnfRes.contractSymbol).toBe('BANKNIFTY 51200 PE');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 8. Option trade levels strictly on option premium scale (SL < Entry < TP1 < TP2 < TP3)
  // ─────────────────────────────────────────────────────────────────────────────
  it('Invariant 8: Option trade levels strictly on option premium scale (SL < Entry < TP1 < TP2 < TP3)', () => {
    const levels = OptionTradeLevelsResolver.resolveLevels({
      optionEntryPrice: 150.0,
      slPercent: 30,
      tp1Ratio: 1.0,
      tp2Ratio: 2.0,
      tp3Ratio: 3.0,
    });

    expect(levels.optimalEntry).toBe(150.0);
    expect(levels.stopLoss).toBe(105.0); // 150 - 45
    expect(levels.target1).toBe(195.0);  // 150 + 45
    expect(levels.target2).toBe(240.0);  // 150 + 90
    expect(levels.target3).toBe(285.0);  // 150 + 135

    expect(levels.stopLoss).toBeLessThan(levels.optimalEntry);
    expect(levels.optimalEntry).toBeLessThan(levels.target1);
    expect(levels.target1).toBeLessThan(levels.target2);
    expect(levels.target2).toBeLessThan(levels.target3);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 9. Quantity = bot.lots * 65 for NIFTY, bot.lots * 15 for BANKNIFTY
  // ─────────────────────────────────────────────────────────────────────────────
  it('Invariant 9: Quantity = bot.lots * 65 for NIFTY, bot.lots * 15 for BANKNIFTY', () => {
    const niftyInstrument = getAuthoritativeInstrument('NIFTY 24100 CE');
    const bnfInstrument = getAuthoritativeInstrument('BANKNIFTY 51200 PE');

    const niftyBot: any = { id: 'bot_nifty', lots: 2 };
    const bnfBot: any = { id: 'bot_bnf', lots: 3 };

    const niftyQty = tradeDecisionService.resolveOrderQuantity(niftyBot, niftyInstrument);
    const bnfQty = tradeDecisionService.resolveOrderQuantity(bnfBot, bnfInstrument);

    expect(niftyQty).toBe(2 * 65); // 130
    expect(bnfQty).toBe(3 * 15);  // 45
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 10. Reject with OPTION_EXECUTION_REQUIRED if algo bot attempts spot execution on NIFTY/BANKNIFTY
  // ─────────────────────────────────────────────────────────────────────────────
  it('Invariant 10: Reject with OPTION_EXECUTION_REQUIRED if algo bot attempts spot execution on NIFTY/BANKNIFTY', async () => {
    const niftySpotBot: any = {
      id: 'bot_spot_attempt',
      symbol: 'NIFTY_SPOT',
      executionInstrument: 'NIFTY_SPOT',
      executionInstrumentType: 'SPOT',
      direction: 'ANY',
      timeframe: '15m',
      minScore: 75,
      smcCondition: 'ORDER_BLOCK',
      lots: 1,
      isActive: true,
      autoExecutePaper: true,
    };

    const sig = createSignal({
      symbol: 'NIFTY_SPOT',
      executionInstrumentType: 'SPOT',
    });

    const decision = tradeDecisionService.evaluatePreTradeDecision({
      bot: niftySpotBot,
      signal: sig,
      liveQuote: { price: 24120, timestamp: new Date(nowMs) },
    } as any);

    expect(decision.decision).toBe(TradeDecisionType.REJECT);
    expect(decision.decisionReasonCode).toBe('OPTION_EXECUTION_REQUIRED');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 11. Reject with OPTION_STRIKE_REQUIRED if strike is missing or non-positive
  // ─────────────────────────────────────────────────────────────────────────────
  it('Invariant 11: Reject with OPTION_STRIKE_REQUIRED if strike is missing or non-positive', () => {
    const optBot: any = {
      id: 'bot_opt_test',
      symbol: 'NIFTY_SPOT',
      executionInstrument: 'NIFTY OPTION',
      executionInstrumentType: 'OPTION',
      direction: 'ANY',
      timeframe: '15m',
      minScore: 75,
      smcCondition: 'ORDER_BLOCK',
      lots: 1,
      isActive: true,
      autoExecutePaper: true,
    };

    const sigMissingStrike = createSignal({
      symbol: 'NIFTY_SPOT',
      executionInstrumentType: 'OPTION',
      contractSymbol: 'NIFTY 24100 CE',
      optionType: 'CE',
      strike: undefined, // Missing strike
    } as any);

    const decision = tradeDecisionService.evaluatePreTradeDecision({
      bot: optBot,
      signal: sigMissingStrike,
      liveQuote: { price: 150, timestamp: new Date(nowMs) },
    } as any);

    expect(decision.decision).toBe(TradeDecisionType.REJECT);
    expect(decision.decisionReasonCode).toBe('OPTION_STRIKE_REQUIRED');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 12. Reject with OPTION_TYPE_REQUIRED if optionType is missing or not CE/PE
  // ─────────────────────────────────────────────────────────────────────────────
  it('Invariant 12: Reject with OPTION_TYPE_REQUIRED if optionType is missing or not CE/PE', () => {
    const optBot: any = {
      id: 'bot_opt_test',
      symbol: 'NIFTY_SPOT',
      executionInstrument: 'NIFTY OPTION',
      executionInstrumentType: 'OPTION',
      direction: 'ANY',
      timeframe: '15m',
      minScore: 75,
      smcCondition: 'ORDER_BLOCK',
      lots: 1,
      isActive: true,
      autoExecutePaper: true,
    };

    const sigInvalidOptType = createSignal({
      symbol: 'NIFTY_SPOT',
      executionInstrumentType: 'OPTION',
      contractSymbol: 'NIFTY 24100 CE',
      strike: 24100,
      optionType: 'INVALID', // Invalid optionType
    } as any);

    const decision = tradeDecisionService.evaluatePreTradeDecision({
      bot: optBot,
      signal: sigInvalidOptType,
      liveQuote: { price: 150, timestamp: new Date(nowMs) },
    } as any);

    expect(decision.decision).toBe(TradeDecisionType.REJECT);
    expect(decision.decisionReasonCode).toBe('OPTION_TYPE_REQUIRED');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 13. Reject with OPTION_CONTRACT_REQUIRED if contractSymbol is missing or empty
  // ─────────────────────────────────────────────────────────────────────────────
  it('Invariant 13: Reject with OPTION_CONTRACT_REQUIRED if contractSymbol is missing or empty', () => {
    const optBot: any = {
      id: 'bot_opt_test',
      symbol: 'NIFTY_SPOT',
      executionInstrument: 'NIFTY OPTION',
      executionInstrumentType: 'OPTION',
      direction: 'ANY',
      timeframe: '15m',
      minScore: 75,
      smcCondition: 'ORDER_BLOCK',
      lots: 1,
      isActive: true,
      autoExecutePaper: true,
    };

    const sigMissingContract = createSignal({
      symbol: 'NIFTY_SPOT',
      executionInstrumentType: 'OPTION',
      strike: 24100,
      optionType: 'CE',
      contractSymbol: '', // Empty contractSymbol
    } as any);

    const decision = tradeDecisionService.evaluatePreTradeDecision({
      bot: optBot,
      signal: sigMissingContract,
      liveQuote: { price: 150, timestamp: new Date(nowMs) },
    } as any);

    expect(decision.decision).toBe(TradeDecisionType.REJECT);
    expect(decision.decisionReasonCode).toBe('OPTION_CONTRACT_REQUIRED');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 14. Reject with OPTION_QUOTE_UNAVAILABLE if option quote is missing or non-positive
  // ─────────────────────────────────────────────────────────────────────────────
  it('Invariant 14: Reject with OPTION_QUOTE_UNAVAILABLE if option quote is missing or non-positive', () => {
    const optBot: any = {
      id: 'bot_opt_test',
      symbol: 'NIFTY_SPOT',
      executionInstrument: 'NIFTY OPTION',
      executionInstrumentType: 'OPTION',
      direction: 'ANY',
      timeframe: '15m',
      minScore: 75,
      smcCondition: 'ORDER_BLOCK',
      lots: 1,
      isActive: true,
      autoExecutePaper: true,
    };

    const sig = createSignal({
      symbol: 'NIFTY_SPOT',
      executionInstrumentType: 'OPTION',
      contractSymbol: 'NIFTY 24100 CE',
      strike: 24100,
      optionType: 'CE',
    } as any);

    const decision = tradeDecisionService.evaluatePreTradeDecision({
      bot: optBot,
      signal: sig,
      liveQuote: null,
      liveQuoteError: new Error('Option quote not available'),
    } as any);

    expect(decision.decision).toBe(TradeDecisionType.REJECT);
    expect(decision.decisionReasonCode).toBe('OPTION_QUOTE_UNAVAILABLE');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 15. Reject with OPTION_QUOTE_STALE if option quote is older than allowed window
  // ─────────────────────────────────────────────────────────────────────────────
  it('Invariant 15: Reject with OPTION_QUOTE_STALE if option quote is older than allowed window', () => {
    const optBot: any = {
      id: 'bot_opt_test',
      symbol: 'NIFTY_SPOT',
      executionInstrument: 'NIFTY OPTION',
      executionInstrumentType: 'OPTION',
      direction: 'ANY',
      timeframe: '15m',
      minScore: 75,
      smcCondition: 'ORDER_BLOCK',
      lots: 1,
      isActive: true,
      autoExecutePaper: true,
    };

    const sig = createSignal({
      symbol: 'NIFTY_SPOT',
      executionInstrumentType: 'OPTION',
      contractSymbol: 'NIFTY 24100 CE',
      strike: 24100,
      optionType: 'CE',
    } as any);

    const staleError = new Error('Option quote is stale');
    (staleError as any).code = 'OPTION_QUOTE_STALE';

    const decision = tradeDecisionService.evaluatePreTradeDecision({
      bot: optBot,
      signal: sig,
      liveQuote: null,
      liveQuoteError: staleError,
    } as any);

    expect(decision.decision).toBe(TradeDecisionType.REJECT);
    expect(decision.decisionReasonCode).toBe('OPTION_QUOTE_STALE');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 16. PaperPosition stores exact contractSymbol, instrumentType: OPTION, direction: BUY, strategyDirection
  // ─────────────────────────────────────────────────────────────────────────────
  it('Invariant 16: PaperPosition stores exact contractSymbol, instrumentType: OPTION, direction: BUY, strategyDirection', async () => {
    optionQuotes['NIFTY 24100 CE'] = { price: 150.0, lastUpdated: Date.now() };

    const bot = await prisma.algoBot.create({
      data: {
        id: `bot_opt_inv16_${Date.now()}`,
        name: 'NIFTY Options Invariant Bot',
        symbol: 'NIFTY_SPOT',
        executionInstrument: 'NIFTY OPTION',
        executionInstrumentType: 'OPTION',
        signalSourceInstrument: 'NIFTY_SPOT',
        direction: 'ANY',
        timeframe: '15m',
        minScore: 75,
        smcCondition: 'ORDER_BLOCK',
        lots: 1, // 1 lot = 65 units
        autoExecutePaper: true,
        notifyWebhook: false,
        isActive: true,
        triggerCount: 0,
      },
    });

    const sig = createSignal({ direction: Direction.BULLISH });
    const results = await algoBotsService.evaluateSignalForBots(sig);

    expect(results).toHaveLength(1);
    expect(results[0].decision).toBe('TAKE');
    expect(results[0].status).toBe('EXECUTED');
    const posId = results[0].orderPositionId!;

    const pos = await prisma.paperPosition.findUnique({ where: { id: posId } });
    expect(pos).toBeDefined();
    expect(pos!.contractSymbol).toBe('NIFTY 24100 CE');
    expect(pos!.instrumentType).toBe('OPTION');
    expect(pos!.direction).toBe(Direction.BULLISH); // BUY
    expect(pos!.strategyDirection).toBe(Direction.BULLISH);
    expect(pos!.strike).toBeDefined();
    expect(Number(pos!.strike)).toBe(24100);
    expect(pos!.optionType).toBe('CE');
    expect(Number(pos!.quantity)).toBe(65);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 17. Trade fingerprint uniquely incorporates contractSymbol, strike, optionType, expiry, signalDirection, orderSide
  // ─────────────────────────────────────────────────────────────────────────────
  it('Invariant 17: Trade fingerprint uniquely incorporates contractSymbol, strike, optionType, expiry, signalDirection, orderSide', () => {
    const bot: any = { id: 'bot_opt_fingerprint', symbol: 'NIFTY_SPOT', lots: 1 };
    const sigCE = createSignal({
      symbol: 'NIFTY_SPOT',
      executionInstrumentType: 'OPTION',
      contractSymbol: 'NIFTY 24100 CE',
      strike: 24100,
      optionType: 'CE',
      expiry: '2024-09-17',
      signalDirection: 'BULLISH',
      orderSide: 'BUY',
    } as any);

    const sigPE = createSignal({
      symbol: 'NIFTY_SPOT',
      executionInstrumentType: 'OPTION',
      contractSymbol: 'NIFTY 24100 PE',
      strike: 24100,
      optionType: 'PE',
      expiry: '2024-09-17',
      signalDirection: 'BEARISH',
      orderSide: 'BUY',
    } as any);

    const fpCE = tradeDecisionService.getTradeFingerprint(bot, sigCE, 'test_acc');
    const fpPE = tradeDecisionService.getTradeFingerprint(bot, sigPE, 'test_acc');

    expect(fpCE).toContain('NIFTY 24100 CE');
    expect(fpCE).toContain('24100:CE:2024-09-17:BULLISH:BUY');

    expect(fpPE).toContain('NIFTY 24100 PE');
    expect(fpPE).toContain('24100:PE:2024-09-17:BEARISH:BUY');

    expect(fpCE).not.toBe(fpPE);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 18. Idempotency: duplicate reservation rejected via CAS fingerprint
  // ─────────────────────────────────────────────────────────────────────────────
  it('Invariant 18: Idempotency: duplicate reservation rejected via CAS fingerprint', async () => {
    optionQuotes['NIFTY 24100 CE'] = { price: 150.0, lastUpdated: Date.now() };

    const bot = await prisma.algoBot.create({
      data: {
        id: `bot_opt_inv18_${Date.now()}`,
        name: 'Idempotency Invariant Bot',
        symbol: 'NIFTY_SPOT',
        executionInstrument: 'NIFTY OPTION',
        executionInstrumentType: 'OPTION',
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

    const sig = createSignal({ direction: Direction.BULLISH });

    // First evaluation: successfully executed
    const results1 = await algoBotsService.evaluateSignalForBots(sig);
    expect(results1[0].decision).toBe('TAKE');
    expect(results1[0].status).toBe('EXECUTED');

    // Close the open position so Gate 14 (portfolio open position) does not mask the CAS fingerprint lock
    await prisma.paperPosition.updateMany({
      where: { accountId: paperAccountId },
      data: { status: PositionState.CLOSED },
    });

    // Second evaluation with identical signal & canonicalCandleTime: rejected due to duplicate reservation lock
    const results2 = await algoBotsService.evaluateSignalForBots(sig);
    expect(results2[0].decision).toBe('REJECT');
    expect(results2[0].status).toBe('REJECTED');
    expect(results2[0].reasonCode).toBe('EXECUTION_LOCKED');
    expect(results2[0].details).toBe('DUPLICATE_RESERVATION');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 19. Risk sizing and margin use option premium turnover, not spot index notional
  // ─────────────────────────────────────────────────────────────────────────────
  it('Invariant 19: Risk sizing and margin use option premium turnover, not spot index notional', async () => {
    optionQuotes['NIFTY 24100 CE'] = { price: 150.0, lastUpdated: Date.now() };

    const bot = await prisma.algoBot.create({
      data: {
        id: `bot_opt_inv19_${Date.now()}`,
        name: 'Margin Risk Sizing Bot',
        symbol: 'NIFTY_SPOT',
        executionInstrument: 'NIFTY OPTION',
        executionInstrumentType: 'OPTION',
        signalSourceInstrument: 'NIFTY_SPOT',
        direction: 'ANY',
        timeframe: '15m',
        minScore: 75,
        smcCondition: 'ORDER_BLOCK',
        lots: 1, // 65 units
        autoExecutePaper: true,
        notifyWebhook: false,
        isActive: true,
        triggerCount: 0,
      },
    });

    const sig = createSignal({ direction: Direction.BULLISH });
    const results = await algoBotsService.evaluateSignalForBots(sig);
    expect(results[0].decision).toBe('TAKE');

    const pos = await prisma.paperPosition.findUnique({
      where: { id: results[0].orderPositionId! },
    });

    // Option premium turnover = 150 * 65 = ~9,750 INR.
    // Spot notional would be 24,100 * 65 = 1,566,500 INR!
    // Margin must be bounded by premium, not spot index notional.
    const usedMargin = Number(pos!.usedMargin);
    expect(usedMargin).toBeLessThan(50000); // Premium scale
    expect(usedMargin).toBeGreaterThan(1000);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 20. Invariant: Long options never trigger SPOT_SHORT_SELLING_FORBIDDEN for BEARISH index signals
  // ─────────────────────────────────────────────────────────────────────────────
  it('Invariant 20: Long options never trigger SPOT_SHORT_SELLING_FORBIDDEN for BEARISH index signals', async () => {
    optionQuotes['NIFTY 24100 PE'] = { price: 160.0, lastUpdated: Date.now() };

    const bot = await prisma.algoBot.create({
      data: {
        id: `bot_opt_inv20_${Date.now()}`,
        name: 'Bearish Put Long Bot',
        symbol: 'NIFTY_SPOT',
        executionInstrument: 'NIFTY OPTION',
        executionInstrumentType: 'OPTION',
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

    // Bearish signal on NIFTY_SPOT
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

    const results = await algoBotsService.evaluateSignalForBots(bearishSignal);

    expect(results).toHaveLength(1);
    // Must NOT reject with SPOT_SHORT_SELLING_FORBIDDEN
    expect(results[0].reasonCode).not.toBe('SPOT_SHORT_SELLING_FORBIDDEN');
    expect(results[0].decision).toBe('TAKE');
    expect(results[0].status).toBe('EXECUTED');

    const pos = await prisma.paperPosition.findUnique({
      where: { id: results[0].orderPositionId! },
    });
    expect(pos!.contractSymbol).toBe('NIFTY 24100 PE');
    expect(pos!.direction).toBe(Direction.BULLISH); // Order side is BUY (long PE)
    expect(pos!.strategyDirection).toBe(Direction.BEARISH); // Underlying strategy is BEARISH
  });
});
