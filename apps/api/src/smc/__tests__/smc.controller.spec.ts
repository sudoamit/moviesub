import { Test, TestingModule } from '@nestjs/testing';
import { SMCController } from '../smc.controller';
import { SMCService } from '../smc.service';
import { Direction, MarketRegimeType, Timeframe } from '@quant/shared';

describe('SMCController', () => {
  let controller: SMCController;
  let service: any;

  const mockAnalysis = {
    symbol: 'NIFTY',
    timeframe: '15m',
    candlesCount: 100,
    swingPoints: [],
    breaksOfStructure: [],
    changesOfCharacter: [],
    liquidityPools: [],
    liquiditySweeps: [],
    fairValueGaps: [],
    activeFVGs: [],
    orderBlocks: [],
    activeOrderBlocks: [],
    dealingRange: null,
    marketRegime: {
      regime: MarketRegimeType.BULLISH_TREND,
      atr: 50,
      adx: 28,
      volatility: 0.2,
      timestamp: new Date(),
    },
    currentTrend: Direction.BULLISH,
  };

  beforeEach(async () => {
    service = {
      getSMCAnalysis: jest.fn().mockResolvedValue(mockAnalysis),
      getMarketStructure: jest.fn().mockResolvedValue({
        symbol: 'NIFTY',
        timeframe: '15m',
        swingPoints: [],
        breaksOfStructure: [],
        changesOfCharacter: [],
        currentTrend: Direction.BULLISH,
      }),
      getLiquidity: jest.fn().mockResolvedValue({
        symbol: 'NIFTY',
        timeframe: '15m',
        pools: [],
        sweeps: [],
      }),
      getFairValueGaps: jest.fn().mockResolvedValue({
        symbol: 'NIFTY',
        timeframe: '15m',
        allFVGs: [],
        activeFVGs: [],
      }),
      getOrderBlocks: jest.fn().mockResolvedValue({
        symbol: 'NIFTY',
        timeframe: '15m',
        allOrderBlocks: [],
        activeOrderBlocks: [],
      }),
      getMarketRegime: jest.fn().mockResolvedValue({
        symbol: 'NIFTY',
        timeframe: '15m',
        regime: mockAnalysis.marketRegime,
        dealingRange: null,
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [SMCController],
      providers: [{ provide: SMCService, useValue: service }],
    }).compile();

    controller = module.get<SMCController>(SMCController);
  });

  it('should return market structure for symbol', async () => {
    const res = await controller.getMarketStructure('NIFTY', Timeframe.M15);
    expect(res.symbol).toBe('NIFTY');
    expect(res.currentTrend).toBe(Direction.BULLISH);
  });

  it('should return market regime', async () => {
    const res = await controller.getMarketRegime('NIFTY', Timeframe.M15);
    expect(res.regime.regime).toBe(MarketRegimeType.BULLISH_TREND);
  });
});
