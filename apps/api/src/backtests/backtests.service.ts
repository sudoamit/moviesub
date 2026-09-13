import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { CandlesService } from '../candles/candles.service';
import { BacktestSimulator } from '@quant/backtesting';
import { Timeframe, toPrismaTimeframe } from '@quant/shared';
import { RunBacktestDto } from './dto/run-backtest.dto';
import { Decimal } from '@prisma/client/runtime/library';
import { SignalState } from '@prisma/client';

/**
 * Maps raw exit reason strings from the backtest engine to valid Prisma SignalState enum values.
 * The engine can emit strings like 'MARKET' (end-of-data forced close) that are not SignalState members.
 */
function normalizeExitReason(raw: string | undefined | null): SignalState {
  if (!raw) return SignalState.EXPIRED;
  const upper = raw.toUpperCase();
  if (upper === 'SL_HIT' || upper === 'STOP_LOSS' || upper === 'STOPPED') return SignalState.SL_HIT;
  if (upper === 'TP1_HIT' || upper === 'TARGET_1' || upper === 'TARGET_HIT') return SignalState.TP1_HIT;
  if (upper === 'TP2_HIT' || upper === 'TARGET_2') return SignalState.TP2_HIT;
  if (upper === 'TP3_HIT' || upper === 'TARGET_3') return SignalState.TP3_HIT;
  if (upper === 'CANCELLED' || upper === 'CANCEL') return SignalState.CANCELLED;
  if (upper === 'INVALIDATED') return SignalState.INVALIDATED;
  // 'MARKET', 'TIME_EXIT', 'CLOSED', 'EOD', 'FORCE_CLOSE' and any unknown → EXPIRED
  return SignalState.EXPIRED;
}

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
      lotSize: sym === 'BTCUSDT' ? 0.01 : inst.lotSize || 1,
    });

    const startDate = candlesRes.candles[0]?.timestamp || new Date();
    const endDate = candlesRes.candles[candlesRes.candles.length - 1]?.timestamp || new Date();
    const prismaTf = toPrismaTimeframe(timeframe);

    // Save to Database
    const savedRun = await this.prisma.backtest.create({
      data: {
        instrumentId: inst.id,
        timeframe: prismaTf as any,
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
          exitReason: normalizeExitReason(tr.exitReason),
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
