import { Injectable, Logger, NotFoundException, ConflictException, BadRequestException } from '@nestjs/common';
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

  private static readonly ALLOWED_TRANSITIONS: Record<PositionState, PositionState[]> = {
    [PositionState.PENDING]: [
      PositionState.OPEN,
      PositionState.INVALIDATED,
    ],
    [PositionState.OPEN]: [
      PositionState.PARTIALLY_CLOSED,
      PositionState.CLOSING,
      PositionState.EXIT_PENDING,
      PositionState.CLOSED,
    ],
    [PositionState.PARTIALLY_CLOSED]: [
      PositionState.PARTIALLY_CLOSED,
      PositionState.CLOSING,
      PositionState.EXIT_PENDING,
      PositionState.CLOSED,
    ],
    [PositionState.CLOSING]: [
      PositionState.CLOSED,
      PositionState.PARTIALLY_CLOSED,
      PositionState.OPEN,
    ],
    [PositionState.EXIT_PENDING]: [
      PositionState.CLOSED,
      PositionState.PARTIALLY_CLOSED,
      PositionState.OPEN,
    ],
    [PositionState.CLOSED]: [],
    [PositionState.INVALIDATED]: [],
  };

  constructor(private readonly prisma: PrismaService) {}

  public canTransition(fromState: string, toState: string): boolean {
    if (fromState === toState) return true; // Idempotent self-transition
    const allowed = PositionService.ALLOWED_TRANSITIONS[fromState as PositionState];
    return allowed ? allowed.includes(toState as PositionState) : false;
  }

  private validateTransition(current: any, targetState: PositionState): void {
    if (current.status === targetState) return; // Idempotent
    if (!this.canTransition(current.status, targetState)) {
      throw new ConflictException(
        `INVALID_POSITION_TRANSITION: Cannot transition position '${current.id}' from '${current.status}' to '${targetState}'`,
      );
    }
  }

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
    if (!params.quantity || params.quantity <= 0) {
      throw new BadRequestException('quantity must be strictly greater than 0');
    }
    if (!params.entryPrice || params.entryPrice <= 0) {
      throw new BadRequestException('entryPrice must be strictly greater than 0');
    }

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
        initialStopLoss: (params.initialStopLoss ?? params.stopLoss)
          ? new Decimal((params.initialStopLoss ?? params.stopLoss)!)
          : null,
        target1: params.target1 ? new Decimal(params.target1) : null,
        target2: params.target2 ? new Decimal(params.target2) : null,
        target3: params.target3 ? new Decimal(params.target3) : null,
        initialTarget1: (params.initialTarget1 ?? params.target1)
          ? new Decimal((params.initialTarget1 ?? params.target1)!)
          : null,
        initialTarget2: (params.initialTarget2 ?? params.target2)
          ? new Decimal((params.initialTarget2 ?? params.target2)!)
          : null,
        initialTarget3: (params.initialTarget3 ?? params.target3)
          ? new Decimal((params.initialTarget3 ?? params.target3)!)
          : null,
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

    this.logger.log(`[POSITION CREATED] id=${created.id} | symbol=${created.symbol} | qty=${params.quantity}`);
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
    const weightedEntryPrice =
      totalEntryQty > 0
        ? Number((totalEntryTurnover / totalEntryQty).toFixed(2))
        : Number(position.entryPrice);
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

  /**
   * Synchronizes cached scalar properties on PaperPosition with the authoritative fill projection.
   */
  public async syncPositionWithFills(positionId: string): Promise<PositionRecord> {
    const projection = await this.recalculatePositionFromFills(positionId);
    const position = await this.prisma.paperPosition.findUnique({ where: { id: positionId } });

    if (!position) {
      throw new NotFoundException(`Position '${positionId}' not found`);
    }

    let targetStatus: PositionState;
    if (projection.isFullyClosed) {
      targetStatus = PositionState.CLOSED;
    } else if (projection.totalExitQuantity > 0) {
      targetStatus = PositionState.PARTIALLY_CLOSED;
    } else {
      targetStatus = PositionState.OPEN;
    }

    const updated = await this.prisma.paperPosition.update({
      where: { id: positionId },
      data: {
        quantity: new Decimal(projection.currentProjectedQuantity),
        entryPrice: new Decimal(projection.weightedEntryPrice),
        status: targetStatus,
        closedAt: targetStatus === PositionState.CLOSED ? position.closedAt || new Date() : undefined,
      },
    });

    this.logger.log(
      `[POSITION SYNCED] id=${positionId} | qty=${projection.currentProjectedQuantity} | status=${targetStatus}`,
    );

    return this.mapPosition(updated);
  }

  public async updatePositionStatus(
    positionId: string,
    status: string,
    closedAt?: Date,
  ): Promise<PositionRecord> {
    const existing = await this.prisma.paperPosition.findUnique({ where: { id: positionId } });
    if (!existing) {
      throw new NotFoundException(`Position '${positionId}' not found`);
    }

    if (existing.status === status) {
      return this.mapPosition(existing); // Idempotent
    }

    this.validateTransition(existing, status as PositionState);

    const updated = await this.prisma.paperPosition.update({
      where: { id: positionId },
      data: {
        status: status as PositionState,
        closedAt: closedAt || (status === PositionState.CLOSED ? new Date() : undefined),
      },
    });
    return this.mapPosition(updated);
  }

  public async closePosition(
    positionId: string,
    closedAt?: Date,
    reason = 'NORMAL_CLOSE',
  ): Promise<PositionRecord> {
    const existing = await this.prisma.paperPosition.findUnique({ where: { id: positionId } });
    if (!existing) {
      throw new NotFoundException(`Position '${positionId}' not found`);
    }

    if (existing.status === PositionState.CLOSED) {
      return this.mapPosition(existing); // Idempotent
    }

    this.validateTransition(existing, PositionState.CLOSED);

    const updated = await this.prisma.paperPosition.update({
      where: { id: positionId },
      data: {
        status: PositionState.CLOSED,
        closedAt: closedAt || new Date(),
        quantity: new Decimal(0),
      },
    });

    this.logger.log(`[POSITION CLOSED] id=${positionId} | reason=${reason}`);
    return this.mapPosition(updated);
  }

  public async updateStopLoss(positionId: string, stopLoss: number): Promise<PositionRecord> {
    const existing = await this.prisma.paperPosition.findUnique({ where: { id: positionId } });
    if (!existing) {
      throw new NotFoundException(`Position '${positionId}' not found`);
    }

    if (existing.status === PositionState.CLOSED || existing.status === PositionState.INVALIDATED) {
      throw new ConflictException(`Cannot update stop loss on position in status '${existing.status}'`);
    }

    if (stopLoss <= 0) {
      throw new BadRequestException('Stop loss must be strictly positive');
    }

    const updated = await this.prisma.paperPosition.update({
      where: { id: positionId },
      data: {
        stopLoss: new Decimal(stopLoss),
      },
    });

    this.logger.log(`[POSITION STOP_LOSS UPDATED] id=${positionId} | stopLoss=${stopLoss}`);
    return this.mapPosition(updated);
  }

  public async updateTargets(
    positionId: string,
    targets: { target1?: number; target2?: number; target3?: number },
  ): Promise<PositionRecord> {
    const existing = await this.prisma.paperPosition.findUnique({ where: { id: positionId } });
    if (!existing) {
      throw new NotFoundException(`Position '${positionId}' not found`);
    }

    if (existing.status === PositionState.CLOSED || existing.status === PositionState.INVALIDATED) {
      throw new ConflictException(`Cannot update targets on position in status '${existing.status}'`);
    }

    const data: any = {};
    if (targets.target1 !== undefined) data.target1 = new Decimal(targets.target1);
    if (targets.target2 !== undefined) data.target2 = new Decimal(targets.target2);
    if (targets.target3 !== undefined) data.target3 = new Decimal(targets.target3);

    const updated = await this.prisma.paperPosition.update({
      where: { id: positionId },
      data,
    });

    this.logger.log(`[POSITION TARGETS UPDATED] id=${positionId}`);
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
    return positions.map((p) => this.mapPosition(p));
  }

  public async getPositionsByAccountId(accountId: string, status?: string): Promise<PositionRecord[]> {
    const positions = await this.prisma.paperPosition.findMany({
      where: {
        accountId,
        ...(status ? { status: status as PositionState } : {}),
      },
      orderBy: { openedAt: 'desc' },
    });
    return positions.map((p) => this.mapPosition(p));
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
      target2: p.target2 ? Number(p.target2) : null,
      target3: p.target3 ? Number(p.target3) : null,
      initialTarget1: p.initialTarget1 ? Number(p.initialTarget1) : null,
      initialTarget2: p.initialTarget2 ? Number(p.initialTarget2) : null,
      initialTarget3: p.initialTarget3 ? Number(p.initialTarget3) : null,
      leverage: p.leverage ? Number(p.leverage) : undefined,
      usedMargin: p.usedMargin ? Number(p.usedMargin) : undefined,
      unrealizedPnL: p.unrealizedPnL ? Number(p.unrealizedPnL) : undefined,
      realizedPnL: p.realizedPnL ? Number(p.realizedPnL) : undefined,
      status: p.status,
      correlationId: p.correlationId,
      openedAt: p.openedAt || undefined,
      closedAt: p.closedAt || undefined,
      createdAt: p.createdAt || undefined,
    };
  }
}
