import { Injectable, Logger, NotFoundException, ConflictException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import {
  IFillDomainService,
  RecordFillDto,
  FillRecord,
  ExecutionPriceSource,
  OrderState,
} from '@quant/shared';
import { Decimal } from '@prisma/client/runtime/library';

@Injectable()
export class FillService implements IFillDomainService {
  private readonly logger = new Logger(FillService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Records an immutable execution fill in the ledger.
   * Historical fills are append-only and never edited or overwritten.
   * Synchronizes parent order status and filledQuantity atomically.
   */
  public async recordFill(dto: RecordFillDto): Promise<FillRecord> {
    // 1. Parameter Validation
    if (!dto.orderId) {
      throw new BadRequestException('orderId is required');
    }
    if (!dto.fillQuantity || dto.fillQuantity <= 0) {
      throw new BadRequestException('fillQuantity must be strictly greater than 0');
    }
    if (!dto.fillPrice || dto.fillPrice <= 0) {
      throw new BadRequestException('fillPrice must be strictly greater than 0');
    }

    return await this.prisma.$transaction(async (tx) => {
      // 2. Fetch Parent Order
      const order = await tx.paperOrder.findUnique({ where: { id: dto.orderId } });
      if (!order) {
        throw new NotFoundException(`Order '${dto.orderId}' not found`);
      }

      // 3. Overfill Prevention Check
      const currentFilled = Number(order.filledQuantity);
      const requested = Number(order.requestedQuantity);
      const newFilled = Number((currentFilled + dto.fillQuantity).toFixed(4));
      const epsilon = 0.0001;

      if (newFilled > requested + epsilon) {
        throw new ConflictException(
          `OVERFILL_DETECTED: Total filled quantity (${newFilled}) would exceed requested order quantity (${requested}) for order '${dto.orderId}'`,
        );
      }

      // 4. Slippage Calculation
      let slippage = dto.slippage;
      if (slippage === undefined) {
        if (dto.expectedPrice !== undefined || order.price !== null) {
          const refPrice = dto.expectedPrice ?? Number(order.price);
          const isBuy = order.direction === 'BULLISH' || (order.direction as string) === 'BUY';
          const rawSlippage = isBuy ? dto.fillPrice - refPrice : refPrice - dto.fillPrice;
          slippage = Number(rawSlippage.toFixed(4));
        } else {
          slippage = 0;
        }
      }

      const totalFee = dto.totalFee ?? dto.fee ?? 0;
      const fillTimestamp = dto.fillTimestamp || new Date();

      // 5. Create Append-Only Fill Record
      const created = await tx.paperFill.create({
        data: {
          orderId: dto.orderId,
          positionId: dto.positionId || null,
          executionRole: dto.executionRole || 'ENTRY',
          fillPrice: new Decimal(dto.fillPrice),
          fillQuantity: new Decimal(dto.fillQuantity),
          fee: new Decimal(totalFee),
          feeBreakdownJson: dto.feeBreakdownJson || null,
          slippage: new Decimal(slippage),
          executionPriceSource:
            (dto.executionPriceSource as ExecutionPriceSource) || ExecutionPriceSource.LIVE_TICK,
          liquidityType: dto.liquidityType || 'TAKER',
          sourceTimestamp: dto.sourceTimestamp,
          fillTimestamp,
          correlationId: dto.correlationId,
        },
      });

      // 6. Atomically Synchronize Parent Order
      const isComplete = newFilled >= requested - epsilon;
      const targetState = isComplete ? OrderState.FILLED : OrderState.PARTIALLY_FILLED;

      await tx.paperOrder.update({
        where: { id: dto.orderId },
        data: {
          filledQuantity: new Decimal(newFilled),
          status: targetState,
          firstFillAt: order.firstFillAt || fillTimestamp,
        },
      });

      this.logger.log(
        `[FILL RECORDED] id=${created.id} | orderId=${created.orderId} | role=${created.executionRole} | qty=${created.fillQuantity} | price=${created.fillPrice} | orderStatus=${targetState}`,
      );

      return this.mapFill(created);
    });
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

  /**
   * Calculates the Volume Weighted Average Price (VWAP) across a collection of fills.
   * VWAP = sum(fillPrice * fillQuantity) / sum(fillQuantity)
   */
  public calculateWeightedAveragePrice(fills: FillRecord[]): number {
    if (!fills || fills.length === 0) return 0;
    const totalQuantity = fills.reduce((sum, f) => sum + f.fillQuantity, 0);
    if (totalQuantity <= 0) return 0;

    const totalNotional = fills.reduce((sum, f) => sum + f.fillPrice * f.fillQuantity, 0);
    return Number((totalNotional / totalQuantity).toFixed(4));
  }

  /**
   * Calculates the total cumulative filled quantity across a collection of fills.
   */
  public getTotalFillQuantity(fills: FillRecord[]): number {
    if (!fills || fills.length === 0) return 0;
    const sum = fills.reduce((acc, f) => acc + f.fillQuantity, 0);
    return Number(sum.toFixed(4));
  }

  /**
   * Calculates the total cumulative transaction fees across a collection of fills.
   */
  public getTotalFillFees(fills: FillRecord[]): number {
    if (!fills || fills.length === 0) return 0;
    const sum = fills.reduce((acc, f) => acc + f.fee, 0);
    return Number(sum.toFixed(2));
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
      totalFee: Number(f.fee),
      feeBreakdownJson: f.feeBreakdownJson,
      slippage: Number(f.slippage),
      executionPriceSource: f.executionPriceSource,
      fillTimestamp: f.fillTimestamp,
      correlationId: f.correlationId,
    };
  }
}
