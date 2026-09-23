import { Injectable, Logger, ConflictException, NotFoundException, OnModuleInit, Optional } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { Decimal } from '@prisma/client/runtime/library';
import {
  IReservationDomainService,
  CreateReservationParams,
  ReservationRecord,
  ReservationStatus,
  PositionState,
  TradeLifecycleState,
} from '@quant/shared';
import * as crypto from 'crypto';
import { TradeLifecycleService } from './trade-lifecycle.service';

@Injectable()
export class ReservationService implements IReservationDomainService, OnModuleInit {
  private readonly logger = new Logger(ReservationService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly tradeLifecycleService?: TradeLifecycleService,
  ) {}

  /**
   * On application startup / restart, recover durability by sweeping any reservations that expired
   * during downtime or network partitions.
   */
  public async onModuleInit(): Promise<void> {
    const swept = await this.releaseExpiredReservations();
    if (swept > 0) {
      this.logger.log(`[RESERVATION_SERVICE INIT] Swept ${swept} expired reservations on startup`);
    }
  }

  /**
   * Helper to map a database entity to a standard ReservationRecord.
   */
  private mapToRecord(entity: any): ReservationRecord {
    return {
      reservationId: entity.reservationId,
      accountId: entity.accountId,
      botId: entity.botId,
      tradeDecisionId: entity.tradeDecisionId ?? '',
      fingerprint: entity.fingerprint,
      riskAmount: Number(entity.riskAmount),
      marginAmount: Number(entity.marginAmount),
      exposureAmount: Number(entity.exposureAmount),
      currency: entity.currency ?? 'INR',
      status: entity.status as ReservationStatus,
      createdAt: entity.createdAt ?? entity.reservedAt,
      expiresAt: entity.expiresAt,
      consumedMargin: entity.consumedMargin ? Number(entity.consumedMargin) : 0,
      releasedMargin: entity.releasedMargin ? Number(entity.releasedMargin) : 0,
      reason: entity.reason ?? undefined,
    };
  }

