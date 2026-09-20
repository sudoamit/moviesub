import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import {
  IFillDomainService,
  RecordFillDto,
  FillRecord,
  ExecutionPriceSource,
} from '@quant/shared';
import { Decimal } from '@prisma/client/runtime/library';

@Injectable()
export class FillService implements IFillDomainService {
  private readonly logger = new Logger(FillService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Records an immutable execution fill in the ledger.
   * Historical fills are never edited or overwritten.
   */
  public async recordFill(dto: RecordFillDto): Promise<FillRecord> {
    const created = await this.prisma.paperFill.create({
      data: {
        orderId: dto.orderId,
        positionId: dto.positionId || null,
        executionRole: dto.executionRole || 'ENTRY',
        fillPrice: new Decimal(dto.fillPrice),
        fillQuantity: new Decimal(dto.fillQuantity),
        fee: new Decimal(dto.fee || 0),
        feeBreakdownJson: dto.feeBreakdownJson || null,
        slippage: new Decimal(dto.slippage || 0),
        executionPriceSource: (dto.executionPriceSource as ExecutionPriceSource) || ExecutionPriceSource.LIVE_TICK,
        liquidityType: dto.liquidityType || 'TAKER',
        sourceTimestamp: dto.sourceTimestamp,
        fillTimestamp: dto.fillTimestamp || new Date(),
        correlationId: dto.correlationId,
      },
    });

    this.logger.log(
      `[FILL RECORDED] id=${created.id} | orderId=${created.orderId} | role=${created.executionRole} | qty=${created.fillQuantity} | price=${created.fillPrice}`,
    );

    return {
      id: created.id,
      orderId: created.orderId,
      positionId: created.positionId,
      executionRole: created.executionRole,
      fillPrice: Number(created.fillPrice),
      fillQuantity: Number(created.fillQuantity),
      fee: Number(created.fee),
      slippage: Number(created.slippage),
      executionPriceSource: created.executionPriceSource,
      fillTimestamp: created.fillTimestamp,
      correlationId: created.correlationId,
    };
  }

  public async getFillsByOrderId(orderId: string): Promise<FillRecord[]> {
    const fills = await this.prisma.paperFill.findMany({
      where: { orderId },
      orderBy: { fillTimestamp: 'asc' },
    });
    return fills.map(this.mapFill);
  }

  public async getFillsByPositionId(positionId: string): Promise<FillRecord[]> {
    const fills = await this.prisma.paperFill.findMany({
      where: { positionId },
      orderBy: { fillTimestamp: 'asc' },
    });
    return fills.map(this.mapFill);
  }

  public async getEntryFillsForPosition(positionId: string): Promise<FillRecord[]> {
    const fills = await this.prisma.paperFill.findMany({
      where: {
        positionId,
        executionRole: 'ENTRY',
      },
      orderBy: { fillTimestamp: 'asc' },
    });
    return fills.map(this.mapFill);
  }

  public async getExitFillsForPosition(positionId: string): Promise<FillRecord[]> {
    const fills = await this.prisma.paperFill.findMany({
      where: {
        positionId,
        executionRole: { in: ['TP1_PARTIAL', 'TP2_PARTIAL', 'FINAL_EXIT', 'EXIT'] },
      },
      orderBy: { fillTimestamp: 'asc' },
    });
    return fills.map(this.mapFill);
  }

  private mapFill(f: any): FillRecord {
    return {
      id: f.id,
      orderId: f.orderId,
      positionId: f.positionId,
      executionRole: f.executionRole,
      fillPrice: Number(f.fillPrice),
      fillQuantity: Number(f.fillQuantity),
      fee: Number(f.fee),
      slippage: Number(f.slippage),
      executionPriceSource: f.executionPriceSource,
      fillTimestamp: f.fillTimestamp,
      correlationId: f.correlationId,
    };
  }
}
