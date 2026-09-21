import { Injectable, Logger, NotFoundException, ConflictException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import {
  IOrderDomainService,
  CreateOrderDto,
  OrderRecord,
  OrderState,
  Direction,
} from '@quant/shared';
import { Decimal } from '@prisma/client/runtime/library';
import * as crypto from 'crypto';

@Injectable()
export class OrderService implements IOrderDomainService {
  private readonly logger = new Logger(OrderService.name);

  private static readonly ALLOWED_TRANSITIONS: Record<OrderState, OrderState[]> = {
    [OrderState.CREATED]: [
      OrderState.RISK_CHECKED,
      OrderState.SUBMITTED,
      OrderState.REJECTED,
      OrderState.CANCELLED,
    ],
    [OrderState.RISK_CHECKED]: [
      OrderState.SUBMITTED,
      OrderState.REJECTED,
      OrderState.CANCELLED,
    ],
    [OrderState.SUBMITTED]: [
      OrderState.ACKNOWLEDGED,
      OrderState.PARTIALLY_FILLED,
      OrderState.FILLED,
      OrderState.CANCEL_REQUESTED,
      OrderState.CANCELLED,
      OrderState.REJECTED,
      OrderState.FAILED,
    ],
    [OrderState.ACKNOWLEDGED]: [
      OrderState.PARTIALLY_FILLED,
      OrderState.FILLED,
      OrderState.CANCEL_REQUESTED,
      OrderState.CANCELLED,
      OrderState.FAILED,
    ],
    [OrderState.PARTIALLY_FILLED]: [
      OrderState.PARTIALLY_FILLED,
      OrderState.FILLED,
      OrderState.CANCEL_REQUESTED,
      OrderState.CANCELLED,
    ],
    [OrderState.CANCEL_REQUESTED]: [
      OrderState.CANCELLED,
      OrderState.FILLED,
      OrderState.PARTIALLY_FILLED,
    ],
    [OrderState.FILLED]: [],
    [OrderState.CANCELLED]: [],
    [OrderState.REJECTED]: [],
    [OrderState.FAILED]: [],
  };

  constructor(private readonly prisma: PrismaService) {}

  public canTransition(fromState: string, toState: string): boolean {
    if (fromState === toState) return true; // Idempotent self-transition
    const allowed = OrderService.ALLOWED_TRANSITIONS[fromState as OrderState];
    return allowed ? allowed.includes(toState as OrderState) : false;
  }

  private validateTransition(current: any, targetState: OrderState): void {
    if (current.status === targetState) return; // Idempotent
    if (!this.canTransition(current.status, targetState)) {
      throw new ConflictException(
        `INVALID_ORDER_TRANSITION: Cannot transition order '${current.id}' from '${current.status}' to '${targetState}'`,
      );
    }
  }

  public async createOrder(dto: CreateOrderDto): Promise<OrderRecord> {
    // 1. Parameter Validation
    if (!dto.symbol || dto.symbol.trim() === '') {
      throw new BadRequestException('Order symbol is required');
    }
    if (!dto.accountId || dto.accountId.trim() === '') {
      throw new BadRequestException('Order accountId is required');
    }
    if (!dto.requestedQuantity || dto.requestedQuantity <= 0) {
      throw new BadRequestException('requestedQuantity must be strictly greater than 0');
    }
    if (
      (dto.orderType === 'LIMIT' || dto.orderType === 'STOP_LIMIT') &&
      (!dto.price || dto.price <= 0)
    ) {
      throw new BadRequestException(`Price must be strictly positive for ${dto.orderType} orders`);
    }

    // 2. Deterministic Idempotency Key
    const idempotencyKey =
      dto.idempotencyKey ||
      dto.clientOrderId ||
      `ord_${dto.accountId}_${dto.symbol}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

    // 3. Idempotency Check
    const existing = await this.prisma.paperOrder.findUnique({ where: { idempotencyKey } });
    if (existing) {
      this.logger.log(`[ORDER IDEMPOTENT RETURN] id=${existing.id} | idempotencyKey=${idempotencyKey}`);
      return this.mapOrder(existing);
    }

    // 4. Persistence
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
        idempotencyKey,
        correlationId: dto.correlationId || idempotencyKey,
        submittedAt: new Date(),
        orderSubmittedAt: new Date(),
      },
    });

    this.logger.log(`[ORDER CREATED] id=${created.id} | symbol=${created.symbol} | qty=${dto.requestedQuantity}`);
    return this.mapOrder(created);
  }

  public async updateOrderStatus(orderId: string, status: string, details?: any): Promise<OrderRecord> {
    const existing = await this.prisma.paperOrder.findUnique({ where: { id: orderId } });
    if (!existing) {
      throw new NotFoundException(`Order '${orderId}' not found`);
    }

    if (existing.status === status) {
      return this.mapOrder(existing); // Idempotent
    }

    this.validateTransition(existing, status as OrderState);

    const updateData: any = {
      status: status as OrderState,
    };

    if (
      (status === OrderState.PARTIALLY_FILLED || status === OrderState.FILLED) &&
      !existing.firstFillAt
    ) {
      updateData.firstFillAt = new Date();
    }

    if (status === OrderState.CANCELLED && !existing.cancelledAt) {
      updateData.cancelledAt = new Date();
    }

    if (details?.filledQuantity !== undefined) {
      updateData.filledQuantity = new Decimal(details.filledQuantity);
    }

    if (details?.rejectionReason) {
      updateData.rejectionReason = details.rejectionReason;
    }

    if (details?.rejectionDetails) {
      updateData.rejectionDetails = details.rejectionDetails;
    }

    const updated = await this.prisma.paperOrder.update({
      where: { id: orderId },
      data: updateData,
    });

    this.logger.log(`[ORDER STATUS UPDATED] id=${orderId} | status=${status}`);
    return this.mapOrder(updated);
  }

  public async cancelOrder(orderId: string, reason = 'CANCELLED'): Promise<OrderRecord> {
    const existing = await this.prisma.paperOrder.findUnique({ where: { id: orderId } });
    if (!existing) {
      throw new NotFoundException(`Order '${orderId}' not found`);
    }

    if (existing.status === OrderState.CANCELLED) {
      return this.mapOrder(existing); // Idempotent
    }

    this.validateTransition(existing, OrderState.CANCELLED);

    const updated = await this.prisma.paperOrder.update({
      where: { id: orderId },
      data: {
        status: OrderState.CANCELLED,
        cancelledAt: new Date(),
        rejectionDetails: reason,
      },
    });

    this.logger.log(`[ORDER CANCELLED] id=${orderId} | reason=${reason}`);
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
    const order = await this.prisma.paperOrder.findFirst({
      where: {
        OR: [{ correlationId: brokerOrderId }, { idempotencyKey: brokerOrderId }],
      },
    });
    if (!order) return null;
    return this.mapOrder(order);
  }

  public async getOrdersByAccountId(accountId: string, status?: string): Promise<OrderRecord[]> {
    const orders = await this.prisma.paperOrder.findMany({
      where: {
        accountId,
        ...(status ? { status: status as OrderState } : {}),
      },
      orderBy: { createdAt: 'desc' },
    });
    return orders.map((o) => this.mapOrder(o));
  }

  public async getActiveOrdersForAccount(accountId: string): Promise<OrderRecord[]> {
    const orders = await this.prisma.paperOrder.findMany({
      where: {
        accountId,
        status: {
          in: [OrderState.SUBMITTED, OrderState.ACKNOWLEDGED, OrderState.PARTIALLY_FILLED],
        },
      },
      orderBy: { createdAt: 'desc' },
    });
    return orders.map((o) => this.mapOrder(o));
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
      clientOrderId: o.idempotencyKey,
      brokerOrderId: o.correlationId,
      leverage: o.leverage ? Number(o.leverage) : undefined,
      strike: o.strike ? Number(o.strike) : undefined,
      optionType: o.optionType || undefined,
      expiry: o.expiry || undefined,
      submittedAt: o.submittedAt || undefined,
      firstFillAt: o.firstFillAt || undefined,
      cancelledAt: o.cancelledAt || undefined,
      createdAt: o.createdAt || undefined,
    };
  }
}
