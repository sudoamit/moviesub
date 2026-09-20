import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import {
  IJournalDomainService,
  CreateJournalPayload,
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
        realizedR: payload.realizedR !== undefined ? new Decimal(payload.realizedR) : null,
        fees: new Decimal(payload.fees),
        maxFavorableExcursion: payload.maxFavorableExcursion ? new Decimal(payload.maxFavorableExcursion) : new Decimal(0),
        maxAdverseExcursion: payload.maxAdverseExcursion ? new Decimal(payload.maxAdverseExcursion) : new Decimal(0),
        holdingDurationSeconds: payload.holdingDurationSeconds || 0,
        entryTime: payload.entryTime || new Date(),
        exitTime: payload.exitTime || new Date(),
        exitReason: payload.exitReason,
        chargesJson: payload.chargesJson || null,
        signalSnapshotJson: payload.signalSnapshotJson || null,
        featureSnapshotJson: payload.featureSnapshotJson || null,
        outcomeSnapshotJson: payload.outcomeSnapshotJson || null,
        outcomeClassification: payload.outcomeClassification || 'MANUAL_EXIT',
        correlationId: payload.correlationId,
      },
    });

    this.logger.log(
      `[CANONICAL JOURNAL CREATED] tradeId=${created.id} | positionId=${payload.positionId} | PnL=₹${created.realizedPnL} | R=${created.realizedR}`,
    );

    return created;
  }

  public async getJournalByPositionId(positionId: string): Promise<any | null> {
    return this.prisma.paperTrade.findFirst({
      where: { positionId },
    });
  }

  public async isJournalFinalized(positionId: string): Promise<boolean> {
    const count = await this.prisma.paperTrade.count({
      where: { positionId },
    });
    return count > 0;
  }
}
