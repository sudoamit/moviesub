import { Test, TestingModule } from '@nestjs/testing';
import { ScannerController } from '../scanner.controller';
import { ScannerService } from '../scanner.service';
import { Timeframe } from '@quant/shared';

describe('ScannerController', () => {
  let controller: ScannerController;
  let service: any;

  const mockScanSummary = {
    timestamp: new Date().toISOString(),
    timeframe: '15m',
    scannedCount: 6,
    signalsFound: 5,
    durationMs: 120,
    signals: [],
  };

  beforeEach(async () => {
    service = {
      triggerScan: jest.fn().mockResolvedValue(mockScanSummary),
      getScannerStatus: jest.fn().mockResolvedValue(mockScanSummary),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [ScannerController],
      providers: [{ provide: ScannerService, useValue: service }],
    }).compile();

    controller = module.get<ScannerController>(ScannerController);
  });

  it('should trigger market scan and return summary', async () => {
    const res = await controller.triggerScan(Timeframe.M15);
    expect(res.scannedCount).toBe(6);
    expect(res.signalsFound).toBe(5);
  });

  it('should return scanner status', async () => {
    const res = await controller.getStatus();
    expect(res.scannedCount).toBe(6);
  });
});
