import { Test, TestingModule } from '@nestjs/testing';
import { AlgoBotsService, IAlgoBot } from '../algo-bots.service';
import { AlgoBotsController } from '../algo-bots.controller';
import { SignalsService } from '../../signals/signals.service';
import { SignalsController } from '../../signals/signals.controller';
import { PaperTradingService } from '../../paper-trading/paper-trading.service';
import { AlertsService } from '../../alerts/alerts.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CandlesService } from '../../candles/candles.service';
import { Direction, ISignalSetup, SignalGrade, SignalState, Timeframe } from '@quant/shared';
import { ExecutionFailureReason } from '../trade-decision.service';

describe('Strategy Selection Pipeline Across Full Vertical Stack (Section 18)', () => {
  let algoBotsService: AlgoBotsService;
  let algoBotsController: AlgoBotsController;
  let signalsService: SignalsService;
  let signalsController: SignalsController;
  let mockPrisma: any;
  let mockPaperTradingService: any;
  let mockAlertsService: any;
  let mockCandlesService: any;

  // In-memory mock database store for algoBot records
  let dbBots: Map<string, any>;

  const createDummyCandles = (count = 50, basePrice = 24000) => {
    const candles: any[] = [];
    const now = Date.now();
    for (let i = count - 1; i >= 0; i--) {
      const time = now - i * 15 * 60 * 1000;
      candles.push({
        time,
        timestamp: new Date(time).toISOString(),
        open: basePrice + i * 2,
        high: basePrice + i * 2 + 5,
        low: basePrice + i * 2 - 5,
        close: basePrice + i * 2 + 3,
        volume: 1000 + i * 10,
      });
    }
    return candles;
  };

  beforeEach(async () => {
    dbBots = new Map();

    mockPrisma = {
      algoBot: {
        create: jest.fn().mockImplementation(async ({ data }) => {
          const record = {
            id: data.id || `bot_${Date.now()}`,
            name: data.name,
            symbol: data.symbol,
            strategy: data.strategy || 'SMC',
            direction: data.direction || 'ANY',
            timeframe: data.timeframe || '15m',
            minScore: data.minScore || 80,
            smcCondition: data.smcCondition || 'ANY_CONFLUENCE',
            lots: data.lots || 1,
            autoExecutePaper: Boolean(data.autoExecutePaper),
            notifyWebhook: Boolean(data.notifyWebhook),
            isActive: Boolean(data.isActive),
            triggerCount: 0,
            executionInstrument: data.executionInstrument,
            executionInstrumentType: data.executionInstrumentType,
            signalSourceInstrument: data.signalSourceInstrument,
            createdAt: new Date(),
            updatedAt: new Date(),
          };
          dbBots.set(record.id, record);
          return record;
        }),
        findUnique: jest.fn().mockImplementation(async ({ where }) => {
          return dbBots.get(where.id) || null;
        }),
        findMany: jest.fn().mockImplementation(async () => {
          return Array.from(dbBots.values());
        }),
        update: jest.fn().mockImplementation(async ({ where, data }) => {
          const existing = dbBots.get(where.id);
          if (!existing) throw new Error('Not found');
          const updated = {
            ...existing,
            ...data,
            updatedAt: new Date(),
          };
          dbBots.set(where.id, updated);
          return updated;
        }),
        delete: jest.fn().mockImplementation(async ({ where }) => {
          const existing = dbBots.get(where.id);
          dbBots.delete(where.id);
          return existing;
        }),
      },
      algoBotExecution: {
        create: jest.fn().mockImplementation(async ({ data }) => ({
          id: `exec_${Date.now()}`,
          ...data,
          createdAt: new Date(),
        })),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
      instrument: {
        findUnique: jest.fn().mockImplementation(async ({ where }) => {
          return {
            id: `inst_${where.symbol}`,
            symbol: where.symbol,
            isActive: true,
            tickSize: 0.05,
            lotSize: 65,
          };
        }),
        findMany: jest.fn().mockResolvedValue([
          { id: 'inst_NIFTY', symbol: 'NIFTY', isActive: true, tickSize: 0.05, lotSize: 65 },
          { id: 'inst_BANKNIFTY', symbol: 'BANKNIFTY', isActive: true, tickSize: 0.05, lotSize: 15 },
        ]),
      },
      tradeDecision: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockImplementation(async ({ data }) => ({ id: `dec_${Date.now()}`, ...data })),
        update: jest.fn().mockImplementation(async ({ data }) => data),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      $transaction: jest.fn(async (cb: any) => cb(mockPrisma)),
    };

    mockPaperTradingService = {
      isConfigured: jest.fn().mockReturnValue(true),
      getPortfolio: jest.fn().mockResolvedValue({ openPositions: [], accountId: 'paper_test_account' }),
      getValidatedMarketPrice: jest.fn().mockResolvedValue({ price: 24000.0, timestamp: new Date() }),
      placeOrder: jest.fn().mockResolvedValue({ id: 'pos_test_1', entryPrice: 24000.0 }),
    };

    mockAlertsService = {
      sendAlert: jest.fn().mockResolvedValue({ success: true }),
    };

    mockCandlesService = {
      getCandles: jest.fn().mockImplementation(async ({ timeframe }) => {
        if (timeframe === Timeframe.M15 || timeframe === '15m') {
          return { candles: createDummyCandles(100) };
        }
        return { candles: [] };
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AlgoBotsController, SignalsController],
      providers: [
        AlgoBotsService,
        SignalsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: PaperTradingService, useValue: mockPaperTradingService },
        { provide: AlertsService, useValue: mockAlertsService },
        { provide: CandlesService, useValue: mockCandlesService },
      ],
    }).compile();

    algoBotsService = module.get<AlgoBotsService>(AlgoBotsService);
    algoBotsController = module.get<AlgoBotsController>(AlgoBotsController);
    signalsService = module.get<SignalsService>(SignalsService);
    signalsController = module.get<SignalsController>(SignalsController);
  });

  // TEST 1: Create bot with SMC -> strategy = 'SMC'
  it('TEST 1: Create bot with SMC -> strategy is persisted as SMC', async () => {
    const bot = await algoBotsService.createBot({
      name: 'NIFTY SMC Test Bot',
      symbol: 'NIFTY',
      strategy: 'SMC',
      direction: 'BULLISH',
      timeframe: '15m',
      minScore: 80,
    });

    expect(bot.strategy).toBe('SMC');
    expect(mockPrisma.algoBot.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          strategy: 'SMC',
          symbol: 'NIFTY',
        }),
      }),
    );
  });

  // TEST 2: Update bot: SMC -> SAIYAN -> database strategy = 'SAIYAN_OCC'
  it('TEST 2: Update bot: SMC -> SAIYAN -> database strategy is normalized and stored as SAIYAN_OCC', async () => {
    const created = await algoBotsService.createBot({
      name: 'NIFTY Strategy Switch Bot',
      symbol: 'NIFTY',
      strategy: 'SMC',
    });
    expect(created.strategy).toBe('SMC');

    const updated = await algoBotsService.updateBot(created.id, {
      strategy: 'SAIYAN',
    });

    expect(updated.strategy).toBe('SAIYAN_OCC');
    expect(mockPrisma.algoBot.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: created.id },
        data: expect.objectContaining({
          strategy: 'SAIYAN_OCC',
        }),
      }),
    );

    const fromDb = dbBots.get(created.id);
    expect(fromDb.strategy).toBe('SAIYAN_OCC');
  });

  // TEST 3: Reload bot -> strategy = 'SAIYAN_OCC'
  it('TEST 3: Reload bot from database -> strategy remains SAIYAN_OCC', async () => {
    const created = await algoBotsService.createBot({
      name: 'Reload Bot',
      symbol: 'NIFTY',
      strategy: 'SAIYAN_OCC',
    });

    const singleReloaded = await algoBotsService.getBot(created.id);
    expect(singleReloaded?.strategy).toBe('SAIYAN_OCC');

    const allBots = await algoBotsService.listBots();
    const found = allBots.find((b) => b.id === created.id);
    expect(found).toBeDefined();
    expect(found?.strategy).toBe('SAIYAN_OCC');
  });

  // TEST 4: Generate signal for bot -> resolved strategy = 'SAIYAN_OCC', NOT 'SMC'
  it('TEST 4: Generate signal for bot -> resolved strategy = SAIYAN_OCC, and bot matches Saiyan signal', async () => {
    const signal = await signalsService.generateSignalForSymbol('NIFTY', Timeframe.M15, 'SAIYAN_OCC');

    expect(signal.strategy).toBe('SAIYAN_OCC');
    expect(signal.strategyMode).toBe('SAIYAN_OCC');

    const saiyanBot: IAlgoBot = {
      id: 'bot_saiyan_1',
      name: 'Saiyan Bot',
      symbol: 'NIFTY',
      strategy: 'SAIYAN_OCC',
      direction: 'ANY',
      timeframe: '15m',
      minScore: 50,
      smcCondition: 'ANY_CONFLUENCE',
      lots: 1,
      autoExecutePaper: true,
      notifyWebhook: false,
      isActive: true,
      createdAt: new Date().toISOString(),
      triggerCount: 0,
    };

    const matchResult = algoBotsService.matchesBotStrategy(saiyanBot, signal);
    expect(matchResult.matches).toBe(true);

    const smcSignal: ISignalSetup = {
      ...signal,
      strategy: 'SMC',
      strategyMode: 'SMC',
    };
    const mismatchResult = algoBotsService.matchesBotStrategy(saiyanBot, smcSignal);
    expect(mismatchResult.matches).toBe(false);
    expect(mismatchResult.reasonCode).toBe('STRATEGY_MISMATCH');
  });

  // TEST 5: Change SAIYAN -> SMC -> database strategy = 'SMC', signal generator receives SMC
  it('TEST 5: Change SAIYAN -> SMC -> database strategy = SMC and signal evaluation switches to SMC', async () => {
    const bot = await algoBotsService.createBot({
      name: 'Switchable Bot',
      symbol: 'NIFTY',
      strategy: 'SAIYAN_OCC',
    });
    expect(bot.strategy).toBe('SAIYAN_OCC');

    const updated = await algoBotsService.updateBot(bot.id, {
      strategy: 'SMC',
    });
    expect(updated.strategy).toBe('SMC');
    expect(dbBots.get(bot.id).strategy).toBe('SMC');

    const smcSignal = await signalsService.generateSignalForSymbol('NIFTY', Timeframe.M15, 'SMC');
    expect(smcSignal.strategy).toBe('SMC');

    const matchSMC = algoBotsService.matchesBotStrategy(updated, smcSignal);
    expect(matchSMC.matches).toBe(true);

    const saiyanSignal: ISignalSetup = {
      ...smcSignal,
      strategy: 'SAIYAN_OCC',
      strategyMode: 'SAIYAN_OCC',
    };
    const rejectSaiyan = algoBotsService.matchesBotStrategy(updated, saiyanSignal);
    expect(rejectSaiyan.matches).toBe(false);
    expect(rejectSaiyan.reasonCode).toBe('STRATEGY_MISMATCH');
  });

  // TEST 6: Bot A (SMC) & Bot B (SAIYAN) remain isolated; updating Bot B does NOT touch Bot A
  it('TEST 6: Bot A (SMC) and Bot B (SAIYAN) remain isolated across updates and execution', async () => {
    const botA = await algoBotsService.createBot({
      name: 'Bot A SMC',
      symbol: 'NIFTY',
      strategy: 'SMC',
    });

    const botB = await algoBotsService.createBot({
      name: 'Bot B SAIYAN',
      symbol: 'NIFTY',
      strategy: 'SAIYAN_OCC',
    });

    expect(dbBots.get(botA.id).strategy).toBe('SMC');
    expect(dbBots.get(botB.id).strategy).toBe('SAIYAN_OCC');

    // Updating Bot B must not mutate Bot A
    await algoBotsService.updateBot(botB.id, { minScore: 90, lots: 3 });
    const reloadedA = await algoBotsService.getBot(botA.id);
    const reloadedB = await algoBotsService.getBot(botB.id);

    expect(reloadedA?.strategy).toBe('SMC');
    expect(reloadedB?.strategy).toBe('SAIYAN_OCC');
    expect(reloadedB?.minScore).toBe(90);
    expect(reloadedB?.lots).toBe(3);

    // Evaluate signal for SAIYAN: Bot B should match strategy, Bot A must reject with STRATEGY_MISMATCH
    const now = Date.now();
    const saiyanSignal: ISignalSetup = {
      id: 'sig_saiyan_test',
      symbol: 'NIFTY',
      timeframe: '15m',
      direction: Direction.BULLISH,
      score: 95,
      grade: SignalGrade.A_PLUS,
      state: SignalState.ACTIVE,
      strategy: 'SAIYAN_OCC',
      strategyMode: 'SAIYAN_OCC',
      canonicalCandleTime: now,
      canonicalDecisionTime: new Date(now),
      entryZone: { min: 24000, max: 24020, optimal: 24010 },
      stopLoss: 23950,
      takeProfits: { tp1: 24100, tp2: 24200, tp3: 24300 },
      riskRewardRatios: { rr1: 1.5, rr2: 2.5, rr3: 4.0 },
      reasoning: {
        htfStructure: 'Bullish Momentum',
        liquidityReason: 'Saiyan Trend Acceleration',
        triggerReason: 'Saiyan OCC Confirmed',
        invalidationReason: 'Below SL',
        confirmedChecklist: ['Saiyan Trend'],
        summary: 'Saiyan OCC Bullish Setup',
      },
      scoreBreakdown: {
        htfBias: 25,
        liquiditySweep: 20,
        bos: 20,
        fvg: 10,
        orderBlock: 10,
        displacement: 10,
        volumeConfirmation: 0,
        premiumDiscount: 0,
        riskReward: 0,
        indicatorAlignment: 0,
        totalScore: 95,
        grade: SignalGrade.A_PLUS,
      },
      reasons: ['SAIYAN_MOMENTUM_ALIGNMENT'],
      triggerEvidence: {
        orderBlock: { matched: false },
        fvg: { matched: false },
        liquiditySweep: { matched: false },
      },
    };

    const matchA = algoBotsService.matchesBotStrategy(reloadedA!, saiyanSignal);
    const matchB = algoBotsService.matchesBotStrategy(reloadedB!, saiyanSignal);

    expect(matchA.matches).toBe(false);
    expect(matchA.reasonCode).toBe('STRATEGY_MISMATCH');
    expect(matchB.matches).toBe(true);
  });

  // TEST 7: Frontend hook refresh preserves SAIYAN_OCC
  it('TEST 7: Controller API calls preserve SAIYAN_OCC on fetch and listing', async () => {
    const bot = await algoBotsService.createBot({
      name: 'UI Preserved Bot',
      symbol: 'NIFTY',
      strategy: 'SAIYAN_OCC',
    });

    // Simulate GET /api/algo-bots from UI refresh
    const botList = await algoBotsController.listBots();
    const fetchedBot = botList.find((b) => b.id === bot.id);
    expect(fetchedBot).toBeDefined();
    expect(fetchedBot?.strategy).toBe('SAIYAN_OCC');

    // Simulate GET /api/signals/:symbol?strategy=SAIYAN_OCC
    const signalResponse = await signalsController.getSignalForSymbol(
      'NIFTY',
      Timeframe.M15,
      'SAIYAN_OCC',
    );
    expect(signalResponse.strategy).toBe('SAIYAN_OCC');
    expect(signalResponse.strategyMode).toBe('SAIYAN_OCC');
  });

  // TEST 8: Immediate signal request uses new strategy without race conditions
  it('TEST 8: Immediate signal request uses new strategy without race conditions', async () => {
    const bot = await algoBotsService.createBot({
      name: 'Fast Transition Bot',
      symbol: 'NIFTY',
      strategy: 'SMC',
    });

    // Update via controller (PUT/PATCH)
    await algoBotsController.updateBot(bot.id, { strategy: 'SAIYAN_OCC' });

    // Immediate signal generation query with new strategy
    const signal = await signalsController.getSignalForSymbol(
      'NIFTY',
      Timeframe.M15,
      'SAIYAN_OCC',
    );

    expect(signal.strategy).toBe('SAIYAN_OCC');

    const currentBot = await algoBotsService.getBot(bot.id);
    expect(currentBot?.strategy).toBe('SAIYAN_OCC');

    const match = algoBotsService.matchesBotStrategy(currentBot!, signal);
    expect(match.matches).toBe(true);
  });

  // TEST 9: No strategy supplied on new bot -> defaults to SMC
  it('TEST 9: No strategy supplied on new bot -> defaults to SMC', async () => {
    const bot = await algoBotsService.createBot({
      name: 'Default Bot Without Strategy',
      symbol: 'NIFTY',
      minScore: 80,
    });

    expect(bot.strategy).toBe('SMC');
    expect(dbBots.get(bot.id).strategy).toBe('SMC');
  });

  // TEST 10: Existing bot has SAIYAN; partial update without strategy does NOT reset to SMC
  it('TEST 10: Existing bot has SAIYAN; partial update without strategy does NOT reset to SMC', async () => {
    const bot = await algoBotsService.createBot({
      name: 'Persistent Saiyan Bot',
      symbol: 'NIFTY',
      strategy: 'SAIYAN_OCC',
      lots: 1,
      minScore: 75,
    });

    expect(bot.strategy).toBe('SAIYAN_OCC');

    // Partial update that modifies only lots and minScore (strategy omitted)
    const partiallyUpdated = await algoBotsService.updateBot(bot.id, {
      lots: 5,
      minScore: 85,
    });

    expect(partiallyUpdated.strategy).toBe('SAIYAN_OCC');
    expect(partiallyUpdated.lots).toBe(5);
    expect(partiallyUpdated.minScore).toBe(85);

    // Verify database record still has SAIYAN_OCC
    const dbRecord = dbBots.get(bot.id);
    expect(dbRecord.strategy).toBe('SAIYAN_OCC');

    // Verify another partial update via Controller (PATCH) also preserves it
    const patchUpdated = await algoBotsController.updateBot(bot.id, {
      isActive: true,
    });
    expect(patchUpdated.strategy).toBe('SAIYAN_OCC');
    expect(dbBots.get(bot.id).strategy).toBe('SAIYAN_OCC');
  });
});
