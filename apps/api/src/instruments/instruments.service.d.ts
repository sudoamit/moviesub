import { PrismaService } from '../common/prisma/prisma.service';
import { IInstrument } from '@quant/shared';
export declare class InstrumentsService {
    private readonly prisma;
    private readonly logger;
    constructor(prisma: PrismaService);
    findAll(activeOnly?: boolean): Promise<IInstrument[]>;
    findBySymbol(symbol: string): Promise<IInstrument | null>;
}
