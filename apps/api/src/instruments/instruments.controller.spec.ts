import { Test, TestingModule } from '@nestjs/testing';
import { InstrumentsController } from './instruments.controller';
import { InstrumentsService } from './instruments.service';
import { NotFoundException } from '@nestjs/common';
import { AssetType } from '@quant/shared';

describe('InstrumentsController', () => {
  let controller: InstrumentsController;
  let service: jest.Mocked<Partial<InstrumentsService>>;

  const mockInstrument = {
    id: 'inst-1',
    symbol: 'NIFTY',
    name: 'NIFTY 50 Index',
    exchange: 'NSE',
    assetType: AssetType.INDEX,
    tickSize: 0.05,
    lotSize: 25,
    contractSize: 1,
    currency: 'INR',
    isActive: true,
  };

  beforeEach(async () => {
    service = {
      findAll: jest.fn().mockResolvedValue([mockInstrument]),
      findBySymbol: jest.fn().mockImplementation((sym: string) => {
        if (sym === 'NIFTY') return Promise.resolve(mockInstrument);
        return Promise.resolve(null);
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [InstrumentsController],
      providers: [{ provide: InstrumentsService, useValue: service }],
    }).compile();

    controller = module.get<InstrumentsController>(InstrumentsController);
  });

  it('should return all instruments', async () => {
    const result = await controller.getInstruments();
    expect(result).toHaveLength(1);
    expect(result[0].symbol).toBe('NIFTY');
  });

  it('should return instrument by symbol', async () => {
    const result = await controller.getInstrument('NIFTY');
    expect(result.symbol).toBe('NIFTY');
  });

  it('should throw NotFoundException if symbol does not exist', async () => {
    await expect(controller.getInstrument('UNKNOWN')).rejects.toThrow(NotFoundException);
  });
});
