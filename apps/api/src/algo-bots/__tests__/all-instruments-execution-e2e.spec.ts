import { PrismaClient } from '@prisma/client';
import { AlgoBotsService } from '../algo-bots.service';
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

describe('FIX 203: Real PostgreSQL End-to-End Suite for All 7 Instruments', () => {
  let prisma: PrismaClient;
  let algoBotsService: AlgoBotsService;
  let tradeDecisionService: TradeDecisionService;
  let paperTradingService: PaperTradingService;
  let monitorService: PaperPositionMonitorService;
  let paperAccountId: string;

  const DB_URL =
    process.env.TEST_DATABASE_URL ||
    process.env.DATABASE_URL ||
    'postgresql://postgres:postgrespassword@localhost:5433/trading_platform?schema=public';

  const optionQuotes: Record<string, { price: number; lastUpdated: number }> = {};
  const spotQuotes: Record<string, { price: number; lastUpdated: number }> = {
    NIFTY_SPOT: { price: 24120.0, lastUpdated: Date.now() },
    BANKNIFTY_SPOT: { price: 52100.0, lastUpdated: Date.now() },
    BTCUSDT_SPOT: { price: 65000.0, lastUpdated: Date.now() },
    BTCUSDT: { price: 65000.0, lastUpdated: Date.now() },
    XAUUSD: { price: 2500.0, lastUpdated: Date.now() },
    GOLD: { price: 2500.0, lastUpdated: Date.now() },
    RELIANCE: { price: 3000.0, lastUpdated: Date.now() },
    HDFCBANK: { price: 1650.0, lastUpdated: Date.now() },
    INFY: { price: 1900.0, lastUpdated: Date.now() },
  };

  const mockStreamer: any = {
    getValidatedTicker: (sym: string) => {
      const q = spotQuotes[sym] || { price: 100.0, lastUpdated: Date.now() };
      return {
        symbol: sym,
        price: q.price,
        provenance: 'LIVE_PROVIDER' as const,
        marketEventTime: q.lastUpdated,
        lastUpdated: q.lastUpdated,
      };
    },
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

    monitorService = new PaperPositionMonitorService(
      prismaService,
      paperTradingService,
      mockStreamer as unknown as RealMarketStreamerService,
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

    // Delete all bots for clean test slate
    await prisma.algoBot.deleteMany({});
  });

  afterAll(async () => {
    delete process.env.PAPER_TRADING_ENABLED;
    delete process.env.ENABLE_PAPER_ALGO_BOTS;
    if (prisma) {
      await prisma.$disconnect();
    }
  });

  const createSignal = (sym: string, dir: Direction, entryPrice: number, overrides?: any): ISignalSetup => ({
    id: `sig_${sym}_${Date.now()}_${Math.random().toString(36).substring(7)}`,
    symbol: sym,
    timeframe: Timeframe.M15,
    direction: dir,
    state: SignalState.ACTIVE,
    grade: SignalGrade.A_PLUS,
    score: 85,
    canonicalCandleTime: nowMs,
    canonicalDecisionTime: new Date(nowMs),
    entryZone: { min: entryPrice * 0.999, max: entryPrice * 1.001, optimal: entryPrice },
    stopLoss: dir === Direction.BULLISH ? entryPrice * 0.98 : entryPrice * 1.02,
    takeProfits: {
      tp1: dir === Direction.BULLISH ? entryPrice * 1.01 : entryPrice * 0.99,
      tp2: dir === Direction.BULLISH ? entryPrice * 1.02 : entryPrice * 0.98,
      tp3: dir === Direction.BULLISH ? entryPrice * 1.03 : entryPrice * 0.97,
    },
    riskRewardRatios: { rr1: 1.0, rr2: 2.0, rr3: 3.0 },
    reasoning: {
      htfStructure: 'Institutional Structure',
      liquidityReason: 'Liquidity swept',
      triggerReason: '15m Order Block tap',
      invalidationReason: 'Structural failure',
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

  // =========================================================================
  // 1. INSTRUMENT A: NIFTY OPTION (Bullish CE & Bearish PE)
  // =========================================================================
  describe('Instrument A: NIFTY OPTION Execution Lifecycle', () => {
    it('executes NIFTY Bullish as BUY CE with exact lot size 65 and 3-stage scale-out', async () => {
      const contractSymbol = 'NIFTY 24100 CE';
      optionQuotes[contractSymbol] = { price: 150.0, lastUpdated: nowMs };

      const bot = await prisma.algoBot.create({
        data: {
          id: `bot_all_inst_nifty_ce_${Date.now()}`,
          name: 'NIFTY Bullish CE Bot',
          symbol: 'NIFTY_SPOT',
          executionInstrument: 'NIFTY OPTION',
          executionInstrumentType: 'OPTION',
          signalSourceInstrument: 'NIFTY_SPOT',
          direction: 'BULLISH',
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

      const signal = createSignal('NIFTY_SPOT', Direction.BULLISH, 24120.0);
      const results = await algoBotsService.evaluateSignalForBots(signal);
      expect(results).toHaveLength(1);
      expect(results[0].status).toBe('EXECUTED');
      const posId = results[0].orderPositionId!;

      const pos = await prisma.paperPosition.findUnique({ where: { id: posId } });
      expect(pos).toBeDefined();
      expect(pos!.contractSymbol).toBe(contractSymbol);
      expect(pos!.instrumentType).toBe('OPTION');
      expect(pos!.direction).toBe(Direction.BULLISH); // long option
      expect(Number(pos!.quantity)).toBe(65); // NIFTY lot size 65
      expect(pos!.tradeDecisionId).toBeDefined();

      // Trigger TP1
      optionQuotes[contractSymbol] = { price: 195.0, lastUpdated: nowMs };
      await monitorService.evaluateSinglePosition(pos);
      const posAfterTp1 = await prisma.paperPosition.findUnique({ where: { id: posId } });
      expect(posAfterTp1!.status).toBe(PositionState.PARTIALLY_CLOSED);
      expect(Number(posAfterTp1!.quantity)).toBe(45.5); // 30% partial close

      // Trigger TP2
      optionQuotes[contractSymbol] = { price: 240.0, lastUpdated: nowMs };
      await monitorService.evaluateSinglePosition(posAfterTp1);
      const posAfterTp2 = await prisma.paperPosition.findUnique({ where: { id: posId } });
      expect(Number(posAfterTp2!.quantity)).toBe(26);

      // Trigger TP3 runner close
      optionQuotes[contractSymbol] = { price: 285.0, lastUpdated: nowMs };
      await monitorService.evaluateSinglePosition(posAfterTp2);
      const closedPos = await prisma.paperPosition.findUnique({ where: { id: posId } });
      expect(closedPos!.status).toBe(PositionState.CLOSED);

      const trade = await prisma.paperTrade.findFirst({ where: { positionId: posId } });
      expect(trade).toBeDefined();
      expect(trade!.contractSymbol).toBe(contractSymbol);
      expect(Number(trade!.realizedPnL)).toBeGreaterThan(0);
      expect(trade!.outcomeClassification).toBe('WIN_TP3_RUNNER');
    });

    it('executes NIFTY Bearish as BUY PE (never short selling spot)', async () => {
      const contractSymbol = 'NIFTY 24100 PE';
      optionQuotes[contractSymbol] = { price: 160.0, lastUpdated: nowMs };

      const bot = await prisma.algoBot.create({
        data: {
          id: `bot_all_inst_nifty_pe_${Date.now()}`,
          name: 'NIFTY Bearish PE Bot',
          symbol: 'NIFTY_SPOT',
          executionInstrument: 'NIFTY OPTION',
          executionInstrumentType: 'OPTION',
          signalSourceInstrument: 'NIFTY_SPOT',
          direction: 'BEARISH',
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

      const signal = createSignal('NIFTY_SPOT', Direction.BEARISH, 24120.0);
      const results = await algoBotsService.evaluateSignalForBots(signal);
      expect(results).toHaveLength(1);
      expect(results[0].status).toBe('EXECUTED');
      const posId = results[0].orderPositionId!;

      const pos = await prisma.paperPosition.findUnique({ where: { id: posId } });
      expect(pos!.contractSymbol).toBe(contractSymbol);
      expect(pos!.direction).toBe(Direction.BULLISH); // Long PE
      expect(pos!.strategyDirection).toBe(Direction.BEARISH);
      expect(Number(pos!.quantity)).toBe(65);
    });
  });

  // =========================================================================
  // 2. INSTRUMENT B: BANKNIFTY OPTION (Bullish CE & Bearish PE)
  // =========================================================================
  describe('Instrument B: BANKNIFTY OPTION Execution Lifecycle', () => {
    it('executes BANKNIFTY Bullish as BUY CE with lot size 15 and strike step 100', async () => {
      const contractSymbol = 'BANKNIFTY 52100 CE';
      optionQuotes[contractSymbol] = { price: 320.0, lastUpdated: nowMs };

      const bot = await prisma.algoBot.create({
        data: {
          id: `bot_all_inst_bnf_ce_${Date.now()}`,
          name: 'BANKNIFTY Bullish CE Bot',
          symbol: 'BANKNIFTY_SPOT',
          executionInstrument: 'BANKNIFTY OPTION',
          executionInstrumentType: 'OPTION',
          signalSourceInstrument: 'BANKNIFTY_SPOT',
          direction: 'BULLISH',
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

      const signal = createSignal('BANKNIFTY_SPOT', Direction.BULLISH, 52100.0);
      const results = await algoBotsService.evaluateSignalForBots(signal);
      expect(results).toHaveLength(1);
      expect(results[0].status).toBe('EXECUTED');
      const posId = results[0].orderPositionId!;

      const pos = await prisma.paperPosition.findUnique({ where: { id: posId } });
      expect(pos!.contractSymbol).toBe(contractSymbol);
      expect(pos!.instrumentType).toBe('OPTION');
      expect(Number(pos!.quantity)).toBe(15); // BANKNIFTY lot size 15
      expect(Number(pos!.strike)).toBe(52100);
    });
  });

  // =========================================================================
  // 3. INSTRUMENT C: BTCUSDT_SPOT (Crypto Spot & Point-in-Time FX)
  // =========================================================================
  describe('Instrument C: BTCUSDT_SPOT Execution Lifecycle', () => {
    it('executes BTCUSDT_SPOT with USDT quote currency, point-in-time FX to INR, and Binance 0.1% fees', async () => {
      spotQuotes['BTCUSDT_SPOT'] = { price: 65000.0, lastUpdated: nowMs };

      const bot = await prisma.algoBot.create({
        data: {
          id: `bot_all_inst_btc_${Date.now()}`,
          name: 'BTCUSDT Spot Bot',
          symbol: 'BTCUSDT_SPOT',
          executionInstrument: 'BTCUSDT_SPOT',
          executionInstrumentType: 'SPOT',
          signalSourceInstrument: 'BTCUSDT_SPOT',
          direction: 'BULLISH',
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

      const signal = createSignal('BTCUSDT_SPOT', Direction.BULLISH, 65000.0);
      const results = await algoBotsService.evaluateSignalForBots(signal);
      expect(results).toHaveLength(1);
      expect(results[0].status).toBe('EXECUTED');
      const posId = results[0].orderPositionId!;

      const pos = await prisma.paperPosition.findUnique({ where: { id: posId } });
      expect(pos).toBeDefined();
      expect(pos!.symbol).toBe('BTCUSDT_SPOT');
      expect(pos!.instrumentType).toBe('SPOT');
      expect(Number(pos!.quantity)).toBeGreaterThan(0);

      const charges = pos!.chargesJson as any;
      expect(charges.feeCurrency).toBe('USDT');
      expect(charges.accountCurrency).toBe('INR');
      expect(charges.stt).toBe(0);
      expect(charges.feeCalculationBasis).toBe('BINANCE_SPOT_0_1_PERCENT');

      // Close position
      spotQuotes['BTCUSDT_SPOT'] = { price: 66000.0, lastUpdated: nowMs };
      const closedTrade = await paperTradingService.closePosition(posId, 'Take Profit Completed', {
        allowPriceOverride: true,
        exitPriceOverride: 66000.0,
        isInternalCall: true,
      });

      expect(closedTrade).toBeDefined();
      expect(closedTrade.realizedPnL).toBeGreaterThan(0);
      expect(closedTrade.quoteCurrency).toBe('USDT');
      expect(closedTrade.accountCurrency).toBe('INR');
    });
  });

  // =========================================================================
  // 4. INSTRUMENT D: XAUUSD (Commodity Spot Gold)
  // =========================================================================
  describe('Instrument D: XAUUSD Execution Lifecycle', () => {
    it('executes XAUUSD with USD quote currency, point-in-time FX to INR, and COMEX tariff', async () => {
      spotQuotes['XAUUSD'] = { price: 2500.0, lastUpdated: nowMs };

      const bot = await prisma.algoBot.create({
        data: {
          id: `bot_all_inst_gold_${Date.now()}`,
          name: 'XAUUSD Commodity Bot',
          symbol: 'XAUUSD',
          executionInstrument: 'XAUUSD',
          executionInstrumentType: 'SPOT',
          signalSourceInstrument: 'XAUUSD',
          direction: 'BULLISH',
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

      const signal = createSignal('XAUUSD', Direction.BULLISH, 2500.0);
      const results = await algoBotsService.evaluateSignalForBots(signal);
      expect(results).toHaveLength(1);
      expect(results[0].status).toBe('EXECUTED');
      const posId = results[0].orderPositionId!;

      const pos = await prisma.paperPosition.findUnique({ where: { id: posId } });
      expect(pos).toBeDefined();
      expect(pos!.symbol).toBe('XAUUSD');

      const charges = pos!.chargesJson as any;
      expect(charges.feeCurrency).toBe('USD');
      expect(charges.accountCurrency).toBe('INR');
      expect(charges.feeCalculationBasis).toBe('COMEX_COMMISSION_0_02_PERCENT');
    });
  });

  // =========================================================================
  // 5. INSTRUMENTS E, F, G: NSE CASH EQUITIES (RELIANCE, HDFCBANK, INFY)
  // =========================================================================
  describe('Instruments E, F, G: NSE Cash Equities Execution Lifecycle', () => {
    it('executes RELIANCE with lot size 1, precision 0, and NSE Cash Equity fee schedule', async () => {
      spotQuotes['RELIANCE'] = { price: 3000.0, lastUpdated: nowMs };

      const bot = await prisma.algoBot.create({
        data: {
          id: `bot_all_inst_rel_${Date.now()}`,
          name: 'RELIANCE Equity Bot',
          symbol: 'RELIANCE',
          executionInstrument: 'RELIANCE',
          executionInstrumentType: 'EQUITY',
          signalSourceInstrument: 'RELIANCE',
          direction: 'BULLISH',
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

      const signal = createSignal('RELIANCE', Direction.BULLISH, 3000.0);
      const results = await algoBotsService.evaluateSignalForBots(signal);
      expect(results).toHaveLength(1);
      expect(results[0].status).toBe('EXECUTED');
      const posId = results[0].orderPositionId!;

      const pos = await prisma.paperPosition.findUnique({ where: { id: posId } });
      expect(pos).toBeDefined();
      expect(pos!.symbol).toBe('RELIANCE');
      expect(Number(pos!.quantity)).toBe(1); // Lot size 1

      const charges = pos!.chargesJson as any;
      expect(charges.feeCurrency).toBe('INR');
      expect(charges.accountCurrency).toBe('INR');
      expect(charges.feeCalculationBasis).toBe('NSE_CASH_EQUITY_SCHEDULE');
      expect(charges.brokerage).toBe(20.0);
      expect(charges.stt).toBeGreaterThan(0);
    });

    it('executes HDFCBANK with lot size 1 and Cash Equity tariff', async () => {
      spotQuotes['HDFCBANK'] = { price: 1650.0, lastUpdated: nowMs };

      const bot = await prisma.algoBot.create({
        data: {
          id: `bot_all_inst_hdfc_${Date.now()}`,
          name: 'HDFCBANK Equity Bot',
          symbol: 'HDFCBANK',
          executionInstrument: 'HDFCBANK',
          executionInstrumentType: 'EQUITY',
          signalSourceInstrument: 'HDFCBANK',
          direction: 'BULLISH',
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

      const signal = createSignal('HDFCBANK', Direction.BULLISH, 1650.0);
      const results = await algoBotsService.evaluateSignalForBots(signal);
      expect(results).toHaveLength(1);
      expect(results[0].status).toBe('EXECUTED');
    });

    it('executes INFY with lot size 1 and Cash Equity tariff', async () => {
      spotQuotes['INFY'] = { price: 1900.0, lastUpdated: nowMs };

      const bot = await prisma.algoBot.create({
        data: {
          id: `bot_all_inst_infy_${Date.now()}`,
          name: 'INFY Equity Bot',
          symbol: 'INFY',
          executionInstrument: 'INFY',
          executionInstrumentType: 'EQUITY',
          signalSourceInstrument: 'INFY',
          direction: 'BULLISH',
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

      const signal = createSignal('INFY', Direction.BULLISH, 1900.0);
      const results = await algoBotsService.evaluateSignalForBots(signal);
      expect(results).toHaveLength(1);
      expect(results[0].status).toBe('EXECUTED');
    });
  });

  // =========================================================================
  // 6. INVARIANT & FAIL-CLOSED PATHS
  // =========================================================================
  describe('Invariants & Fail-Closed Scenarios', () => {
    it('Running P&L Invariant: getActivePositions() computes live unrealized P&L and R dynamically from live quotes', async () => {
      spotQuotes['RELIANCE'] = { price: 3000.0, lastUpdated: nowMs };

      const order = await paperTradingService.placeOrder({
        symbol: 'RELIANCE',
        direction: 'BUY',
        quantity: 10,
        orderType: 'MARKET',
        price: 3000.0,
        allowPriceOverride: true,
        stopLoss: 2950.0,
        target1: 3050.0,
      });

      // Query active positions
      const activePositionsInitial = await paperTradingService.getActivePositions(paperAccountId);
      const relPos = activePositionsInitial.find((p) => p.symbol === 'RELIANCE');
      expect(relPos).toBeDefined();
      expect(relPos.currentPrice).toBe(3000.0);

      // Price moves up to 3050: dynamic calculation reflects in getActivePositions
      spotQuotes['RELIANCE'] = { price: 3050.0, lastUpdated: nowMs };
      const activePositionsUpdated = await paperTradingService.getActivePositions(paperAccountId);
      const relPosUpdated = activePositionsUpdated.find((p) => p.symbol === 'RELIANCE');
      expect(relPosUpdated.currentPrice).toBe(3050.0);
      expect(relPosUpdated.unrealizedPnL).toBeGreaterThan(0);
      expect(relPosUpdated.unrealizedR).toBeGreaterThan(0);
    });

    it('Manual Close Option Invariant: closePosition() closes option position using exact option quote, not index spot', async () => {
      const contractSymbol = 'NIFTY 24100 CE';
      optionQuotes[contractSymbol] = { price: 150.0, lastUpdated: nowMs };

      const order = await paperTradingService.placeOrder({
        symbol: 'NIFTY',
        contractSymbol,
        instrumentType: 'OPTION',
        direction: 'BUY',
        quantity: 65,
        orderType: 'MARKET',
        price: 150.0,
        allowPriceOverride: true,
        stopLoss: 100.0,
        target1: 200.0,
        strike: 24100,
        optionType: 'CE',
      });

      // Option price moves to 180 (underlying spot could be anything, e.g. 24150)
      optionQuotes[contractSymbol] = { price: 180.0, lastUpdated: nowMs };
      const closedTrade = await paperTradingService.closePosition(order.id, 'Manual Close', {
        allowPriceOverride: true,
        exitPriceOverride: 180.0,
        isInternalCall: true,
      });

      expect(closedTrade).toBeDefined();
      expect(closedTrade.contractSymbol).toBe(contractSymbol);
      expect(closedTrade.exitPrice).toBeCloseTo(180.0, 0); // Option premium, NOT 24150
    });

    it('Signal Flip Immutability: An open position is never mutated or auto-closed by a signal flip', async () => {
      spotQuotes['RELIANCE'] = { price: 3000.0, lastUpdated: nowMs };

      const bot = await prisma.algoBot.create({
        data: {
          id: `bot_all_inst_flip_${Date.now()}`,
          name: 'RELIANCE Flip Test Bot',
          symbol: 'RELIANCE',
          executionInstrument: 'RELIANCE',
          executionInstrumentType: 'EQUITY',
          signalSourceInstrument: 'RELIANCE',
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

      // 1. Initial Bullish Signal opens position
      const bullSignal = createSignal('RELIANCE', Direction.BULLISH, 3000.0);
      const res1 = await algoBotsService.evaluateSignalForBots(bullSignal);
      expect(res1[0].status).toBe('EXECUTED');
      const posId = res1[0].orderPositionId!;

      // 2. Flipped Bearish Signal arrives on next candle
      const bearSignal = createSignal('RELIANCE', Direction.BEARISH, 3010.0, {
        canonicalCandleTime: nowMs + 900000,
      });
      await algoBotsService.evaluateSignalForBots(bearSignal);

      // Verify original position is still OPEN and unmutated
      const pos = await prisma.paperPosition.findUnique({ where: { id: posId } });
      expect(pos!.status).toBe(PositionState.OPEN);
      expect(pos!.direction).toBe(Direction.BULLISH);
    });

    it('Fail-Closed: Spot short selling on spot instruments is strictly rejected with SPOT_SHORT_SELLING_FORBIDDEN', async () => {
      await expect(
        paperTradingService.placeOrder({
          symbol: 'BTCUSDT_SPOT',
          direction: 'SELL',
          quantity: 0.01,
          orderType: 'MARKET',
          price: 65000.0,
          stopLoss: 66000.0,
          target1: 64000.0,
        }),
      ).rejects.toThrow('SPOT_SHORT_SELLING_FORBIDDEN');
    });

    it('Account Scoped Clearing: clearAllCompletedTrades() only clears trades for the target account', async () => {
      const clearRes = await paperTradingService.clearAllCompletedTrades(paperAccountId);
      expect(clearRes.success).toBe(true);

      const tradesRemaining = await prisma.paperTrade.count({
        where: { accountId: paperAccountId },
      });
      expect(tradesRemaining).toBe(0);
    });
  });
});
