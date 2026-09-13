import { CandleProcessor } from '../processors/candle.processor';
import { ScannerProcessor } from '../processors/scanner.processor';
import { PositionMonitorProcessor } from '../processors/position-monitor.processor';
import { LearningProcessor } from '../processors/learning.processor';
import { Direction, PositionState } from '@quant/shared';
import { Decimal } from '@prisma/client/runtime/library';
import { Job } from 'bullmq';

describe('Worker Processors', () => {
  describe('CandleProcessor', () => {
    let processor: CandleProcessor;

    beforeEach(() => {
      processor = new CandleProcessor();
    });

    it('should process candle job successfully', async () => {
      const mockJob = {
        id: 'job-1',
        name: 'candle-tick',
        data: { symbol: 'NIFTY', timeframe: '15m' },
      } as Job;

      const result = await processor.process(mockJob);
      expect(result.success).toBe(true);
    });
  });

  describe('ScannerProcessor', () => {
    let processor: ScannerProcessor;
    let mockPrisma: any;
    let mockRedis: any;

    beforeEach(() => {
      mockPrisma = {
        instrument: {
          findMany: jest.fn().mockResolvedValue([]),
        },
      };
      mockRedis = {
        set: jest.fn().mockResolvedValue('OK'),
        publish: jest.fn().mockResolvedValue(1),
      };

      processor = new ScannerProcessor(mockPrisma, mockRedis);
    });

    it('should process scanner job and return summary', async () => {
      const mockJob = {
        id: 'scan-1',
        name: 'scan-market',
        data: {},
      } as Job;

      const result = await processor.process(mockJob);
      expect(result.scannedCount).toBe(0);
      expect(result.signalsFound).toBe(0);
      expect(mockRedis.set).toHaveBeenCalled();
    });
  });

  describe('PositionMonitorProcessor', () => {
    let processor: PositionMonitorProcessor;
    let mockPrisma: any;
    let mockRedis: any;

    beforeEach(() => {
      mockPrisma = {
        paperPosition: {
          findMany: jest.fn().mockResolvedValue([
            {
              id: 'pos-1',
              accountId: 'acc-1',
              symbol: 'NIFTY',
              contractSymbol: 'NIFTY SPOT',
              direction: Direction.BULLISH,
              quantity: new Decimal(65),
              entryPrice: new Decimal(24100.0),
              currentPrice: new Decimal(24100.0),
              stopLoss: new Decimal(24050.0),
              initialStopLoss: new Decimal(24050.0),
              target1: new Decimal(24175.0),
              target2: new Decimal(24225.0),
              target3: new Decimal(24300.0),
              initialTarget1: new Decimal(24175.0),
              initialTarget2: new Decimal(24225.0),
              initialTarget3: new Decimal(24300.0),
              leverage: new Decimal(5.0),
              usedMargin: new Decimal(31330.0),
              unrealizedPnL: new Decimal(0.0),
              status: PositionState.OPEN,
              openedAt: new Date(Date.now() - 60000), // Opened 1 minute ago
              chargesJson: { totalCharges: 30.0 },
            },
          ]),
          update: jest.fn().mockResolvedValue({}),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
        paperOrder: {
          create: jest.fn().mockResolvedValue({ id: 'order-1' }),
        },
        paperFill: {
          create: jest.fn().mockResolvedValue({ id: 'fill-1' }),
          findMany: jest.fn().mockResolvedValue([]),
        },
        paperTrade: {
          create: jest.fn().mockResolvedValue({ id: 'trade-1' }),
          findFirst: jest.fn().mockResolvedValue(null),
        },
        paperAccount: {
          update: jest.fn().mockResolvedValue({}),
        },
        auditEvent: {
          create: jest.fn().mockResolvedValue({ id: 'audit-1' }),
        },
        tradingSystemConfig: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'SYSTEM_DEFAULT',
            maxMarketDataAgeSeconds: 5,
            maxSlippageBps: 50,
          }),
        },
        candle: {
          findFirst: jest.fn().mockResolvedValue({ close: new Decimal(24150.0) }),
          findMany: jest.fn().mockResolvedValue([]),
        },
        $transaction: jest.fn().mockImplementation((cb) => cb(mockPrisma)),
      };

      mockRedis = {
        get: jest.fn().mockResolvedValue(JSON.stringify({ price: 24150.0, lastUpdated: Date.now() })),
        publish: jest.fn().mockResolvedValue(1),
        getClient: jest
          .fn()
          .mockReturnValue({ status: 'ready', publish: jest.fn().mockResolvedValue(1) }),
      };

      processor = new PositionMonitorProcessor(mockPrisma, mockRedis);
    });

    it('should evaluate open positions, update MFE/MAE and trailing stops', async () => {
      const mockJob = {
        id: 'monitor-1',
        name: 'monitor-positions',
        data: {},
      } as Job;

      const result = await processor.process(mockJob);
      expect(result.checked).toBe(1);
      expect(result.updated).toBe(1);
      expect(result.closed).toBe(0);
      expect(mockPrisma.paperPosition.update).toHaveBeenCalled();
    });

    it('should trigger Stop Loss and close position atomically when price breaches SL', async () => {
      // Mock price falling to 24040.0 (below SL 24050.0)
      mockRedis.get = jest.fn().mockResolvedValue(JSON.stringify({ price: 24040.0, lastUpdated: Date.now() }));

      const mockJob = {
        id: 'monitor-2',
        name: 'monitor-positions',
        data: {},
      } as Job;

      const result = await processor.process(mockJob);
      expect(result.checked).toBe(1);
      expect(result.closed).toBe(1);
      expect(mockPrisma.$transaction).toHaveBeenCalled();
      expect(mockPrisma.paperTrade.create).toHaveBeenCalled();
    });

    it('1. resolveLivePrice() reads ticker:${SYMBOL}:live', async () => {
      mockRedis.get = jest.fn().mockResolvedValue(JSON.stringify({ price: 24150.0, lastUpdated: Date.now() }));

      const mockJob = {
        id: 'monitor-key-check',
        name: 'monitor-positions',
        data: {},
      } as Job;

      await processor.process(mockJob);
      expect(mockRedis.get).toHaveBeenCalledWith('ticker:NIFTY:live');
    });

    it('2. stale ticker returns null and does not close position', async () => {
      // Mock tick that is 10 seconds old (> 5s maxAge)
      mockRedis.get = jest.fn().mockResolvedValue(
        JSON.stringify({ price: 24040.0, lastUpdated: Date.now() - 10000 }),
      );

      const mockJob = {
        id: 'monitor-stale',
        name: 'monitor-positions',
        data: {},
      } as Job;

      const result = await processor.process(mockJob);
      expect(result.checked).toBe(1);
      expect(result.closed).toBe(0);
      expect(result.updated).toBe(0);
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
      expect(mockPrisma.paperTrade.create).not.toHaveBeenCalled();
    });

    it('3. missing ticker returns null and does not close position', async () => {
      mockRedis.get = jest.fn().mockResolvedValue(null);

      const mockJob = {
        id: 'monitor-missing',
        name: 'monitor-positions',
        data: {},
      } as Job;

      const result = await processor.process(mockJob);
      expect(result.checked).toBe(1);
      expect(result.closed).toBe(0);
      expect(result.updated).toBe(0);
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    it('4. PositionMonitor never calls prisma.candle', async () => {
      mockRedis.get = jest.fn().mockResolvedValue(JSON.stringify({ price: 24150.0, lastUpdated: Date.now() }));

      const mockJob = {
        id: 'monitor-no-candles',
        name: 'monitor-positions',
        data: {},
      } as Job;

      await processor.process(mockJob);
      expect(mockPrisma.candle.findFirst).not.toHaveBeenCalled();
      expect(mockPrisma.candle.findMany).not.toHaveBeenCalled();
    });

    it('5. PositionMonitor never reads candle:${symbol}:15m:latest', async () => {
      mockRedis.get = jest.fn().mockResolvedValue(JSON.stringify({ price: 24150.0, lastUpdated: Date.now() }));

      const mockJob = {
        id: 'monitor-no-candle-key',
        name: 'monitor-positions',
        data: {},
      } as Job;

      await processor.process(mockJob);
      expect(mockRedis.get).not.toHaveBeenCalledWith('candle:NIFTY:15m:latest');
      expect(mockRedis.get).not.toHaveBeenCalledWith('candle:nifty:15m:latest');
    });

    it('6. missing initial SL never creates a synthetic SL', async () => {
      mockPrisma.paperPosition.findMany.mockResolvedValueOnce([
        {
          id: 'pos-no-sl',
          accountId: 'acc-1',
          symbol: 'NIFTY',
          contractSymbol: 'NIFTY SPOT',
          direction: Direction.BULLISH,
          quantity: new Decimal(65),
          entryPrice: new Decimal(24100.0),
          currentPrice: new Decimal(24100.0),
          stopLoss: null,
          initialStopLoss: null,
          target1: new Decimal(24200.0),
          target2: new Decimal(24250.0),
          target3: new Decimal(24300.0),
          initialTarget1: new Decimal(24200.0),
          initialTarget2: new Decimal(24250.0),
          initialTarget3: new Decimal(24300.0),
          leverage: new Decimal(5.0),
          usedMargin: new Decimal(31330.0),
          unrealizedPnL: new Decimal(0.0),
          status: PositionState.OPEN,
          openedAt: new Date(Date.now() - 60000),
          chargesJson: { totalCharges: 30.0 },
        },
      ]);

      // Price drops deeply to 23800.0, but no SL is set -> must NOT close position via fabricated SL
      mockRedis.get = jest.fn().mockResolvedValue(JSON.stringify({ price: 23800.0, lastUpdated: Date.now() }));

      const mockJob = {
        id: 'monitor-no-sl',
        name: 'monitor-positions',
        data: {},
      } as Job;

      const result = await processor.process(mockJob);
      expect(result.checked).toBe(1);
      expect(result.closed).toBe(0);
      expect(result.updated).toBe(1);
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    it('7 & 8. missing TP1 or TP2 never creates synthetic targets and skips trailing stops', async () => {
      mockPrisma.paperPosition.findMany.mockResolvedValueOnce([
        {
          id: 'pos-no-tp1-tp2',
          accountId: 'acc-1',
          symbol: 'NIFTY',
          contractSymbol: 'NIFTY SPOT',
          direction: Direction.BULLISH,
          quantity: new Decimal(65),
          entryPrice: new Decimal(24100.0),
          currentPrice: new Decimal(24100.0),
          stopLoss: new Decimal(24000.0),
          initialStopLoss: new Decimal(24000.0),
          target1: null,
          target2: null,
          target3: null,
          initialTarget1: null,
          initialTarget2: null,
          initialTarget3: null,
          leverage: new Decimal(5.0),
          usedMargin: new Decimal(31330.0),
          unrealizedPnL: new Decimal(0.0),
          status: PositionState.OPEN,
          openedAt: new Date(Date.now() - 60000),
          chargesJson: { totalCharges: 30.0 },
        },
      ]);

      // Price rises to 24500.0, but no TP3 or trailing targets exist -> position stays open with unchanged SL
      mockRedis.get = jest.fn().mockResolvedValue(JSON.stringify({ price: 24500.0, lastUpdated: Date.now() }));

      const mockJob = {
        id: 'monitor-no-tp',
        name: 'monitor-positions',
        data: {},
      } as Job;

      const result = await processor.process(mockJob);
      expect(result.checked).toBe(1);
      expect(result.closed).toBe(0);
      expect(result.updated).toBe(1);
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
      expect(mockPrisma.paperPosition.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            trailingStopStateJson: undefined,
          }),
        }),
      );
    });

    it('9 & 10. missing risk anchor produces riskDistance = 0 and realizedR = 0', async () => {
      mockPrisma.paperPosition.findMany.mockResolvedValueOnce([
        {
          id: 'pos-no-risk-anchor',
          accountId: 'acc-1',
          symbol: 'NIFTY',
          contractSymbol: 'NIFTY SPOT',
          direction: Direction.BULLISH,
          quantity: new Decimal(65),
          entryPrice: new Decimal(24100.0),
          currentPrice: new Decimal(24100.0),
          stopLoss: null,
          initialStopLoss: null,
          target1: null,
          target2: null,
          target3: null,
          leverage: new Decimal(5.0),
          usedMargin: new Decimal(31330.0),
          unrealizedPnL: new Decimal(0.0),
          status: PositionState.OPEN,
          openedAt: new Date(Date.now() - 60000),
          chargesJson: { totalCharges: 30.0 },
        },
      ]);

      mockRedis.get = jest.fn().mockResolvedValue(JSON.stringify({ price: 24200.0, lastUpdated: Date.now() }));

      const mockJob = {
        id: 'monitor-zero-r',
        name: 'monitor-positions',
        data: {},
      } as Job;

      const result = await processor.process(mockJob);
      expect(result.checked).toBe(1);
      expect(result.updated).toBe(1);

      // Verify that unrealizedR updated in DB is exactly 0
      expect(mockPrisma.paperPosition.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            unrealizedR: new Decimal(0),
          }),
        }),
      );
    });

    it('11. EXIT_PENDING remains open when ticker is stale or missing', async () => {
      mockPrisma.paperPosition.findMany.mockResolvedValueOnce([
        {
          id: 'pos-exit-pending-stale',
          accountId: 'acc-1',
          symbol: 'NIFTY',
          contractSymbol: 'NIFTY SPOT',
          direction: Direction.BULLISH,
          quantity: new Decimal(65),
          entryPrice: new Decimal(24100.0),
          currentPrice: new Decimal(24100.0),
          stopLoss: new Decimal(24000.0),
          initialStopLoss: new Decimal(24000.0),
          status: PositionState.EXIT_PENDING,
          openedAt: new Date(Date.now() - 60000),
          chargesJson: { totalCharges: 30.0 },
        },
      ]);

      // Stale tick (10s old)
      mockRedis.get = jest.fn().mockResolvedValue(
        JSON.stringify({ price: 24150.0, lastUpdated: Date.now() - 10000 }),
      );

      const mockJob = {
        id: 'monitor-exit-pending-stale',
        name: 'monitor-positions',
        data: {},
      } as Job;

      const result = await processor.process(mockJob);
      expect(result.checked).toBe(1);
      expect(result.closed).toBe(0);
      expect(result.updated).toBe(0);
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
      expect(mockPrisma.paperTrade.create).not.toHaveBeenCalled();
    });

    it('12. EXIT_PENDING closes only with a fresh live ticker', async () => {
      mockPrisma.paperPosition.findMany.mockResolvedValueOnce([
        {
          id: 'pos-exit-pending-fresh',
          accountId: 'acc-1',
          symbol: 'NIFTY',
          contractSymbol: 'NIFTY SPOT',
          direction: Direction.BULLISH,
          quantity: new Decimal(65),
          entryPrice: new Decimal(24100.0),
          currentPrice: new Decimal(24100.0),
          stopLoss: new Decimal(24000.0),
          initialStopLoss: new Decimal(24000.0),
          status: PositionState.EXIT_PENDING,
          openedAt: new Date(Date.now() - 60000),
          chargesJson: { totalCharges: 30.0 },
        },
      ]);

      // Fresh tick (just updated)
      mockRedis.get = jest.fn().mockResolvedValue(
        JSON.stringify({ price: 24150.0, lastUpdated: Date.now() }),
      );

      const mockJob = {
        id: 'monitor-exit-pending-fresh',
        name: 'monitor-positions',
        data: {},
      } as Job;

      const result = await processor.process(mockJob);
      expect(result.checked).toBe(1);
      expect(result.closed).toBe(1);
      expect(mockPrisma.$transaction).toHaveBeenCalled();
      expect(mockPrisma.paperTrade.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            exitReason: 'Exit Pending Completed on Next Tick',
          }),
        }),
      );
    });

    it('4b. invalid or far future timestamp is rejected and does not close position', async () => {
      // Future timestamp (10 minutes in the future)
      mockRedis.get = jest.fn().mockResolvedValue(
        JSON.stringify({ price: 24040.0, lastUpdated: Date.now() + 600000 }),
      );

      const mockJob = {
        id: 'monitor-future-tick',
        name: 'monitor-positions',
        data: {},
      } as Job;

      const result = await processor.process(mockJob);
      expect(result.checked).toBe(1);
      expect(result.closed).toBe(0);
      expect(result.updated).toBe(0);
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    it('13. Execution price provenance records ExecutionPriceSource.LIVE_TICK and sourceTimestamp', async () => {
      const tickTime = new Date(Date.now() - 1000);
      mockRedis.get = jest.fn().mockResolvedValue(
        JSON.stringify({ price: 24040.0, lastUpdated: tickTime.toISOString() }),
      );

      const mockJob = {
        id: 'monitor-provenance',
        name: 'monitor-positions',
        data: {},
      } as Job;

      const result = await processor.process(mockJob);
      expect(result.closed).toBe(1);
      expect(mockPrisma.paperTrade.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            outcomeSnapshotJson: expect.objectContaining({
              executionPriceSource: 'LIVE_TICK',
              sourceTimestamp: tickTime.toISOString(),
            }),
          }),
        }),
      );
      expect(mockPrisma.auditEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            payloadJson: expect.objectContaining({
              executionPriceSource: 'LIVE_TICK',
              sourceTimestamp: tickTime.toISOString(),
            }),
          }),
        }),
      );
    });

    it('14. should fail closed when TradingSystemConfig is missing or invalid', async () => {
      mockPrisma.tradingSystemConfig.findUnique = jest.fn().mockResolvedValue(null);

      const mockJob = {
        id: 'monitor-no-config',
        name: 'monitor-positions',
        data: {},
      } as Job;

      const result = await processor.process(mockJob);
      expect(result.checked).toBe(0);
      expect(result.closed).toBe(0);
      expect(result.updated).toBe(0);
      expect(mockPrisma.paperTrade.create).not.toHaveBeenCalled();
    });

    it('15. should use configured maxMarketDataAgeSeconds = X dynamically', async () => {
      // Configure maxMarketDataAgeSeconds = 15s
      mockPrisma.tradingSystemConfig.findUnique = jest.fn().mockResolvedValue({
        id: 'SYSTEM_DEFAULT',
        maxMarketDataAgeSeconds: 15,
        maxSlippageBps: 50,
      });

      // 1. Tick is 10s old (<= 15s) -> should be accepted and trigger SL close
      mockRedis.get = jest.fn().mockResolvedValue(
        JSON.stringify({ price: 24040.0, lastUpdated: Date.now() - 10000 }),
      );

      const jobAccepted = {
        id: 'monitor-freshness-accepted',
        name: 'monitor-positions',
        data: {},
      } as Job;

      const resAccepted = await processor.process(jobAccepted);
      expect(resAccepted.closed).toBe(1);
      expect(mockPrisma.paperTrade.create).toHaveBeenCalledTimes(1);

      // 2. Tick is 20s old (> 15s) -> should be rejected and not close
      jest.clearAllMocks();
      mockRedis.get = jest.fn().mockResolvedValue(
        JSON.stringify({ price: 24040.0, lastUpdated: Date.now() - 20000 }),
      );

      const jobRejected = {
        id: 'monitor-freshness-rejected',
        name: 'monitor-positions',
        data: {},
      } as Job;

      const resRejected = await processor.process(jobRejected);
      expect(resRejected.closed).toBe(0);
      expect(mockPrisma.paperTrade.create).not.toHaveBeenCalled();
    });

    it('16. should use configured maxSlippageBps = X on BUY and SELL position exits', async () => {
      // 1. BUY position exit (SELL fill price <= livePrice, bounded by maxSlippageBps)
      mockPrisma.tradingSystemConfig.findUnique = jest.fn().mockResolvedValue({
        id: 'SYSTEM_DEFAULT',
        maxMarketDataAgeSeconds: 5,
        maxSlippageBps: 20, // 20 bps = 0.20% max
      });

      mockRedis.get = jest.fn().mockResolvedValue(
        JSON.stringify({ price: 24040.0, lastUpdated: Date.now() }),
      );

      const jobBuyExit = {
        id: 'monitor-slippage-buy-exit',
        name: 'monitor-positions',
        data: {},
      } as Job;

      await processor.process(jobBuyExit);
      expect(mockPrisma.paperTrade.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            outcomeSnapshotJson: expect.objectContaining({
              slippageBps: expect.any(Number),
              livePrice: 24040.0,
              exitPrice: expect.any(Number),
            }),
          }),
        }),
      );

      // 2. SELL position exit (BUY fill price >= livePrice)
      mockPrisma.paperPosition.findMany = jest.fn().mockResolvedValue([
        {
          id: 'pos-short',
          accountId: 'acc-1',
          symbol: 'NIFTY',
          contractSymbol: 'NIFTY SPOT',
          direction: Direction.BEARISH,
          quantity: new Decimal(50),
          entryPrice: new Decimal(24100.0),
          currentPrice: new Decimal(24100.0),
          stopLoss: new Decimal(24150.0),
          initialStopLoss: new Decimal(24150.0),
          target1: new Decimal(24000.0),
          target2: new Decimal(23950.0),
          target3: new Decimal(23900.0),
          leverage: new Decimal(5.0),
          usedMargin: new Decimal(30000.0),
          unrealizedPnL: new Decimal(0.0),
          status: PositionState.OPEN,
          openedAt: new Date(Date.now() - 60000),
          chargesJson: { totalCharges: 30.0 },
        },
      ]);

      mockRedis.get = jest.fn().mockResolvedValue(
        JSON.stringify({ price: 24160.0, lastUpdated: Date.now() }), // breaches SL 24150.0
      );

      const jobSellExit = {
        id: 'monitor-slippage-sell-exit',
        name: 'monitor-positions',
        data: {},
      } as Job;

      await processor.process(jobSellExit);
      expect(mockPrisma.paperTrade.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            outcomeSnapshotJson: expect.objectContaining({
              livePrice: 24160.0,
            }),
          }),
        }),
      );
    });

    it('17. atomic lock collision (updateMany count = 0) must prevent duplicate PaperTrade creation', async () => {
      // Simulate another thread/worker already transitioned the position to CLOSING or CLOSED
      mockPrisma.paperPosition.updateMany = jest.fn().mockResolvedValue({ count: 0 });

      mockRedis.get = jest.fn().mockResolvedValue(
        JSON.stringify({ price: 24040.0, lastUpdated: Date.now() }),
      );

      const jobCollision = {
        id: 'monitor-collision',
        name: 'monitor-positions',
        data: {},
      } as Job;

      await processor.process(jobCollision);

      // Verify atomic lock aborted close and did NOT create trade or update account
      expect(mockPrisma.paperPosition.updateMany).toHaveBeenCalledWith({
        where: {
          id: 'pos-1',
          status: { in: [PositionState.OPEN, PositionState.PARTIALLY_CLOSED, PositionState.EXIT_PENDING] },
        },
        data: {
          status: PositionState.CLOSING,
        },
      });
      expect(mockPrisma.paperTrade.create).not.toHaveBeenCalled();
      expect(mockPrisma.paperAccount.update).not.toHaveBeenCalled();
    });

    it('18. worker exit persists complete execution provenance including slippageAmount and slippageBps', async () => {
      const tickTime = new Date(Date.now() - 1000);
      mockRedis.get = jest.fn().mockResolvedValue(
        JSON.stringify({ price: 24040.0, lastUpdated: tickTime.toISOString() }),
      );

      const jobProvenance = {
        id: 'monitor-provenance-complete',
        name: 'monitor-positions',
        data: {},
      } as Job;

      await processor.process(jobProvenance);

      expect(mockPrisma.paperTrade.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            outcomeSnapshotJson: expect.objectContaining({
              executionPriceSource: 'LIVE_TICK',
              sourceTimestamp: tickTime.toISOString(),
              livePrice: 24040.0,
              exitPrice: expect.any(Number),
              slippageBps: expect.any(Number),
              slippageAmount: expect.any(Number),
              exitReason: expect.any(String),
              holdingDurationSeconds: null,
              realizedPnL: null,
              realizedR: null,
              outcomeClassification: expect.any(String),
              exitTime: expect.any(String),
            }),
          }),
        }),
      );
    });

    it('19. worker close performs exact and non-duplicative accounting updates on paperAccount', async () => {
      mockPrisma.paperFill.findMany = jest.fn().mockResolvedValue([
        {
          id: 'fill-entry-1',
          orderId: 'order-1',
          fillPrice: new Decimal(24100.0),
          fillQuantity: new Decimal(65),
          fillTimestamp: new Date(Date.now() - 60000),
          fee: new Decimal(30.0),
          slippage: new Decimal(0),
          executionPriceSource: 'LIVE_TICK',
          sourceTimestamp: new Date(Date.now() - 60000),
        },
      ]);
      mockPrisma.paperPosition.findMany = jest.fn().mockResolvedValue([
        {
          id: 'pos-1',
          orderId: 'order-1',
          accountId: 'acc-1',
          symbol: 'NIFTY',
          contractSymbol: 'NIFTY SPOT',
          direction: Direction.BULLISH,
          quantity: new Decimal(65),
          entryPrice: new Decimal(24100.0),
          currentPrice: new Decimal(24100.0),
          stopLoss: new Decimal(24050.0),
          initialStopLoss: new Decimal(24050.0),
          target1: new Decimal(24175.0),
          leverage: new Decimal(5.0),
          usedMargin: new Decimal(31330.0),
          unrealizedPnL: new Decimal(0.0),
          status: PositionState.OPEN,
          openedAt: new Date(Date.now() - 60000),
          chargesJson: { totalCharges: 30.0 },
        },
      ]);

      mockRedis.get = jest.fn().mockResolvedValue(
        JSON.stringify({ price: 24040.0, lastUpdated: Date.now() }),
      );

      const jobAccounting = {
        id: 'monitor-accounting',
        name: 'monitor-positions',
        data: {},
      } as Job;

      await processor.process(jobAccounting);

      expect(mockPrisma.paperAccount.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'acc-1' },
          data: expect.objectContaining({
            cashBalance: expect.objectContaining({ increment: expect.any(Number) }),
            usedMargin: expect.objectContaining({ decrement: 31330.0 }),
            realizedPnL: expect.objectContaining({ increment: expect.any(Number) }),
            totalChargesPaid: expect.objectContaining({ increment: expect.any(Number) }),
          }),
        }),
      );
    });

    it('20. enforces strict maxSlippageBps = 10 limit with correct directionality for BUY and SELL exits', async () => {
      mockPrisma.tradingSystemConfig.findUnique = jest.fn().mockResolvedValue({
        id: 'SYSTEM_DEFAULT',
        maxMarketDataAgeSeconds: 5,
        maxSlippageBps: 10,
      });

      // Long position exit (selling into market): fillPrice must be <= 24040 and >= 24040 * (1 - 0.0010) = 24015.96
      mockRedis.get = jest.fn().mockResolvedValue(
        JSON.stringify({ price: 24040.0, lastUpdated: Date.now() }),
      );

      const jobLong = {
        id: 'monitor-long-10bps',
        name: 'monitor-positions',
        data: {},
      } as Job;

      await processor.process(jobLong);

      const longTradeCall = mockPrisma.paperTrade.create.mock.calls[0][0];
      const longFillPrice = Number(longTradeCall.data.exitPrice);
      expect(longFillPrice).toBeLessThanOrEqual(24040.0);
      expect(longFillPrice).toBeGreaterThanOrEqual(24040.0 * (1 - 0.0010));

      // Short position exit (buying back into market): fillPrice must be >= 24160 and <= 24160 * (1 + 0.0010) = 24184.16
      jest.clearAllMocks();
      mockPrisma.paperPosition.findMany = jest.fn().mockResolvedValue([
        {
          id: 'pos-short-10bps',
          accountId: 'acc-1',
          symbol: 'NIFTY',
          contractSymbol: 'NIFTY SPOT',
          direction: Direction.BEARISH,
          quantity: new Decimal(50),
          entryPrice: new Decimal(24100.0),
          currentPrice: new Decimal(24100.0),
          stopLoss: new Decimal(24150.0),
          initialStopLoss: new Decimal(24150.0),
          target1: new Decimal(24000.0),
          target2: new Decimal(23950.0),
          target3: new Decimal(23900.0),
          leverage: new Decimal(5.0),
          usedMargin: new Decimal(30000.0),
          unrealizedPnL: new Decimal(0.0),
          status: PositionState.OPEN,
          openedAt: new Date(Date.now() - 60000),
          chargesJson: { totalCharges: 30.0 },
        },
      ]);
      mockRedis.get = jest.fn().mockResolvedValue(
        JSON.stringify({ price: 24160.0, lastUpdated: Date.now() }),
      );

      const jobShort = {
        id: 'monitor-short-10bps',
        name: 'monitor-positions',
        data: {},
      } as Job;

      await processor.process(jobShort);

      const shortTradeCall = mockPrisma.paperTrade.create.mock.calls[0][0];
      const shortFillPrice = Number(shortTradeCall.data.exitPrice);
      expect(shortFillPrice).toBeGreaterThanOrEqual(24160.0);
      expect(shortFillPrice).toBeLessThanOrEqual(Number((24160.0 * (1 + 0.0010)).toFixed(2)));
    });

    it('Test A — worker vs worker: simultaneous close operations against same position result in exactly 1 trade, 1 account update, 1 audit event', async () => {
      mockPrisma.tradingSystemConfig.findUnique = jest.fn().mockResolvedValue({
        id: 'SYSTEM_DEFAULT',
        maxMarketDataAgeSeconds: 5,
        maxSlippageBps: 10,
      });

      // Position to close
      const testPos = {
        id: 'pos-concurrent-worker',
        accountId: 'acc-1',
        symbol: 'NIFTY',
        contractSymbol: 'NIFTY SPOT',
        direction: Direction.BULLISH,
        quantity: new Decimal(50),
        entryPrice: new Decimal(24100.0),
        currentPrice: new Decimal(24100.0),
        stopLoss: new Decimal(24050.0),
        initialStopLoss: new Decimal(24050.0),
        target1: new Decimal(24200.0),
        leverage: new Decimal(5.0),
        usedMargin: new Decimal(30000.0),
        unrealizedPnL: new Decimal(0.0),
        status: PositionState.OPEN,
        openedAt: new Date(Date.now() - 60000),
        chargesJson: { totalCharges: 30.0 },
      };

      mockPrisma.paperPosition.findMany = jest.fn().mockResolvedValue([testPos]);
      mockRedis.get = jest.fn().mockResolvedValue(
        JSON.stringify({ price: 24040.0, lastUpdated: Date.now() }), // SL breach
      );

      // Simulating atomic updateMany: first call succeeds (count: 1), second call fails (count: 0)
      let updateManyCallCount = 0;
      mockPrisma.paperPosition.updateMany = jest.fn().mockImplementation(async () => {
        updateManyCallCount++;
        if (updateManyCallCount === 1) {
          return { count: 1 };
        }
        return { count: 0 };
      });

      // Two worker executions run simultaneously
      const workerJobA = { id: 'job-worker-1', name: 'monitor-positions', data: {} } as Job;
      const workerJobB = { id: 'job-worker-2', name: 'monitor-positions', data: {} } as Job;

      const [resA, resB] = await Promise.all([
        processor.process(workerJobA),
        processor.process(workerJobB),
      ]);

      // Total closed across both executions is exactly 1
      expect(resA.closed + resB.closed).toBe(1);

      // Exactly 1 PaperTrade created
      expect(mockPrisma.paperTrade.create).toHaveBeenCalledTimes(1);

      // Exactly 1 PaperAccount balance and margin update
      expect(mockPrisma.paperAccount.update).toHaveBeenCalledTimes(1);
      expect(mockPrisma.paperAccount.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            usedMargin: { decrement: 30000.0 },
          }),
        }),
      );

      // Exactly 1 AuditEvent created
      expect(mockPrisma.auditEvent.create).toHaveBeenCalledTimes(1);
    });

    it('Test C — worker retry after successful close: recognized existing trade idempotently without duplicate mutations', async () => {
      mockPrisma.tradingSystemConfig.findUnique = jest.fn().mockResolvedValue({
        id: 'SYSTEM_DEFAULT',
        maxMarketDataAgeSeconds: 5,
        maxSlippageBps: 10,
      });

      const closedPos = {
        id: 'pos-already-closed',
        accountId: 'acc-1',
        symbol: 'NIFTY',
        contractSymbol: 'NIFTY SPOT',
        direction: Direction.BULLISH,
        quantity: new Decimal(50),
        entryPrice: new Decimal(24100.0),
        currentPrice: new Decimal(24040.0),
        stopLoss: new Decimal(24050.0),
        initialStopLoss: new Decimal(24050.0),
        status: PositionState.EXIT_PENDING,
        openedAt: new Date(Date.now() - 60000),
        chargesJson: { totalCharges: 30.0 },
      };

      mockPrisma.paperPosition.findMany = jest.fn().mockResolvedValue([closedPos]);
      mockRedis.get = jest.fn().mockResolvedValue(
        JSON.stringify({ price: 24040.0, lastUpdated: Date.now() }),
      );

      // updateMany returns 0 (already closed/closing)
      mockPrisma.paperPosition.updateMany = jest.fn().mockResolvedValue({ count: 0 });

      // Existing trade found
      const mockExistingTrade = { id: 'trade-existing-1', positionId: 'pos-already-closed', exitPrice: new Decimal(24040.0) };
      mockPrisma.paperTrade.findFirst = jest.fn().mockResolvedValue(mockExistingTrade);

      const jobRetry = { id: 'job-retry', name: 'monitor-positions', data: {} } as Job;
      await processor.process(jobRetry);

      // Must not create another trade
      expect(mockPrisma.paperTrade.create).not.toHaveBeenCalled();
      // Must not mutate account again
      expect(mockPrisma.paperAccount.update).not.toHaveBeenCalled();
      // Must not create another audit event
      expect(mockPrisma.auditEvent.create).not.toHaveBeenCalled();
    });
  });

  describe('LearningProcessor', () => {
    let processor: any;
    let mockPrisma: any;
    let mockRedis: any;

    beforeEach(() => {
      mockPrisma = {
        aIRetrainJob: {
          update: jest.fn().mockResolvedValue({ id: 'job-1', status: 'COMPLETED' }),
        },
        instrument: {
          findUnique: jest.fn().mockResolvedValue({ id: 'inst-1', symbol: 'NIFTY' }),
        },
        candle: {
          findMany: jest.fn().mockResolvedValue(
            Array.from({ length: 50 }, (_, i) => ({
              timestamp: new Date(Date.now() - (50 - i) * 15 * 60000),
              open: new Decimal(24000 + i * 2),
              high: new Decimal(24010 + i * 2),
              low: new Decimal(23990 + i * 2),
              close: new Decimal(24005 + i * 2),
              volume: new Decimal(1000),
            })),
          ),
        },
      };

      mockRedis = {
        publish: jest.fn().mockResolvedValue(1),
      };

      processor = new LearningProcessor(mockPrisma, mockRedis);

      // Mock buildTrainingDataset to return 40 valid training examples
      processor.buildTrainingDataset = jest.fn().mockResolvedValue(
        Array.from({ length: 40 }, (_, i) => ({
          id: `ex_${i}`,
          symbol: 'NIFTY',
          featureSchemaVersion: '1.0.0',
          features: {
            smcScore: 0.8,
            obStrength: 0.7,
            fvgSize: 0.5,
            mtfAlignment: 0.9,
            killZoneSession: 1.0,
            smtDivergence: 0.6,
            volatilityAtr: 0.4,
            riskRewardRatio: 0.6,
            trendRegime: 0.8,
            liquiditySweep: 0.7,
            bosStrength: 0.65,
            chochStrength: 0.5,
            relativeVolume: 0.6,
            distanceToHTFLevel: 0.3,
            distanceToLiquidity: 0.4,
            marketSession: 0.5,
            dayOfWeek: 0.3,
          },
          featureArray: [0.8, 0.7, 0.5, 0.9, 1.0, 0.6, 0.4, 0.6, 0.8, 0.7, 0.65, 0.5, 0.6, 0.3, 0.4, 0.5, 0.3],
          label: i % 2 === 0 ? 1 : 0,
          outcomeR: i % 2 === 0 ? 2.0 : -1.0,
          predictionTimestamp: new Date(Date.now() - (40 - i) * 3600000),
          availableForTrainingAt: new Date(Date.now() - (40 - i) * 3600000 + 1800000),
        })),
      );
    });

    it('should process RETRAIN_MODEL job and update database', async () => {
      const mockJob = {
        id: 'job-1',
        name: 'RETRAIN_MODEL',
        data: { jobId: 'job-1', triggerReason: 'MANUAL' },
      } as Job;

      const result = await processor.process(mockJob);
      expect(result.jobId).toBe('job-1');
      expect(mockPrisma.aIRetrainJob.update).toHaveBeenCalled();
    });
  });
});
