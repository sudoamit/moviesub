import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { IInstrument, InstrumentDefinition } from '@quant/shared';
import { InstrumentMasterService } from '../trading-domain/instrument-master.service';

@Injectable()
export class InstrumentsService {
  private readonly logger = new Logger(InstrumentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly instrumentMaster: InstrumentMasterService,
  ) {}

  async findAll(activeOnly = true): Promise<IInstrument[]> {
    const instruments = await this.prisma.instrument.findMany({
      where: activeOnly ? { isActive: true } : {},
      orderBy: { symbol: 'asc' },
    });

    const mapped: IInstrument[] = instruments.map((inst) => ({
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

    // Ensure authoritative BTCUSDT_SPOT and BTCUSDT_PERP are exposed
    const btc = mapped.find((i) => i.symbol === 'BTCUSDT');
    if (btc && !mapped.some((i) => i.symbol === 'BTCUSDT_SPOT')) {
      mapped.push({
        ...btc,
        symbol: 'BTCUSDT_SPOT',
        name: 'Bitcoin / Tether USD (Spot)',
      });
    }

    if (!mapped.some((i) => i.symbol === 'BTCUSDT_PERP')) {
      mapped.push({
        id: 'inst_btcusdt_perp',
        symbol: 'BTCUSDT_PERP',
        name: 'Bitcoin / Tether USD Perpetual Futures',
        exchange: 'BINANCE',
        assetType: 'CRYPTO' as any,
        tickSize: 0.1,
        lotSize: 0.001,
        contractSize: 1,
        currency: 'USDT',
        isActive: false, // Perpetual execution disabled in spot architecture
        tradingHoursJson: { timezone: 'UTC' },
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

    if (inst) {
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

    // Fall back to authoritative InstrumentMasterService
    try {
      const def = await this.instrumentMaster.getInstrument(sym);
      return {
        id: def.id,
        symbol: def.symbol,
        name: `${def.symbol} (${def.instrumentType})`,
        exchange: def.exchange,
        assetType: (def.quoteCurrency === 'USDT' ? 'CRYPTO' : def.instrumentType === 'OPTION' ? 'OPTION' : 'INDEX') as any,
        tickSize: Number(def.tickSize.toString()),
        lotSize: def.lotSize ? Number(def.lotSize.toString()) : 1,
        contractSize: Number(def.contractSize.toString()),
        currency: def.quoteCurrency,
        tradingHoursJson: { timezone: def.tradingTimezone },
        isActive: def.instrumentType !== 'PERPETUAL',
      };
    } catch {
      return null;
    }
  }

  async getInstrumentDefinition(symbol: string): Promise<InstrumentDefinition> {
    return this.instrumentMaster.getInstrument(symbol);
  }
}
