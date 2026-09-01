import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { IInstrument } from '@quant/shared';

@Injectable()
export class InstrumentsService {
  private readonly logger = new Logger(InstrumentsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async findAll(activeOnly = true): Promise<IInstrument[]> {
    const instruments = await this.prisma.instrument.findMany({
      where: activeOnly ? { isActive: true } : {},
      orderBy: { symbol: 'asc' },
    });

    return instruments.map((inst) => ({
      id: inst.id,
      symbol: inst.symbol,
      name: inst.name,
      exchange: inst.exchange,
      assetType: inst.assetType as any,
      tickSize: Number(inst.tickSize),
      lotSize: inst.lotSize,
      contractSize: Number(inst.contractSize),
      currency: inst.currency,
      tradingHoursJson: inst.tradingHoursJson as any,
      isActive: inst.isActive,
      createdAt: inst.createdAt,
      updatedAt: inst.updatedAt,
    }));
  }

  async findBySymbol(symbol: string): Promise<IInstrument | null> {
    const inst = await this.prisma.instrument.findUnique({
      where: { symbol: symbol.toUpperCase() },
    });

    if (!inst) return null;

    return {
      id: inst.id,
      symbol: inst.symbol,
      name: inst.name,
      exchange: inst.exchange,
      assetType: inst.assetType as any,
      tickSize: Number(inst.tickSize),
      lotSize: inst.lotSize,
      contractSize: Number(inst.contractSize),
      currency: inst.currency,
      tradingHoursJson: inst.tradingHoursJson as any,
      isActive: inst.isActive,
      createdAt: inst.createdAt,
      updatedAt: inst.updatedAt,
    };
  }
}
