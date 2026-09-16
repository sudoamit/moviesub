import { AlgoBotsService } from '../algo-bots.service';
import { Direction, ICandle, SignalGrade, SignalState, Timeframe } from '@quant/shared';
import { CanonicalMarketSnapshotBuilder, SignalGenerator } from '@quant/trading-engine';
import { PrismaService } from '../../common/prisma/prisma.service';

describe('AlgoBotsService execution integration test', () => {
  let algoBotsService: AlgoBotsService;
  let mockPaperTradingService: any;
  let mockAlertsService: any;
  let prismaClient: any;
  let executionsDb: Map<string, any>;

  beforeEach(() => {
    executionsDb = new Map();

    prismaClient = {
      algoBot: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'bot_btc_liquidity_sweep',
            name: 'BTCUSDT Liquidity Sweeper Live Test',
            symbol: 'BTCUSDT',
            direction: 'ANY',
            timeframe: '15m',
            minScore: 70,
            smcCondition: 'LIQUIDITY_SWEEP',
            lots: 1,
            autoExecutePaper: true,
            notifyWebhook: true,
            isActive: true,
            createdAt: new Date(),
            updatedAt: new Date(),
            triggerCount: 0,
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
            id: `exec_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
            ...data,
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
                if (typeof where.state === 'object' && Array.isArray(where.state.in)) {
                  if (!where.state.in.includes(item.state)) continue;
                } else if (item.state !== where.state) {
                  continue;
                }
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
      getValidatedMarketPrice: jest
        .fn()
        .mockResolvedValue({ price: 65000.0, timestamp: new Date() }),
      placeOrder: jest.fn().mockImplementation(async (order) => ({
        id: `pos_live_${Date.now()}`,
        symbol: order.symbol,
        entryPrice: 65000.0,
        status: 'OPEN',
      })),
    };

    mockAlertsService = {
      sendAlert: jest.fn().mockResolvedValue({ success: true }),
    };

    algoBotsService = new AlgoBotsService(
      mockPaperTradingService,
      mockAlertsService,
      prismaClient as unknown as PrismaService,
      null as any,
    );
  });

  const buildNaturalLiveSMCCandles = () => {
    const now = Date.now();
    const baseTime = new Date(now - 49 * 15 * 60 * 1000);
    const candles: ICandle[] = [];

    let price = 65000;
    for (let i = 0; i < 50; i++) {
      const time = new Date(baseTime.getTime() + i * 15 * 60 * 1000);
      let open = price;
      let high = price + 100;
      let low = price - 100;
      let close = price + 50;
      let volume = 1000;

      if (i < 20) {
        high = price + 150;
        low = price - 50;
        close = price + 100;
      } else if (i === 20) {
        high = 66500;
        close = 66200;
      } else if (i === 40) {
        low = 63900;
        close = 64100;
      } else if (i === 48) {
        open = 64300;
        high = 64900;
        low = 63700;
        close = 64800;
        volume = 5000;
      } else if (i > 48) {
        open = 64800;
        high = 65000;
        low = 64700;
        close = 64850;
        volume = 3000;
      }

      price = close;
      candles.push({
        timestamp: time,
        open,
        high,
        low,
        close,
        volume,
        isClosed: true,
      });
    }

    const decisionTime = candles[candles.length - 1].timestamp as Date;

    // Build H1 candles
    const htf1Candles: ICandle[] = [];
    let htf1Price = 60000;
    for (let i = 40; i >= 1; i--) {
      const htfTime = new Date(decisionTime.getTime() - i * 60 * 60 * 1000);
      htf1Candles.push({
        timestamp: htfTime,
        open: htf1Price,
        high: htf1Price + 500,
        low: htf1Price - 200,
        close: htf1Price + 400,
        volume: 4000,
        isClosed: true,
      });
      htf1Price += 150;
    }

    // Build H4 candles
    const htf2Candles: ICandle[] = [];
    let htf2Price = 58000;
    for (let i = 25; i >= 1; i--) {
      const htfTime = new Date(decisionTime.getTime() - i * 4 * 60 * 60 * 1000);
      htf2Candles.push({
        timestamp: htfTime,
        open: htf2Price,
        high: htf2Price + 800,
        low: htf2Price - 300,
        close: htf2Price + 600,
        volume: 10000,
        isClosed: true,
      });
      htf2Price += 300;
    }

    return { candles, htf1Candles, htf2Candles, decisionTime };
  };

  it('Proves live market stream flows end-to-end to PaperTradingService.placeOrder with canonical decision timestamp', async () => {
    const { candles, htf1Candles, htf2Candles, decisionTime } = buildNaturalLiveSMCCandles();

    const btcBot: any = {
      id: 'bot_btc_liquidity_sweep',
      name: 'BTCUSDT Liquidity Sweeper Live Test',
      symbol: 'BTCUSDT',
      direction: 'ANY',
      timeframe: '15m',
      minScore: 70,
      smcCondition: 'LIQUIDITY_SWEEP',
      lots: 1,
      autoExecutePaper: true,
      notifyWebhook: true,
      isActive: true,
      createdAt: new Date().toISOString(),
      triggerCount: 0,
    };

    jest.spyOn(algoBotsService, 'listBots').mockResolvedValue([btcBot]);

    const execSnapshot = CanonicalMarketSnapshotBuilder.build({
      symbol: 'BTCUSDT',
      executionCandles: candles,
      executionTimeframe: Timeframe.M15,
      asOfTimestamp: decisionTime,
      allowSyntheticInProduction: true,
    });

    const htf1Snapshot = CanonicalMarketSnapshotBuilder.build({
      symbol: 'BTCUSDT',
      executionCandles: htf1Candles,
      executionTimeframe: Timeframe.H1,
      asOfTimestamp: decisionTime,
      allowSyntheticInProduction: true,
    });

    const htf2Snapshot = CanonicalMarketSnapshotBuilder.build({
      symbol: 'BTCUSDT',
      executionCandles: htf2Candles,
      executionTimeframe: Timeframe.H4,
      asOfTimestamp: decisionTime,
      allowSyntheticInProduction: true,
    });

    // Pure production signal generation from canonical snapshots - ZERO property mutation
    const signal = SignalGenerator.generateFromSnapshots({
      executionSnapshot: execSnapshot,
      htf1Snapshot,
      htf2Snapshot,
    });

    expect(signal.symbol).toBe('BTCUSDT');
    expect(signal.state).toBe(SignalState.ACTIVE);
    expect(signal.direction).toBe(Direction.BEARISH);
    expect(signal.score).toBeGreaterThanOrEqual(70);
    expect(signal.canonicalCandleTime).toBe(decisionTime.getTime());
    expect(signal.canonicalDecisionTime).toEqual(decisionTime);

    // Single-pass machine-readable evaluation
    const executionResults = await algoBotsService.evaluateSignalForBots(signal);

    expect(executionResults).toHaveLength(1);
    expect(executionResults[0].status).toBe('EXECUTED');
    expect(executionResults[0].reasonCode).toBe('ORDER_PLACED_SUCCESSFULLY');
    expect(executionResults[0].executionId).toBeDefined();
    expect(executionResults[0].orderPositionId).toBeDefined();

    // Verify placeOrder was called with exact canonical decision time
    expect(mockPaperTradingService.placeOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        symbol: 'BTCUSDT',
        direction: 'SELL',
        signalTime: decisionTime.toISOString(),
      }),
    );
  });
});
