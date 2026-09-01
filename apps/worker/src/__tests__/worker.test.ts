import { CandleProcessor } from '../processors/candle.processor';
import { ScannerProcessor } from '../processors/scanner.processor';
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
});
