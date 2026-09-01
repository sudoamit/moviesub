import { Test, TestingModule } from '@nestjs/testing';
import { CandlesController } from '../candles.controller';
import { CandlesService } from '../candles.service';
import { Timeframe } from '@quant/shared';

describe('CandlesController', () => {
  let controller: CandlesController;
  let service: any;

  const mockCandlesResponse = {
    symbol: 'NIFTY',
    timeframe: '15m',
    count: 2,
    candles: [
      {
        timestamp: new Date('2026-08-28T09:15:00Z'),
        open: 24800,
        high: 24850,
        low: 24780,
        close: 24820,
        volume: 10000,
      },
      {
        timestamp: new Date('2026-08-28T09:30:00Z'),
        open: 24820,
        high: 24870,
        low: 24810,
        close: 24860,
        volume: 12000,
      },
    ],
  };

  beforeEach(async () => {
    service = {
      getCandles: jest.fn().mockResolvedValue(mockCandlesResponse),
      getLatestCandle: jest.fn().mockResolvedValue(mockCandlesResponse.candles[1]),
      ingestCandles: jest.fn().mockResolvedValue({
        symbol: 'NIFTY',
        timeframe: '15m',
        totalReceived: 50,
        validIngested: 50,
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [CandlesController],
      providers: [{ provide: CandlesService, useValue: service }],
    }).compile();

    controller = module.get<CandlesController>(CandlesController);
  });

  it('should return historical candles for valid query', async () => {
    const res = await controller.getCandles({
      symbol: 'NIFTY',
      timeframe: Timeframe.M15,
      limit: 100,
    });

    expect(res.symbol).toBe('NIFTY');
    expect(res.count).toBe(2);
    expect(res.candles).toHaveLength(2);
  });

  it('should return latest candle', async () => {
    const res = await controller.getLatestCandle('NIFTY', Timeframe.M15);
    expect(res.close).toBe(24860);
  });
});
