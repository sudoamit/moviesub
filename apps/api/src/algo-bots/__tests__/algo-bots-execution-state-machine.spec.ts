import { AlgoBotsService } from '../algo-bots.service';
import { ISignalSetup, Direction, SignalState, SignalGrade, Timeframe } from '@quant/shared';
import { PrismaService } from '../../common/prisma/prisma.service';

describe('AlgoBotsService Execution State Machine', () => {
  let service: AlgoBotsService;
  let mockPaperTradingService: any;
  let mockAlertsService: any;
  let prismaClient: any;
  let executionsDb: Map<string, any>;

  const canonicalDate = new Date();
  const canonicalMs = canonicalDate.getTime();

  beforeEach(() => {
    process.env.PAPER_TRADING_ENABLED = 'true';
    executionsDb = new Map();

    prismaClient = {
      algoBot: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'bot_state_machine_test',
            name: 'State Machine Test Bot',
            symbol: 'BTCUSDT',
            direction: 'ANY',
            timeframe: '15m',
            minScore: 70,
            smcCondition: 'ANY_CONFLUENCE',
            lots: 1,
            autoExecutePaper: true,
            notifyWebhook: false,
            isActive: true,
            createdAt: new Date(),
          },
        ]),
        update: jest.fn().mockResolvedValue({ count: 1 }),
      },
      algoBotExecution: {
        create: jest.fn().mockImplementation(async ({ data }) => {
          if (executionsDb.has(data.idempotencyFingerprint)) {
            const err: any = new Error('Unique constraint failed on idempotencyFingerprint');
            err.code = 'P2002';
            throw err;
          }
          const record = {
            id: `exec_sm_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
            ...data,
            state: 'RESERVED',
            createdAt: new Date(),
            updatedAt: new Date(),
          };
          executionsDb.set(data.idempotencyFingerprint, record);
          return record;
        }),
        update: jest.fn().mockImplementation(async ({ where, data }) => {
          const foundKey = Array.from(executionsDb.keys()).find(
            (k) => executionsDb.get(k).id === where.id,
          );
          if (!foundKey) throw new Error('Execution record not found');
          const existing = executionsDb.get(foundKey);
          const updated = { ...existing, ...data, updatedAt: new Date() };
          executionsDb.set(foundKey, updated);
          return updated;
        }),
        updateMany: jest.fn().mockImplementation(async ({ where, data }) => {
          let updatedCount = 0;
          for (const key of executionsDb.keys()) {
            const item = executionsDb.get(key);
            if (item.id === where.id) {
              if (where.state) {
                const targetStates = Array.isArray(where.state.in)
                  ? where.state.in
                  : [where.state];
                if (!targetStates.includes(item.state)) continue;
              }
              executionsDb.set(key, { ...item, ...data, updatedAt: new Date() });
              updatedCount++;
            }
          }
          return { count: updatedCount };
        }),
        findUnique: jest.fn().mockImplementation(async ({ where }) => {
          const foundKey = Array.from(executionsDb.keys()).find(
            (k) => executionsDb.get(k).id === where.id,
          );
          return foundKey ? executionsDb.get(foundKey) : null;
        }),
      },
    };

    mockPaperTradingService = {
      getPortfolio: jest.fn().mockResolvedValue({ openPositions: [] }),
      getValidatedMarketPrice: jest.fn().mockResolvedValue({ price: 65000, timestamp: new Date() }),
      placeOrder: jest.fn().mockRejectedValue(new Error('Broker connection refused (503)')),
    };

    mockAlertsService = {
      sendAlert: jest.fn().mockResolvedValue({ success: true }),
    };

    service = new AlgoBotsService(
      mockPaperTradingService,
      mockAlertsService,
      prismaClient as unknown as PrismaService,
      null as any,
    );
  });

  afterEach(() => {
    delete process.env.PAPER_TRADING_ENABLED;
  });

  const validSignal: ISignalSetup = {
    id: 'sig_sm_btc',
    symbol: 'BTCUSDT',
    timeframe: Timeframe.M15,
    direction: Direction.BULLISH,
    state: SignalState.ACTIVE,
    grade: SignalGrade.A_PLUS,
    score: 85,
    canonicalCandleTime: canonicalMs,
    canonicalDecisionTime: canonicalDate,
    timestamp: canonicalDate,
    entryZone: { min: 64000, max: 65000, optimal: 64500 },
    stopLoss: 64000,
    takeProfits: { tp1: 65500, tp2: 66000, tp3: 67000 },
    riskRewardRatios: { rr1: 2, rr2: 3, rr3: 5 },
    reasoning: {} as any,
    reasons: [],
    scoreBreakdown: {} as any,
    triggerEvidence: { orderBlock: { matched: true } },
  };

  it('correctly transitions state machine: RESERVED -> EXECUTING -> FAILED_FINAL on placeOrder failure', async () => {
    const results = await service.evaluateSignalForBots(validSignal);

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('FAILED');
    expect(results[0].reasonCode).toBe('UNKNOWN_EXECUTION_ERROR');
    expect(results[0].details).toContain('Broker connection refused');

    // Inspect the stored record state in executionsDb
    const records = Array.from(executionsDb.values());
    expect(records).toHaveLength(1);
    expect(records[0].state).toBe('FAILED_FINAL');
    expect(records[0].failureReasonCode).toBe('UNKNOWN_EXECUTION_ERROR');
    expect(records[0].failureReason).toContain('Broker connection refused');
  });

  it('prevents re-execution when fingerprint lock already exists in DB', async () => {
    // Pass 1: fails order placement and leaves state as FAILED_FINAL
    await service.evaluateSignalForBots(validSignal);

    // Pass 2: evaluate same signal again
    const resultsPass2 = await service.evaluateSignalForBots(validSignal);

    expect(resultsPass2).toHaveLength(1);
    expect(resultsPass2[0].status).toBe('REJECTED');
    expect(resultsPass2[0].reasonCode).toBe('EXECUTION_LOCKED');
    expect(resultsPass2[0].details).toContain('EXECUTION_LOCKED');
  });
});
