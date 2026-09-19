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

    const mapped = instruments.map((inst) => ({
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

    const btc = mapped.find((i) => i.symbol === 'BTCUSDT');
    if (btc && !mapped.some((i) => i.symbol === 'BTCUSDT_SPOT')) {
      mapped.push({
        ...btc,
        symbol: 'BTCUSDT_SPOT',
        name: 'Bitcoin / Tether USD (Spot)',
      });
    }

    return mapped;
  }

  async findBySymbol(symbol: string): Promise<IInstrument | null> {
    const sym = symbol.toUpperCase();
    let inst = await this.prisma.instrument.findUnique({
      where: { symbol: sym },
    });

    if (!inst && (sym === 'BTCUSDT_SPOT' || sym === 'BTCUSDT')) {
      const alt = sym === 'BTCUSDT_SPOT' ? 'BTCUSDT' : 'BTCUSDT_SPOT';
      inst = await this.prisma.instrument.findUnique({
        where: { symbol: alt },
      });
    }

    if (!inst) return null;

    return {
      id: inst.id,
      symbol: sym,
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
