import { InstrumentsService } from './instruments.service';
import { IInstrument } from '@quant/shared';
export declare class InstrumentsController {
    private readonly instrumentsService;
    constructor(instrumentsService: InstrumentsService);
    getInstruments(): Promise<IInstrument[]>;
    getInstrument(symbol: string): Promise<IInstrument>;
}
