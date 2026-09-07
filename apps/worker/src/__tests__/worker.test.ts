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
        },
        paperTrade: {
          create: jest.fn().mockResolvedValue({ id: 'trade-1' }),
        },
        paperAccount: {
          update: jest.fn().mockResolvedValue({}),
        },
        auditEvent: {
          create: jest.fn().mockResolvedValue({ id: 'audit-1' }),
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

    it('1 & 4. stale live ticker cannot trigger SL and candle closes are never used as execution prices', async () => {
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

    it('2. missing live ticker cannot trigger SL', async () => {
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

    it('3. position monitor never reads PostgreSQL candles for execution', async () => {
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

    it('5. missing persisted SL does not create a synthetic SL', async () => {
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

    it('6. missing persisted TP does not create a synthetic TP', async () => {
      mockPrisma.paperPosition.findMany.mockResolvedValueOnce([
        {
          id: 'pos-no-tp',
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

      // Price rises to 24500.0, but no TP3 is set -> position remains open
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
    });

    it('7. missing risk anchor produces 0R, not synthetic risk', async () => {
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
