import { PrismaClient, AlgoBotExecutionState } from '@prisma/client';
import { AlgoBotsService, IAlgoBot } from '../algo-bots.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  ISignalSetup,
  Direction,
  SignalGrade,
  SignalState,
  Timeframe,
  MarketDataUnavailableError,
} from '@quant/shared';
import { InternalServerErrorException } from '@nestjs/common';

describe('Fix 175 — PostgreSQL Concurrency, Retry Atomicity & State Machine Integration Suite', () => {
  let prismaA: PrismaClient;
  let prismaB: PrismaClient;
  let algoBotsServiceA: AlgoBotsService;
  let algoBotsServiceB: AlgoBotsService;

  const DB_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;

  beforeAll(async () => {
    if (process.env.CI && !DB_URL) {
      throw new Error(
        '❌ [FAIL-FAST CI CONFIG] TEST_DATABASE_URL environment variable is required for integration tests in CI environment.',
      );
    }

    if (!DB_URL) {
      console.warn(
        '⚠️ [INTEGRATION TEST SKIPPED] TEST_DATABASE_URL environment variable is not set. Skipped PostgreSQL integration suite.',
      );
      return;
    }

    prismaA = new PrismaClient({ datasources: { db: { url: DB_URL } } });
    prismaB = new PrismaClient({ datasources: { db: { url: DB_URL } } });

    await prismaA.$connect();
    await prismaB.$connect();

    const mockPaperTrading = {
      getPortfolio: jest.fn().mockResolvedValue({ positions: [], openPositions: [], accountId: 'acc_conc_01' }),
      getValidatedMarketPrice: jest.fn().mockResolvedValue({ price: 50000, timestamp: new Date() }),
      placeOrder: jest.fn().mockResolvedValue({ id: 'order_123', status: 'FILLED', entryPrice: 50000 }),
    };

    algoBotsServiceA = new AlgoBotsService(
      mockPaperTrading as any,
      {} as any,
      prismaA as unknown as PrismaService,
      null as any,
    );

    algoBotsServiceB = new AlgoBotsService(
      mockPaperTrading as any,
      {} as any,
      prismaB as unknown as PrismaService,
      null as any,
    );
  });

  afterAll(async () => {
    if (prismaA) await prismaA.$disconnect();
    if (prismaB) await prismaB.$disconnect();
  });

  it('1. Verified DB_URL environment variable', () => {
    if (!DB_URL) return;
    expect(DB_URL).toBeDefined();
    expect(DB_URL.length).toBeGreaterThan(0);
  });

  it('2. Concurrent Reservation Guarantee — 5 parallel reserveExecutionLock calls result in exactly 1 reservation', async () => {
    if (!DB_URL) return;

    const botId = `bot_conc_${Date.now()}`;
    await prismaA.algoBot.create({
      data: {
        id: botId,
        name: 'Concurrent Test Bot',
        symbol: 'BTCUSDT',
        direction: 'BULLISH',
        timeframe: '15m',
        isActive: true,
        autoExecutePaper: true,
        minScore: 70,
        lots: 1,
        smcCondition: 'ANY_CONFLUENCE',
      },
    });

    const bot: IAlgoBot = {
      id: botId,
      name: 'Concurrent Test Bot',
      symbol: 'BTCUSDT',
      direction: 'BULLISH',
      timeframe: '15m',
      isActive: true,
      autoExecutePaper: true,
      minScore: 70,
      lots: 1,
      smcCondition: 'ANY_CONFLUENCE',
      configVersion: 'v1.0.0',
      notifyWebhook: false,
      createdAt: new Date().toISOString(),
      triggerCount: 0,
    };

    const now = Date.now();
    const signal: ISignalSetup = {
      id: `sig_conc_${Date.now()}`,
      symbol: 'BTCUSDT',
      direction: Direction.BULLISH,
      grade: SignalGrade.A_PLUS,
      score: 85,
      entryZone: { min: 49900, max: 50100, optimal: 50000 },
      stopLoss: 49500,
      takeProfits: { tp1: 51000, tp2: 52000, tp3: 53000 },
      riskRewardRatios: { rr1: 2.0, rr2: 4.0, rr3: 6.0 },
      timeframe: Timeframe.M15,
      timestamp: now as any,
      state: SignalState.ACTIVE,
      triggerEvidence: {
        fvg: { matched: true, timestamp: new Date(now) },
      },
      reasoning: {
        htfStructure: 'Bullish',
        liquidityReason: 'Swept',
        triggerReason: 'FVG',
        invalidationReason: 'SL',
        confirmedChecklist: ['FVG'],
        summary: 'Bullish FVG',
      },
      scoreBreakdown: {
        htfBias: 20,
        liquiditySweep: 15,
        bos: 15,
        fvg: 20,
        orderBlock: 0,
        displacement: 10,
        volumeConfirmation: 5,
        premiumDiscount: 0,
        riskReward: 0,
        indicatorAlignment: 0,
        totalScore: 85,
        grade: SignalGrade.A_PLUS,
      },
    };

    const fingerprint = algoBotsServiceA.getSignalFingerprint(bot, signal);

    try {
      const results = await Promise.all([
        algoBotsServiceA.reserveExecutionLock(bot, signal, fingerprint),
        algoBotsServiceB.reserveExecutionLock(bot, signal, fingerprint),
        algoBotsServiceA.reserveExecutionLock(bot, signal, fingerprint),
        algoBotsServiceB.reserveExecutionLock(bot, signal, fingerprint),
        algoBotsServiceA.reserveExecutionLock(bot, signal, fingerprint),
      ]);

      const wins = results.filter((r) => r.success);
      const fails = results.filter((r) => !r.success);

      expect(wins).toHaveLength(1);
      expect(fails).toHaveLength(4);
      expect(wins[0].executionId).toBeDefined();

      const executionsInDb = await prismaA.algoBotExecution.findMany({
        where: { fingerprint },
      });
      expect(executionsInDb).toHaveLength(1);
      expect(executionsInDb[0].state).toBe(AlgoBotExecutionState.RESERVED);
    } finally {
      await prismaA.algoBotExecution.deleteMany({ where: { fingerprint } });
      await prismaA.algoBot.deleteMany({ where: { id: botId } });
    }
  });

  it('3. State Machine Transitions — RESERVED -> EXECUTING -> EXECUTED', async () => {
    if (!DB_URL) return;

    const botId = `bot_sm_${Date.now()}`;
    await prismaA.algoBot.create({
      data: {
        id: botId,
        name: 'State Machine Bot',
        symbol: 'BTCUSDT',
        direction: 'BULLISH',
        timeframe: '15m',
        isActive: true,
        autoExecutePaper: true,
        minScore: 70,
        lots: 1,
        smcCondition: 'ANY_CONFLUENCE',
      },
    });

    const bot: IAlgoBot = {
      id: botId,
      name: 'State Machine Bot',
      symbol: 'BTCUSDT',
      direction: 'BULLISH',
      timeframe: '15m',
      isActive: true,
      autoExecutePaper: true,
      minScore: 70,
      lots: 1,
      smcCondition: 'ANY_CONFLUENCE',
      configVersion: 'v1.0.0',
      notifyWebhook: false,
      createdAt: new Date().toISOString(),
      triggerCount: 0,
    };

    const now = Date.now();
    const signal: ISignalSetup = {
      id: `sig_sm_${Date.now()}`,
      symbol: 'BTCUSDT',
      direction: Direction.BULLISH,
      grade: SignalGrade.A_PLUS,
      score: 85,
      entryZone: { min: 49900, max: 50100, optimal: 50000 },
      stopLoss: 49500,
      takeProfits: { tp1: 51000, tp2: 52000, tp3: 53000 },
      riskRewardRatios: { rr1: 2.0, rr2: 4.0, rr3: 6.0 },
      timeframe: Timeframe.M15,
      timestamp: now as any,
      state: SignalState.ACTIVE,
      triggerEvidence: {
        fvg: { matched: true, timestamp: new Date(now) },
      },
      reasoning: {
        htfStructure: 'Bullish',
        liquidityReason: 'Swept',
        triggerReason: 'FVG',
        invalidationReason: 'SL',
        confirmedChecklist: ['FVG'],
        summary: 'Bullish FVG',
      },
      scoreBreakdown: {
        htfBias: 20,
        liquiditySweep: 15,
        bos: 15,
        fvg: 20,
        orderBlock: 0,
        displacement: 10,
        volumeConfirmation: 5,
        premiumDiscount: 0,
        riskReward: 0,
        indicatorAlignment: 0,
        totalScore: 85,
        grade: SignalGrade.A_PLUS,
      },
    };

    const fingerprint = algoBotsServiceA.getSignalFingerprint(bot, signal);

    try {
      const reservation = await algoBotsServiceA.reserveExecutionLock(bot, signal, fingerprint);
      expect(reservation.success).toBe(true);
      const execId = reservation.executionId!;

      await algoBotsServiceA.markExecutionStarted(execId);
      let dbRow = await prismaA.algoBotExecution.findUnique({ where: { id: execId } });
      expect(dbRow?.state).toBe(AlgoBotExecutionState.EXECUTING);

      await algoBotsServiceA.markExecutionExecuted(execId, 'ord_test_999');
      dbRow = await prismaA.algoBotExecution.findUnique({ where: { id: execId } });
      expect(dbRow?.state).toBe(AlgoBotExecutionState.EXECUTED);
      expect(dbRow?.orderPositionId).toBe('ord_test_999');
    } finally {
      await prismaA.algoBotExecution.deleteMany({ where: { fingerprint } });
      await prismaA.algoBot.deleteMany({ where: { id: botId } });
    }
  });

  it('4. FAILED_RETRYABLE State Reset — allows subsequent reservation retry for the same fingerprint', async () => {
    if (!DB_URL) return;

    const botId = `bot_retry_${Date.now()}`;
    await prismaA.algoBot.create({
      data: {
        id: botId,
        name: 'Retry Bot',
        symbol: 'BTCUSDT',
        direction: 'BULLISH',
        timeframe: '15m',
        isActive: true,
        autoExecutePaper: true,
        minScore: 70,
        lots: 1,
        smcCondition: 'ANY_CONFLUENCE',
      },
    });

    const bot: IAlgoBot = {
      id: botId,
      name: 'Retry Bot',
      symbol: 'BTCUSDT',
      direction: 'BULLISH',
      timeframe: '15m',
      isActive: true,
      autoExecutePaper: true,
      minScore: 70,
      lots: 1,
      smcCondition: 'ANY_CONFLUENCE',
      configVersion: 'v1.0.0',
      notifyWebhook: false,
      createdAt: new Date().toISOString(),
      triggerCount: 0,
    };

    const now = Date.now();
    const signal: ISignalSetup = {
      id: `sig_retry_${Date.now()}`,
      symbol: 'BTCUSDT',
      direction: Direction.BULLISH,
      grade: SignalGrade.A_PLUS,
      score: 85,
      entryZone: { min: 49900, max: 50100, optimal: 50000 },
      stopLoss: 49500,
      takeProfits: { tp1: 51000, tp2: 52000, tp3: 53000 },
      riskRewardRatios: { rr1: 2.0, rr2: 4.0, rr3: 6.0 },
      timeframe: Timeframe.M15,
      timestamp: now as any,
      state: SignalState.ACTIVE,
      triggerEvidence: {
        fvg: { matched: true, timestamp: new Date(now) },
      },
      reasoning: {
        htfStructure: 'Bullish',
        liquidityReason: 'Swept',
        triggerReason: 'FVG',
        invalidationReason: 'SL',
        confirmedChecklist: ['FVG'],
        summary: 'Bullish FVG',
      },
      scoreBreakdown: {
        htfBias: 20,
        liquiditySweep: 15,
        bos: 15,
        fvg: 20,
        orderBlock: 0,
        displacement: 10,
        volumeConfirmation: 5,
        premiumDiscount: 0,
        riskReward: 0,
        indicatorAlignment: 0,
        totalScore: 85,
        grade: SignalGrade.A_PLUS,
      },
    };

    const fingerprint = algoBotsServiceA.getSignalFingerprint(bot, signal);

    try {
      const res1 = await algoBotsServiceA.reserveExecutionLock(bot, signal, fingerprint);
      expect(res1.success).toBe(true);
      const execId = res1.executionId!;

      await algoBotsServiceA.markExecutionFailed(
        execId,
        new MarketDataUnavailableError('BTCUSDT', 'Streamer network timeout'),
      );
      let dbRow = await prismaA.algoBotExecution.findUnique({ where: { id: execId } });
      expect(dbRow?.state).toBe(AlgoBotExecutionState.FAILED_RETRYABLE);
      expect(dbRow?.failureReasonCode).toBe('MARKET_DATA_UNAVAILABLE');

      const res2 = await algoBotsServiceB.reserveExecutionLock(bot, signal, fingerprint);
      expect(res2.success).toBe(true);
      expect(res2.executionId).toBe(execId);

      dbRow = await prismaA.algoBotExecution.findUnique({ where: { id: execId } });
      expect(dbRow?.state).toBe(AlgoBotExecutionState.RESERVED);
      expect(dbRow?.failureReason).toBeNull();
      expect(dbRow?.failureReasonCode).toBeNull();
      expect(dbRow?.failedAt).toBeNull();
      expect(dbRow?.startedAt).toBeNull();
      expect(dbRow?.completedAt).toBeNull();
      expect(dbRow?.orderPositionId).toBeNull();
    } finally {
      await prismaA.algoBotExecution.deleteMany({ where: { fingerprint } });
      await prismaA.algoBot.deleteMany({ where: { id: botId } });
    }
  });

  it('5. Database Fail-Closed Policy — listBots() throws InternalServerErrorException on DB failure', async () => {
    const brokenPrisma = {
      algoBot: {
        findMany: jest.fn().mockRejectedValue(new Error('DB Connection Terminated')),
      },
    } as unknown as PrismaService;

    const brokenService = new AlgoBotsService(null as any, null as any, brokenPrisma);

    await expect(brokenService.listBots()).rejects.toThrow(InternalServerErrorException);
  });

  it('6. Atomic Retry Race Condition — concurrent reserveExecutionLock calls on FAILED_RETRYABLE result in exactly 1 retry winner', async () => {
    if (!DB_URL) return;

    const botId = `bot_retry_race_${Date.now()}`;
    await prismaA.algoBot.create({
      data: {
        id: botId,
        name: 'Retry Race Bot',
        symbol: 'BTCUSDT',
        direction: 'BULLISH',
        timeframe: '15m',
        isActive: true,
        autoExecutePaper: true,
        minScore: 70,
        lots: 1,
        smcCondition: 'ANY_CONFLUENCE',
      },
    });

    const bot: IAlgoBot = {
      id: botId,
      name: 'Retry Race Bot',
      symbol: 'BTCUSDT',
      direction: 'BULLISH',
      timeframe: '15m',
      isActive: true,
      autoExecutePaper: true,
      minScore: 70,
      lots: 1,
      smcCondition: 'ANY_CONFLUENCE',
      configVersion: 'v1.0.0',
      notifyWebhook: false,
      createdAt: new Date().toISOString(),
      triggerCount: 0,
    };

    const now = Date.now();
    const signal: ISignalSetup = {
      id: `sig_retry_race_${Date.now()}`,
      symbol: 'BTCUSDT',
      direction: Direction.BULLISH,
      grade: SignalGrade.A_PLUS,
      score: 85,
      entryZone: { min: 49900, max: 50100, optimal: 50000 },
      stopLoss: 49500,
      takeProfits: { tp1: 51000, tp2: 52000, tp3: 53000 },
      riskRewardRatios: { rr1: 2.0, rr2: 4.0, rr3: 6.0 },
      timeframe: Timeframe.M15,
      timestamp: now as any,
      state: SignalState.ACTIVE,
      triggerEvidence: {
        fvg: { matched: true, timestamp: new Date(now) },
      },
      reasoning: {
        htfStructure: 'Bullish',
        liquidityReason: 'Swept',
        triggerReason: 'FVG',
        invalidationReason: 'SL',
        confirmedChecklist: ['FVG'],
        summary: 'Bullish FVG',
      },
      scoreBreakdown: {
        htfBias: 20,
        liquiditySweep: 15,
        bos: 15,
        fvg: 20,
        orderBlock: 0,
        displacement: 10,
        volumeConfirmation: 5,
        premiumDiscount: 0,
        riskReward: 0,
        indicatorAlignment: 0,
        totalScore: 85,
        grade: SignalGrade.A_PLUS,
      },
    };

    const fingerprint = algoBotsServiceA.getSignalFingerprint(bot, signal);

    try {
      // 1. Initial reservation
      const res1 = await algoBotsServiceA.reserveExecutionLock(bot, signal, fingerprint);
      expect(res1.success).toBe(true);
      const execId = res1.executionId!;

      // 2. Mark FAILED_RETRYABLE with structured transient error
      await algoBotsServiceA.markExecutionFailed(
        execId,
        new MarketDataUnavailableError('BTCUSDT', 'Streamer timeout'),
      );

      // 3. Concurrent retry attempt from two service instances
      const retryResults = await Promise.all([
        algoBotsServiceA.reserveExecutionLock(bot, signal, fingerprint),
        algoBotsServiceB.reserveExecutionLock(bot, signal, fingerprint),
      ]);

      const retryWins = retryResults.filter((r) => r.success);
      const retryFails = retryResults.filter((r) => !r.success);

      expect(retryWins).toHaveLength(1);
      expect(retryFails).toHaveLength(1);
      expect(retryFails[0].reason).toBe('RETRY_RACE_CONCURRENTLY_CLAIMED');
    } finally {
      await prismaA.algoBotExecution.deleteMany({ where: { fingerprint } });
      await prismaA.algoBot.deleteMany({ where: { id: botId } });
    }
  });

  it('7. markExecutionFailed Throws Exception — DB failure during failure transition throws InternalServerErrorException', async () => {
    const brokenPrisma = {
      algoBotExecution: {
        update: jest.fn().mockRejectedValue(new Error('DB Connection Lost')),
      },
    } as unknown as PrismaService;

    const brokenService = new AlgoBotsService(null as any, null as any, brokenPrisma);

    await expect(
      brokenService.markExecutionFailed('exec_123', new Error('Network error')),
    ).rejects.toThrow(InternalServerErrorException);
  });

  it('8. Canonical Candle Timestamp Fingerprint — uses canonicalCandleTime when present', () => {
    const bot: IAlgoBot = {
      id: 'bot_canon_tf',
      name: 'Canonical TF Bot',
      symbol: 'BTCUSDT',
      direction: 'BULLISH',
      timeframe: '15m',
      isActive: true,
      autoExecutePaper: true,
      minScore: 70,
      lots: 1,
      smcCondition: 'ANY_CONFLUENCE',
      notifyWebhook: false,
      createdAt: new Date().toISOString(),
      triggerCount: 0,
    };

    const canonicalCandleTime = 1700000000000;
    const signal: any = {
      id: 'sig_canon_1',
      symbol: 'BTCUSDT',
      direction: Direction.BULLISH,
      grade: SignalGrade.A_PLUS,
      score: 85,
      timeframe: Timeframe.M15,
      timestamp: canonicalCandleTime + 60000,
      canonicalCandleTime,
      state: SignalState.ACTIVE,
    };

    const fingerprint = algoBotsServiceA.getSignalFingerprint(bot, signal);
    expect(fingerprint).toContain(`:1700000000000`);
  });

  it('9. Invalid State Transition Protection — attempting to transition an EXECUTED row to EXECUTING or FAILED throws exception', async () => {
    if (!DB_URL) return;

    const botId = `bot_invalid_tr_${Date.now()}`;
    await prismaA.algoBot.create({
      data: {
        id: botId,
        name: 'Invalid Transition Bot',
        symbol: 'BTCUSDT',
        direction: 'BULLISH',
        timeframe: '15m',
        isActive: true,
        autoExecutePaper: true,
        minScore: 70,
        lots: 1,
        smcCondition: 'ANY_CONFLUENCE',
      },
    });

    const bot: IAlgoBot = {
      id: botId,
      name: 'Invalid Transition Bot',
      symbol: 'BTCUSDT',
      direction: 'BULLISH',
      timeframe: '15m',
      isActive: true,
      autoExecutePaper: true,
      minScore: 70,
      lots: 1,
      smcCondition: 'ANY_CONFLUENCE',
      configVersion: 'v1.0.0',
      notifyWebhook: false,
      createdAt: new Date().toISOString(),
      triggerCount: 0,
    };

    const now = Date.now();
    const signal: ISignalSetup = {
      id: `sig_invalid_tr_${Date.now()}`,
      symbol: 'BTCUSDT',
      direction: Direction.BULLISH,
      grade: SignalGrade.A_PLUS,
      score: 85,
      entryZone: { min: 49900, max: 50100, optimal: 50000 },
      stopLoss: 49500,
      takeProfits: { tp1: 51000, tp2: 52000, tp3: 53000 },
      riskRewardRatios: { rr1: 2.0, rr2: 4.0, rr3: 6.0 },
      timeframe: Timeframe.M15,
      timestamp: now as any,
      canonicalCandleTime: Math.floor(now / (15 * 60 * 1000)) * (15 * 60 * 1000),
      state: SignalState.ACTIVE,
      triggerEvidence: {
        fvg: { matched: true, timestamp: new Date(now) },
      },
      reasoning: {
        htfStructure: 'Bullish',
        liquidityReason: 'Swept',
        triggerReason: 'FVG',
        invalidationReason: 'SL',
        confirmedChecklist: ['FVG'],
        summary: 'Bullish FVG',
      },
      scoreBreakdown: {
        htfBias: 20,
        liquiditySweep: 15,
        bos: 15,
        fvg: 20,
        orderBlock: 0,
        displacement: 10,
        volumeConfirmation: 5,
        premiumDiscount: 0,
        riskReward: 0,
        indicatorAlignment: 0,
        totalScore: 85,
        grade: SignalGrade.A_PLUS,
      },
    };

    const fingerprint = algoBotsServiceA.getSignalFingerprint(bot, signal);

    try {
      const res = await algoBotsServiceA.reserveExecutionLock(bot, signal, fingerprint);
      const execId = res.executionId!;

      await algoBotsServiceA.markExecutionStarted(execId);
      await algoBotsServiceA.markExecutionExecuted(execId, 'ord_done_1');

      // Attempting to transition EXECUTED row back to EXECUTING or FAILED must throw InternalServerErrorException
      await expect(algoBotsServiceA.markExecutionStarted(execId)).rejects.toThrow(
        InternalServerErrorException,
      );

      await expect(
        algoBotsServiceA.markExecutionFailed(execId, new Error('Stale failure')),
      ).rejects.toThrow(InternalServerErrorException);
    } finally {
      await prismaA.algoBotExecution.deleteMany({ where: { fingerprint } });
      await prismaA.algoBot.deleteMany({ where: { id: botId } });
    }
  });

  it('11 (Fix 194): Real PostgreSQL Concurrency: same signal x 2 workers -> exactly 1 TradeDecision TAKE, 1 TRADE_TAKEN, 1 reservation, 1 execution, 1 position', async () => {
    if (!DB_URL) return;

    const botId = `bot_conc_194_${Date.now()}`;
    await prismaA.algoBot.create({
      data: {
        id: botId,
        name: 'Concurrent Test Bot 194',
        symbol: 'BTCUSDT',
        direction: 'BULLISH',
        timeframe: '15m',
        isActive: true,
        autoExecutePaper: true,
        minScore: 70,
        lots: 1,
        smcCondition: 'ANY_CONFLUENCE',
      },
    });

    const now = Date.now();
    const candleTime = Math.floor(now / (15 * 60 * 1000)) * (15 * 60 * 1000);
    const signal: ISignalSetup = {
      id: `sig_conc_194_${now}`,
      symbol: 'BTCUSDT',
      direction: Direction.BULLISH,
      grade: SignalGrade.A_PLUS,
      score: 85,
      entryZone: { min: 49900, max: 50100, optimal: 50000 },
      stopLoss: 49500,
      takeProfits: { tp1: 51000, tp2: 52000, tp3: 53000 },
      riskRewardRatios: { rr1: 2.0, rr2: 4.0, rr3: 6.0 },
      timeframe: Timeframe.M15,
      timestamp: new Date(candleTime),
      canonicalCandleTime: candleTime,
      canonicalDecisionTime: new Date(candleTime),
      state: SignalState.ACTIVE,
      triggerEvidence: {
        fvg: { matched: true, timestamp: new Date(candleTime) },
      },
      reasoning: {
        htfStructure: 'Bullish',
        liquidityReason: 'Swept',
        triggerReason: 'FVG',
        invalidationReason: 'SL',
        confirmedChecklist: ['FVG'],
        summary: 'Bullish FVG',
      },
      scoreBreakdown: {
        htfBias: 20,
        liquiditySweep: 15,
        bos: 15,
        fvg: 20,
        orderBlock: 0,
        displacement: 10,
        volumeConfirmation: 5,
        premiumDiscount: 0,
        riskReward: 0,
        indicatorAlignment: 0,
        totalScore: 85,
        grade: SignalGrade.A_PLUS,
      },
    };

    try {
      // Execute 2 concurrent worker runs on separate DB client instances
      const [resultsA, resultsB] = await Promise.all([
        algoBotsServiceA.evaluateSignalForBots(signal),
        algoBotsServiceB.evaluateSignalForBots(signal),
      ]);

      const allResults = [...resultsA, ...resultsB];
      const executed = allResults.filter((r) => r.status === 'EXECUTED');
      const rejected = allResults.filter((r) => r.status === 'REJECTED');

      expect(executed).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(executed[0].decision).toBe('TAKE');
      expect(executed[0].reasonCode).toBe('ORDER_PLACED_SUCCESSFULLY');
      expect(rejected[0].reasonCode).toBe('EXECUTION_LOCKED');

      // Verify PostgreSQL DB State
      const fingerprint = executed[0].correlationId!;
      const decisions = await prismaA.tradeDecision.findMany({
        where: { fingerprint },
      });
      expect(decisions).toHaveLength(1);
      expect(decisions[0].decision).toBe('TAKE');
      expect(decisions[0].lifecycleState).toBe('POSITION_OPENED');
      expect(decisions[0].tradeTakenTime).toBeDefined();
      expect(decisions[0].reservationTime).toBeDefined();
      expect(decisions[0].orderSubmittedTime).toBeDefined();
      expect(decisions[0].fillTime).toBeDefined();

      const executions = await prismaA.algoBotExecution.findMany({
        where: { fingerprint },
      });
      expect(executions).toHaveLength(1);
      expect(executions[0].state).toBe('EXECUTED');
      expect(executions[0].orderPositionId).toBeDefined();
    } finally {
      await prismaA.tradeDecision.deleteMany({ where: { botId } });
      await prismaA.algoBotExecution.deleteMany({ where: { botId } });
      await prismaA.algoBot.deleteMany({ where: { id: botId } });
    }
  });
});
