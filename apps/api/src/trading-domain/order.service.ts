import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import {
  IOrderDomainService,
  CreateOrderDto,
  OrderRecord,
  OrderState,
  Direction,
} from '@quant/shared';
import { Decimal } from '@prisma/client/runtime/library';

@Injectable()
export class OrderService implements IOrderDomainService {
  private readonly logger = new Logger(OrderService.name);

  constructor(private readonly prisma: PrismaService) {}

  public async createOrder(dto: CreateOrderDto): Promise<OrderRecord> {
    const created = await this.prisma.paperOrder.create({
      data: {
        accountId: dto.accountId,
        tradeDecisionId: dto.tradeDecisionId || null,
        executionId: dto.executionId || null,
        symbol: dto.symbol,
        contractSymbol: dto.contractSymbol || dto.symbol,
        instrumentType: dto.instrumentType || 'SPOT',
        executionInstrument: dto.executionInstrument,
        executionInstrumentType: dto.executionInstrumentType,
        strike: dto.strike ? new Decimal(dto.strike) : null,
        optionType: dto.optionType,
        expiry: dto.expiry || null,
        direction: dto.direction,
        strategyDirection: dto.strategyDirection,
        sourceBotId: dto.sourceBotId || null,
        orderType: dto.orderType || 'MARKET',
        requestedQuantity: new Decimal(dto.requestedQuantity),
        filledQuantity: new Decimal(0),
        price: dto.price ? new Decimal(dto.price) : null,
        triggerPrice: dto.triggerPrice ? new Decimal(dto.triggerPrice) : null,
        stopLoss: dto.stopLoss ? new Decimal(dto.stopLoss) : null,
        target1: dto.target1 ? new Decimal(dto.target1) : null,
        target2: dto.target2 ? new Decimal(dto.target2) : null,
        target3: dto.target3 ? new Decimal(dto.target3) : null,
        leverage: dto.leverage ? new Decimal(dto.leverage) : new Decimal(1.0),
        status: OrderState.SUBMITTED,
        idempotencyKey: dto.idempotencyKey,
        correlationId: dto.correlationId,
        submittedAt: new Date(),
        orderSubmittedAt: new Date(),
      },
    });

    return this.mapOrder(created);
  }

  public async updateOrderStatus(orderId: string, status: string, details?: any): Promise<OrderRecord> {
    const updated = await this.prisma.paperOrder.update({
      where: { id: orderId },
      data: {
        status: status as OrderState,
        firstFillAt: status === OrderState.FILLED || status === OrderState.PARTIALLY_FILLED ? new Date() : undefined,
        cancelledAt: status === OrderState.CANCELLED ? new Date() : undefined,
        filledQuantity: details?.filledQuantity ? new Decimal(details.filledQuantity) : undefined,
      },
    });

    return this.mapOrder(updated);
  }

  public async getOrderById(orderId: string): Promise<OrderRecord | null> {
    const order = await this.prisma.paperOrder.findUnique({ where: { id: orderId } });
    if (!order) return null;
    return this.mapOrder(order);
  }

  public async getOrderByClientOrderId(clientOrderId: string): Promise<OrderRecord | null> {
    const order = await this.prisma.paperOrder.findUnique({ where: { idempotencyKey: clientOrderId } });
    if (!order) return null;
    return this.mapOrder(order);
  }

  public async getOrderByBrokerOrderId(brokerOrderId: string): Promise<OrderRecord | null> {
    // Falls back to correlationId or idempotencyKey until schema migration
    const order = await this.prisma.paperOrder.findFirst({
      where: {
        OR: [{ correlationId: brokerOrderId }, { idempotencyKey: brokerOrderId }],
      },
    });
    if (!order) return null;
    return this.mapOrder(order);
  }

  public async getOrdersByPositionId(positionId: string): Promise<OrderRecord[]> {
    const orders = await this.prisma.paperOrder.findMany({
      where: { positions: { some: { id: positionId } } },
      orderBy: { createdAt: 'asc' },
    });
    return orders.map((o) => this.mapOrder(o));
  }

  private mapOrder(o: any): OrderRecord {
    return {
      id: o.id,
      accountId: o.accountId,
      symbol: o.symbol,
      contractSymbol: o.contractSymbol,
      instrumentType: o.instrumentType,
      direction: o.direction as any as Direction,
      orderType: o.orderType,
      requestedQuantity: Number(o.requestedQuantity),
      filledQuantity: Number(o.filledQuantity),
      price: o.price ? Number(o.price) : undefined,
      status: o.status,
      idempotencyKey: o.idempotencyKey,
      correlationId: o.correlationId,
    };
  }
}
