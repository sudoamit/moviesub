import { CandleProcessor } from '../processors/candle.processor';
import { ScannerProcessor } from '../processors/scanner.processor';
import { PositionMonitorProcessor } from '../processors/position-monitor.processor';
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
        },
        $transaction: jest.fn().mockImplementation((cb) => cb(mockPrisma)),
      };

      mockRedis = {
        get: jest.fn().mockResolvedValue(JSON.stringify({ close: 24150.0 })),
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
      mockRedis.get = jest.fn().mockResolvedValue(JSON.stringify({ close: 24040.0 }));

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
  });
});
