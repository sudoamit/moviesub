import { Test, TestingModule } from '@nestjs/testing';
import { BacktestsController } from '../backtests.controller';
import { BacktestsService } from '../backtests.service';
import { Timeframe } from '@quant/shared';

describe('BacktestsController', () => {
  let controller: BacktestsController;
  let service: any;

  const mockBacktestResult = {
    id: 'bt-123',
    symbol: 'NIFTY',
    timeframe: '15m',
    totalTrades: 12,
    winningTrades: 8,
    losingTrades: 4,
    winRate: 66.67,
    profitFactor: 2.4,
    netPnL: 8500,
    expectancy: 0.8,
    maxDrawdownPercent: 3.2,
    trades: [],
  };

  beforeEach(async () => {
    service = {
      runBacktest: jest.fn().mockResolvedValue(mockBacktestResult),
      listBacktests: jest.fn().mockResolvedValue([mockBacktestResult]),
      getBacktestById: jest.fn().mockResolvedValue(mockBacktestResult),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [BacktestsController],
      providers: [{ provide: BacktestsService, useValue: service }],
    }).compile();

    controller = module.get<BacktestsController>(BacktestsController);
  });

  it('should run backtest and return metrics', async () => {
    const res = await controller.runBacktest({
      symbol: 'NIFTY',
      timeframe: Timeframe.M15,
      initialCapital: 100000,
    });
    expect(res.symbol).toBe('NIFTY');
    expect(res.winRate).toBe(66.67);
  });

  it('should get backtest by id', async () => {
    const res = await controller.getBacktestById('bt-123');
    expect(res.id).toBe('bt-123');
  });
});
