import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import {
  IJournalDomainService,
  CreateJournalPayload,
  JournalQueryOptions,
  JournalStatsResult,
} from '@quant/shared';
import { Decimal } from '@prisma/client/runtime/library';

@Injectable()
export class JournalService implements IJournalDomainService {
  private readonly logger = new Logger(JournalService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Creates exactly one canonical PaperTrade journal entry for a completed position lifecycle.
   * Concurrency-safe: If a journal already exists for this position, returns existing record.
   */
  public async createJournalEntry(payload: CreateJournalPayload): Promise<any> {
    const existing = await this.prisma.paperTrade.findFirst({
      where: { positionId: payload.positionId },
    });

    if (existing) {
      this.logger.warn(
        `[DUPLICATE JOURNAL PREVENTED] Journal for positionId '${payload.positionId}' already exists: id=${existing.id}`,
      );
      return existing;
    }

    const entryTime = payload.entryTime || new Date();
    const exitTime = payload.exitTime || new Date();
    const computedDuration =
      payload.holdingDurationSeconds !== undefined
        ? payload.holdingDurationSeconds
        : Math.max(0, Math.floor((exitTime.getTime() - entryTime.getTime()) / 1000));

    try {
      const created = await this.prisma.paperTrade.create({
        data: {
          accountId: payload.accountId,
          positionId: payload.positionId,
          symbol: payload.symbol,
          contractSymbol: payload.contractSymbol,
          instrumentType: payload.instrumentType,
          direction: payload.direction,
          strategyDirection: payload.strategyDirection,
          orderSide: payload.orderSide,
          sourceBotId: payload.sourceBotId || null,
          executionId: payload.executionId || null,
          tradeDecisionId: payload.tradeDecisionId || null,
          quantity: new Decimal(payload.quantity),
          entryPrice: new Decimal(payload.entryPrice),
          exitPrice: new Decimal(payload.exitPrice),
          realizedPnL: new Decimal(payload.realizedPnL),
          realizedR: payload.realizedR !== undefined && payload.realizedR !== null ? new Decimal(payload.realizedR) : null,
          fees: new Decimal(payload.fees),
          maxFavorableExcursion: payload.maxFavorableExcursion ? new Decimal(payload.maxFavorableExcursion) : new Decimal(0),
          maxAdverseExcursion: payload.maxAdverseExcursion ? new Decimal(payload.maxAdverseExcursion) : new Decimal(0),
          holdingDurationSeconds: computedDuration,
          entryTime,
          exitTime,
          exitReason: payload.exitReason,
          chargesJson: payload.chargesJson || null,
          signalSnapshotJson: payload.signalSnapshotJson || null,
          featureSnapshotJson: payload.featureSnapshotJson || null,
          outcomeSnapshotJson: payload.outcomeSnapshotJson || null,
          entryFillAggregationJson: payload.entryFillAggregationJson || null,
          exitFillAggregationJson: payload.exitFillAggregationJson || null,
          outcomeClassification: payload.outcomeClassification || 'MANUAL_EXIT',
          correlationId: payload.correlationId,
        },
      });

      this.logger.log(
        `[CANONICAL JOURNAL CREATED] tradeId=${created.id} | positionId=${payload.positionId} | PnL=₹${created.realizedPnL} | R=${created.realizedR}`,
      );

      return created;
    } catch (err: any) {
      // Handle concurrent insert race
      const raceExisting = await this.prisma.paperTrade.findFirst({
        where: { positionId: payload.positionId },
      });
      if (raceExisting) {
        this.logger.warn(
          `[CONCURRENCY RACE HANDLED] Journal for positionId '${payload.positionId}' already inserted by parallel thread: id=${raceExisting.id}`,
        );
        return raceExisting;
      }
      throw err;
    }
  }

  public async getJournalById(tradeId: string): Promise<any | null> {
    return this.prisma.paperTrade.findUnique({
      where: { id: tradeId },
    });
  }

  public async getJournalByPositionId(positionId: string): Promise<any | null> {
    return this.prisma.paperTrade.findFirst({
      where: { positionId },
    });
  }

  public async getJournalsByAccountId(accountId: string, options?: JournalQueryOptions): Promise<any[]> {
    const whereClause: any = { accountId };

    if (options?.symbol) {
      whereClause.symbol = options.symbol;
    }

    if (options?.outcomeClassification) {
      whereClause.outcomeClassification = options.outcomeClassification;
    }

    if (options?.startDate || options?.endDate) {
      whereClause.exitTime = {};
      if (options.startDate) whereClause.exitTime.gte = options.startDate;
      if (options.endDate) whereClause.exitTime.lte = options.endDate;
    }

    return this.prisma.paperTrade.findMany({
      where: whereClause,
      orderBy: { exitTime: 'desc' },
      take: options?.limit ?? 50,
      skip: options?.offset ?? 0,
    });
  }

  public async getJournalStats(accountId: string): Promise<JournalStatsResult> {
    const trades = await this.prisma.paperTrade.findMany({
      where: { accountId },
    });

    const totalTrades = trades.length;
    if (totalTrades === 0) {
      return {
        totalTrades: 0,
        winningTrades: 0,
        losingTrades: 0,
        breakevenTrades: 0,
        winRate: 0,
        totalPnlAccount: 0,
        profitFactor: 0,
        averageR: 0,
      };
    }

    let winningTrades = 0;
    let losingTrades = 0;
    let breakevenTrades = 0;
    let grossProfits = 0;
    let grossLosses = 0;
    let totalPnl = 0;
    let rSum = 0;
    let rCount = 0;

    for (const t of trades) {
      const pnl = Number(t.realizedPnL || 0);
      totalPnl += pnl;

      if (pnl > 1e-4) {
        winningTrades++;
        grossProfits += pnl;
      } else if (pnl < -1e-4) {
        losingTrades++;
        grossLosses += Math.abs(pnl);
      } else {
        breakevenTrades++;
      }

      if (t.realizedR !== null && t.realizedR !== undefined) {
        rSum += Number(t.realizedR);
        rCount++;
      }
    }

    const winRate = Number(((winningTrades / totalTrades) * 100).toFixed(2));
    const totalPnlAccount = Number(totalPnl.toFixed(2));
    const profitFactor =
      grossLosses > 0
        ? Number((grossProfits / grossLosses).toFixed(2))
        : grossProfits > 0
          ? 99.99
          : 0;
    const averageR = rCount > 0 ? Number((rSum / rCount).toFixed(2)) : 0;

    return {
      totalTrades,
      winningTrades,
      losingTrades,
      breakevenTrades,
      winRate,
      totalPnlAccount,
      profitFactor,
      averageR,
    };
  }

  public async isJournalFinalized(positionId: string): Promise<boolean> {
    const count = await this.prisma.paperTrade.count({
      where: { positionId },
    });
    return count > 0;
  }
}
