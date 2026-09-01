import { Controller, Get, Param, NotFoundException } from '@nestjs/common';
import { InstrumentsService } from './instruments.service';
import { IInstrument } from '@quant/shared';

@Controller('api/instruments')
export class InstrumentsController {
  constructor(private readonly instrumentsService: InstrumentsService) {}

  @Get()
  async getInstruments(): Promise<IInstrument[]> {
    return this.instrumentsService.findAll();
  }

  @Get(':symbol')
  async getInstrument(@Param('symbol') symbol: string): Promise<IInstrument> {
    const instrument = await this.instrumentsService.findBySymbol(symbol);
    if (!instrument) {
      throw new NotFoundException(`Instrument with symbol '${symbol}' not found`);
    }
    return instrument;
  }
}