  /**
   * Atomically reserves margin, notional exposure, and risk prior to order placement
   * in the database as the durable source of truth.
   */
  public async reserveResources(params: CreateReservationParams): Promise<ReservationRecord> {
    const {
      accountId,
      botId,
      tradeDecisionId,
      fingerprint,
      riskAmount,
      marginAmount,
      exposureAmount,
      currency,
      expiresInSeconds = 30,
      symbol,
      reservedQuantity = 0,
      metadata,
    } = params as any;

    const reservationId = `res_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + expiresInSeconds * 1000);

    // Atomically verify available margin and exposure within transaction
    return await this.prisma.$transaction(async (tx) => {
      // 1. Check if an active reservation for this exact fingerprint already exists in DB
      const existingRes = await tx.tradeReservation.findFirst({
        where: {
          fingerprint,
          status: 'RESERVED',
          expiresAt: { gt: now },
        },
      });
      if (existingRes) {
        throw new ConflictException(
          `RESERVATION_CONFLICT: Active reservation '${existingRes.reservationId}' already held for fingerprint '${fingerprint}'`,
        );
      }

      // 2. Fetch current account
      const account = await tx.paperAccount.findUnique({ where: { id: accountId } });
      if (!account) {
        throw new NotFoundException(`Account '${accountId}' not found`);
      }

      // 3. Compute active reservations total for this account in DB
      const activeAccountReservations = await tx.tradeReservation.findMany({
        where: {
          accountId,
          status: 'RESERVED',
          expiresAt: { gt: now },
        },
        select: { marginAmount: true },
      });
      const reservedMarginTotal = activeAccountReservations.reduce(
        (sum, r) => sum + Number(r.marginAmount),
        0,
      );

      // 4. Compute active positions margin
      const activePositions = await tx.paperPosition.findMany({
        where: {
          accountId,
          status: { in: [PositionState.OPEN, PositionState.PARTIALLY_CLOSED] },
        },
        select: { usedMargin: true },
      });
      const currentUsedMargin = activePositions.reduce((sum, p) => sum + Number(p.usedMargin), 0);

      const totalCommittedMargin = currentUsedMargin + reservedMarginTotal;
      const availableCash = Number(account.cashBalance) - totalCommittedMargin;

      if (availableCash < marginAmount) {
        if (tradeDecisionId && this.tradeLifecycleService) {
          try {
            await this.tradeLifecycleService.transition(
              {
                tradeDecisionId,
                newState: TradeLifecycleState.RESERVATION_FAILED,
                event: 'INSUFFICIENT_MARGIN',
                correlationId: fingerprint || tradeDecisionId,
              },
              tx,
            );
          } catch {
            // Ignore if decision does not exist in mock/DB
          }
        }
        throw new ConflictException(
          `INSUFFICIENT_MARGIN_RESERVATION: Available margin ₹${availableCash.toFixed(2)} is less than required reservation ₹${marginAmount.toFixed(2)}`,
        );
      }

      // 5. Persist durable reservation record
      const created = await tx.tradeReservation.create({
        data: {
          reservationId,
          fingerprint,
          accountId,
          botId,
          symbol: symbol ?? null,
          currency: currency ?? 'INR',
          riskAmount: new Decimal(riskAmount),
          marginAmount: new Decimal(marginAmount),
          exposureAmount: new Decimal(exposureAmount),
          reservedQuantity: reservedQuantity ? new Decimal(reservedQuantity) : new Decimal(0),
          consumedMargin: new Decimal(0),
          releasedMargin: new Decimal(0),
          status: 'RESERVED',
          tradeDecisionId: tradeDecisionId ?? null,
          metadataJson: metadata ? (metadata as any) : undefined,
          reservedAt: now,
          expiresAt,
        },
      });

      if (tradeDecisionId && this.tradeLifecycleService) {
        try {
          await this.tradeLifecycleService.transition(
            {
              tradeDecisionId,
              newState: TradeLifecycleState.RESERVATION_CREATED,
              event: 'RESERVATION_CREATED',
              correlationId: fingerprint || tradeDecisionId,
              metadata: {
                reservationCreatedAt: now,
                reservationTime: now,
              },
            },
            tx,
          );
        } catch {
          // Ignore if decision does not exist in mock/DB
        }
      }

      this.logger.log(
        `[RESERVATION CREATED] id=${reservationId} | bot=${botId} | margin=₹${marginAmount.toFixed(2)} | exposure=₹${exposureAmount.toFixed(2)} | expiresAt=${expiresAt.toISOString()}`,
      );

      return this.mapToRecord(created);
    });
  }

  /**
   * Consumes full reservation upon order fill and position creation.
   */
  public async consumeReservation(reservationId: string): Promise<ReservationRecord | void> {
    return await this.prisma.$transaction(async (tx) => {
      const res = await tx.tradeReservation.findUnique({
        where: { reservationId },
      });
      if (!res) {
        return;
      }
      if (res.status === 'CONSUMED') {
        return this.mapToRecord(res);
      }
      if (res.status === 'RESERVED') {
        const remainingMargin = Number(res.marginAmount);
        const consumedMargin = Number(res.consumedMargin) + remainingMargin;
        const updated = await tx.tradeReservation.update({
          where: { reservationId },
          data: {
            consumedMargin: new Decimal(consumedMargin),
            marginAmount: new Decimal(0),
            status: 'CONSUMED',
            reason: 'FILL_CONSUMED',
            consumedAt: new Date(),
          },
        });
        this.logger.log(`[RESERVATION CONSUMED] id=${reservationId}`);
        return this.mapToRecord(updated);
      }
    });
  }

  /**
   * Partially consumes reservation (e.g. for partial order fills), retaining remainder reserved.
   */
  public async consumePartialReservation(
    reservationId: string,
    consumedMargin: number,
  ): Promise<ReservationRecord> {
    return await this.prisma.$transaction(async (tx) => {
      const res = await tx.tradeReservation.findUnique({
        where: { reservationId },
      });
      if (!res) {
        throw new NotFoundException(`Reservation '${reservationId}' not found`);
      }
      if (res.status !== 'RESERVED') {
        throw new ConflictException(`Cannot partially consume reservation in status '${res.status}'`);
      }
      if (consumedMargin <= 0) {
        throw new ConflictException(`Consumed margin must be strictly greater than 0`);
      }

      const currentMargin = Number(res.marginAmount);
      const currentConsumed = Number(res.consumedMargin);

      let updated;
      if (consumedMargin >= currentMargin) {
        // Fully consumed
        updated = await tx.tradeReservation.update({
          where: { reservationId },
          data: {
            consumedMargin: new Decimal(currentConsumed + currentMargin),
            marginAmount: new Decimal(0),
            status: 'CONSUMED',
            reason: 'FILL_CONSUMED',
            consumedAt: new Date(),
          },
        });
      } else {
        // Partially consumed
        const newMargin = Number((currentMargin - consumedMargin).toFixed(2));
        updated = await tx.tradeReservation.update({
          where: { reservationId },
          data: {
            consumedMargin: new Decimal(currentConsumed + consumedMargin),
            marginAmount: new Decimal(newMargin),
            consumedAt: new Date(),
          },
        });
      }

      this.logger.log(
        `[RESERVATION PARTIALLY CONSUMED] id=${reservationId} | consumed=₹${consumedMargin.toFixed(2)} | remaining=₹${Number(updated.marginAmount).toFixed(2)} | status=${updated.status}`,
      );
      return this.mapToRecord(updated);
    });
  }

  /**
   * Releases full or partial reservation upon order cancellation, rejection, or abort.
   */
  public async releaseReservation(
    reservationId: string,
    reason = 'NORMAL_RELEASE',
    releasedMargin?: number,
  ): Promise<ReservationRecord | void> {
    return await this.prisma.$transaction(async (tx) => {
      const res = await tx.tradeReservation.findUnique({
        where: { reservationId },
      });
      if (res && res.status === 'RESERVED') {
        const currentMargin = Number(res.marginAmount);
        const currentReleased = Number(res.releasedMargin);
        let updated;
        if (releasedMargin !== undefined && releasedMargin < currentMargin && releasedMargin > 0) {
          // Partial release
          const newMargin = Number((currentMargin - releasedMargin).toFixed(2));
          updated = await tx.tradeReservation.update({
            where: { reservationId },
            data: {
              releasedMargin: new Decimal(currentReleased + releasedMargin),
              marginAmount: new Decimal(newMargin),
              reason,
              releasedAt: new Date(),
            },
          });
        } else {
          // Full release
          updated = await tx.tradeReservation.update({
            where: { reservationId },
            data: {
              releasedMargin: new Decimal(currentReleased + currentMargin),
              status: 'RELEASED',
              reason,
              releasedAt: new Date(),
            },
          });
        }
        this.logger.log(
          `[RESERVATION RELEASED] id=${reservationId} | reason=${reason} | remainingMargin=₹${Number(updated.marginAmount).toFixed(2)}`,
        );
        return this.mapToRecord(updated);
      }
    });
  }

  /**
   * Fetches a single reservation by ID.
   */
  public async getReservation(reservationId: string): Promise<ReservationRecord | null> {
    const res = await this.prisma.tradeReservation.findUnique({
      where: { reservationId },
    });
    return res ? this.mapToRecord(res) : null;
  }

  /**
   * Finds reservation by fingerprint.
   */
  public async getReservationByFingerprint(fingerprint: string): Promise<ReservationRecord | null> {
    const now = new Date();
    // Prioritize active reservation
    const active = await this.prisma.tradeReservation.findFirst({
      where: {
        fingerprint,
        status: 'RESERVED',
        expiresAt: { gt: now },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (active) return this.mapToRecord(active);

    // Fall back to any reservation with matching fingerprint
    const anyRes = await this.prisma.tradeReservation.findFirst({
      where: { fingerprint },
      orderBy: { createdAt: 'desc' },
    });
    return anyRes ? this.mapToRecord(anyRes) : null;
  }

  /**
   * Returns all active, unexpired reservations for an account.
   */
  public async getActiveReservationsForAccount(accountId: string): Promise<ReservationRecord[]> {
    const now = new Date();
    const rows = await this.prisma.tradeReservation.findMany({
      where: {
        accountId,
        status: 'RESERVED',
        expiresAt: { gt: now },
      },
    });
    return rows.map((r) => this.mapToRecord(r));
  }

  /**
   * Returns total reserved margin across active reservations for an account.
   */
  public async getTotalReservedMargin(accountId: string): Promise<number> {
    const active = await this.getActiveReservationsForAccount(accountId);
    const sum = active.reduce((acc, r) => acc + r.marginAmount, 0);
    return Number(sum.toFixed(2));
  }

  /**
   * Returns total reserved notional exposure across active reservations for an account.
   */
  public async getTotalReservedExposure(accountId: string): Promise<number> {
    const active = await this.getActiveReservationsForAccount(accountId);
    const sum = active.reduce((acc, r) => acc + r.exposureAmount, 0);
    return Number(sum.toFixed(2));
  }

  /**
   * Returns total reserved risk across active reservations for an account.
   */
  public async getTotalReservedRisk(accountId: string): Promise<number> {
    const active = await this.getActiveReservationsForAccount(accountId);
    const sum = active.reduce((acc, r) => acc + r.riskAmount, 0);
    return Number(sum.toFixed(2));
  }

  /**
   * Sweeps and transitions expired reservations to EXPIRED status, freeing encumbered resources.
   */
  public async releaseExpiredReservations(): Promise<number> {
    const now = new Date();
    const result = await this.prisma.tradeReservation.updateMany({
      where: {
        status: 'RESERVED',
        expiresAt: { lte: now },
      },
      data: {
        status: 'EXPIRED',
        reason: 'TTL_EXPIRED',
      },
    });
    const count = result.count;
    if (count > 0) {
      this.logger.log(`[RESERVATIONS EXPIRED] Released ${count} expired reservations`);
    }
    return count;
  }
}
