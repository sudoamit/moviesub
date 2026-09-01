import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { CandlesService } from '../candles/candles.service';
import { BacktestSimulator } from '@quant/backtesting';
import { Timeframe, toPrismaTimeframe } from '@quant/shared';
import { RunBacktestDto } from './dto/run-backtest.dto';
import { Decimal } from '@prisma/client/runtime/library';

@Injectable()
export class BacktestsService {
  private readonly logger = new Logger(BacktestsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly candlesService: CandlesService,
  ) {}

  async runBacktest(dto: RunBacktestDto) {
    const sym = dto.symbol.toUpperCase();
    const timeframe = dto.timeframe || Timeframe.M15;

    const inst = await this.prisma.instrument.findUnique({
      where: { symbol: sym },
    });

    if (!inst) {
      throw new NotFoundException(`Instrument '${sym}' not found`);
    }

    const candlesRes = await this.candlesService.getCandles({
      symbol: sym,
      timeframe,
      limit: dto.limit || 300,
    });

    const simulation = BacktestSimulator.runSimulation({
      symbol: sym,
      timeframe,
      candles: candlesRes.candles,
      initialCapital: dto.initialCapital || 100000,
      riskPerTradePercent: dto.riskPerTradePercent || 1.0,
      minScore: dto.minScore || 65,
      lotSize: sym === 'BTCUSDT' ? 0.01 : (inst.lotSize || 1),
    });

    const startDate = candlesRes.candles[0]?.timestamp || new Date();
    const endDate = candlesRes.candles[candlesRes.candles.length - 1]?.timestamp || new Date();
    const prismaTf = toPrismaTimeframe(timeframe);

    // Save to Database
    const savedRun = await this.prisma.backtest.create({
      data: {
        instrumentId: inst.id,
        timeframe: prismaTf,
        startDate,
        endDate,
        initialCapital: new Decimal(simulation.initialCapital),
        riskPerTradePercent: new Decimal(dto.riskPerTradePercent || 1.0),
        netPnL: new Decimal(simulation.netPnL),
        winRate: new Decimal(simulation.winRate),
        profitFactor: new Decimal(simulation.profitFactor),
        maxDrawdownPercent: new Decimal(simulation.maxDrawdownPercent),
        maxConsecutiveLosses: simulation.maxConsecutiveLosses,
        totalTrades: simulation.totalTrades,
        winningTrades: simulation.winningTrades,
        losingTrades: simulation.losingTrades,
        expectancy: new Decimal(simulation.expectancy),
        averageR: new Decimal(simulation.averageR),
        sharpeRatio: simulation.sharpeRatio ? new Decimal(simulation.sharpeRatio) : null,
        parametersJson: {
          ...dto,
          equityCurve: simulation.equityCurve,
        } as any,
      },
    });

    // Save individual trades if any
    for (const tr of simulation.trades) {
      await this.prisma.backtestTrade.create({
        data: {
          backtestId: savedRun.id,
          direction: tr.direction as any,
          entryTime: tr.entryTime,
          exitTime: tr.exitTime,
          entryPrice: new Decimal(tr.entryPrice),
          exitPrice: new Decimal(tr.exitPrice),
          stopLoss: new Decimal(tr.stopLoss),
          takeProfit: new Decimal(tr.takeProfit),
          positionSize: new Decimal(tr.positionSize),
          pnl: new Decimal(tr.pnl),
          pnlRMultiple: new Decimal(tr.pnlRMultiple),
          exitReason: tr.exitReason as any,
        },
      });
    }

    this.logger.log(
      `Backtest completed for ${sym} [${timeframe}]. Total trades: ${simulation.totalTrades}, Win Rate: ${simulation.winRate}%, Net PnL: ${simulation.netPnL}`,
    );

    return {
      ...simulation,
      id: savedRun.id,
    };
  }

  async listBacktests() {
    return this.prisma.backtest.findMany({
      include: {
        instrument: {
          select: { symbol: true, name: true, assetType: true },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
  }

  async getBacktestById(id: string) {
    const run = await this.prisma.backtest.findUnique({
      where: { id },
      include: {
        instrument: true,
        trades: {
          orderBy: { entryTime: 'asc' },
        },
      },
    });

    if (!run) {
      throw new NotFoundException(`Backtest run with id '${id}' not found`);
    }

    return run;
  }
}
