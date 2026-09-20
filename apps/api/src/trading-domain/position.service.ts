import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import {
  IPositionDomainService,
  PositionProjectionResult,
  PositionRecord,
  PositionState,
  Direction,
} from '@quant/shared';
import { Decimal } from '@prisma/client/runtime/library';

@Injectable()
export class PositionService implements IPositionDomainService {
  private readonly logger = new Logger(PositionService.name);

  constructor(private readonly prisma: PrismaService) {}

  public async createPosition(params: {
    accountId: string;
    orderId?: string;
    tradeDecisionId?: string;
    executionId?: string;
    symbol: string;
    contractSymbol: string;
    instrumentType?: string;
    executionInstrument?: string;
    executionInstrumentType?: string;
    strike?: number;
    optionType?: string;
    expiry?: string;
    direction: Direction;
    strategyDirection?: Direction;
    sourceBotId?: string;
    quantity: number;
    entryPrice: number;
    stopLoss?: number;
    initialStopLoss?: number;
    target1?: number;
    target2?: number;
    target3?: number;
    initialTarget1?: number;
    initialTarget2?: number;
    initialTarget3?: number;
    leverage?: number;
    usedMargin?: number;
    chargesJson?: any;
    featureSnapshotJson?: any;
    executionEventsJson?: any;
    correlationId: string;
  }): Promise<PositionRecord> {
    const created = await this.prisma.paperPosition.create({
      data: {
        accountId: params.accountId,
        orderId: params.orderId || null,
        tradeDecisionId: params.tradeDecisionId || null,
        executionId: params.executionId || null,
        symbol: params.symbol,
        contractSymbol: params.contractSymbol,
        instrumentType: params.instrumentType || 'SPOT',
        executionInstrument: params.executionInstrument,
        executionInstrumentType: params.executionInstrumentType,
        strike: params.strike ? new Decimal(params.strike) : null,
        optionType: params.optionType,
        expiry: params.expiry || null,
        direction: params.direction,
        strategyDirection: params.strategyDirection,
        sourceBotId: params.sourceBotId || null,
        quantity: new Decimal(params.quantity),
        entryPrice: new Decimal(params.entryPrice),
        currentPrice: new Decimal(params.entryPrice),
        stopLoss: params.stopLoss ? new Decimal(params.stopLoss) : null,
        initialStopLoss: (params.initialStopLoss ?? params.stopLoss) ? new Decimal((params.initialStopLoss ?? params.stopLoss)!) : null,
        target1: params.target1 ? new Decimal(params.target1) : null,
        target2: params.target2 ? new Decimal(params.target2) : null,
        target3: params.target3 ? new Decimal(params.target3) : null,
        initialTarget1: (params.initialTarget1 ?? params.target1) ? new Decimal((params.initialTarget1 ?? params.target1)!) : null,
        initialTarget2: (params.initialTarget2 ?? params.target2) ? new Decimal((params.initialTarget2 ?? params.target2)!) : null,
        initialTarget3: (params.initialTarget3 ?? params.target3) ? new Decimal((params.initialTarget3 ?? params.target3)!) : null,
        leverage: params.leverage ? new Decimal(params.leverage) : new Decimal(1.0),
        usedMargin: params.usedMargin ? new Decimal(params.usedMargin) : new Decimal(0.0),
        unrealizedPnL: new Decimal(0.0),
        unrealizedR: new Decimal(0.0),
        status: PositionState.OPEN,
        chargesJson: params.chargesJson || null,
        featureSnapshotJson: params.featureSnapshotJson || null,
        executionEventsJson: params.executionEventsJson || null,
        correlationId: params.correlationId,
      },
    });

    return this.mapPosition(created);
  }

  /**
   * CRITICAL INVARIANT: Recalculates position projection strictly derived from the immutable fills ledger.
   * positionQuantity = sum(entry fills) - sum(exit fills)
   */
  public async recalculatePositionFromFills(positionId: string): Promise<PositionProjectionResult> {
    const position = await this.prisma.paperPosition.findUnique({
      where: { id: positionId },
      include: {
        fills: true,
      },
    });

    if (!position) {
      throw new NotFoundException(`Position '${positionId}' not found`);
    }

    const allFills = position.fills || [];

    let totalEntryQty = 0;
    let totalEntryTurnover = 0;
    let totalExitQty = 0;

    for (const fill of allFills) {
      const qty = Number(fill.fillQuantity);
      const price = Number(fill.fillPrice);

      if (fill.executionRole === 'ENTRY' || !fill.executionRole) {
        totalEntryQty += qty;
        totalEntryTurnover += qty * price;
      } else {
        totalExitQty += qty;
      }
    }

    const projectedQty = Number(Math.max(0, totalEntryQty - totalExitQty).toFixed(4));
    const weightedEntryPrice = totalEntryQty > 0 ? Number((totalEntryTurnover / totalEntryQty).toFixed(2)) : Number(position.entryPrice);
    const isFullyClosed = projectedQty <= 0;

    // Check consistency between projection and cached scalar
    const cachedQty = Number(position.quantity);
    const diff = Math.abs(cachedQty - projectedQty);
    const isInconsistent = diff > 1e-4;

    let inconsistencyDetails: string | undefined;
    if (isInconsistent) {
      inconsistencyDetails = `Mismatch: stored quantity (${cachedQty}) !== projected quantity from fills (${projectedQty}). Entry fills: ${totalEntryQty}, Exit fills: ${totalExitQty}`;
      this.logger.warn(`[POSITION PROJECTION MISMATCH] positionId=${positionId}: ${inconsistencyDetails}`);
    }

    return {
      positionId,
      initialQuantity: totalEntryQty,
      totalEntryQuantity: totalEntryQty,
      totalExitQuantity: totalExitQty,
      currentProjectedQuantity: projectedQty,
      weightedEntryPrice,
      isFullyClosed,
      isInconsistent,
      inconsistencyDetails,
    };
  }

  public async updatePositionStatus(
    positionId: string,
    status: string,
    closedAt?: Date,
  ): Promise<PositionRecord> {
    const updated = await this.prisma.paperPosition.update({
      where: { id: positionId },
      data: {
        status: status as PositionState,
        closedAt: closedAt || (status === PositionState.CLOSED ? new Date() : undefined),
      },
    });
    return this.mapPosition(updated);
  }

  public async getPositionById(positionId: string): Promise<PositionRecord | null> {
    const pos = await this.prisma.paperPosition.findUnique({ where: { id: positionId } });
    if (!pos) return null;
    return this.mapPosition(pos);
  }

  public async getActivePositions(accountId: string): Promise<PositionRecord[]> {
    const positions = await this.prisma.paperPosition.findMany({
      where: {
        accountId,
        status: { in: [PositionState.OPEN, PositionState.PARTIALLY_CLOSED] },
      },
      orderBy: { openedAt: 'desc' },
    });
    return positions.map(this.mapPosition);
  }

  private mapPosition(p: any): PositionRecord {
    return {
      id: p.id,
      accountId: p.accountId,
      symbol: p.symbol,
      contractSymbol: p.contractSymbol,
      direction: p.direction,
      quantity: Number(p.quantity),
      entryPrice: Number(p.entryPrice),
      currentPrice: Number(p.currentPrice),
      stopLoss: p.stopLoss ? Number(p.stopLoss) : null,
      initialStopLoss: p.initialStopLoss ? Number(p.initialStopLoss) : null,
      target1: p.target1 ? Number(p.target1) : null,
      status: p.status,
      correlationId: p.correlationId,
    };
  }
}
