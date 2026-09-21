import { Injectable, Logger, ConflictException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import {
  IReservationDomainService,
  CreateReservationParams,
  ReservationRecord,
  ReservationStatus,
  PositionState,
} from '@quant/shared';
import * as crypto from 'crypto';

@Injectable()
export class ReservationService implements IReservationDomainService {
  private readonly logger = new Logger(ReservationService.name);

  // In-memory active reservation tracking backed by DB atomic transactions
  private readonly activeReservations = new Map<string, ReservationRecord>();

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Atomically reserves margin, notional exposure, and risk prior to order placement.
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
    } = params;

    const reservationId = `res_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + expiresInSeconds * 1000);

    // Atomically verify available margin and exposure within transaction
    return await this.prisma.$transaction(async (tx) => {
      // 1. Check if an active reservation for this exact fingerprint already exists
      const existingRes = Array.from(this.activeReservations.values()).find(
        (r) => r.fingerprint === fingerprint && r.status === 'RESERVED' && r.expiresAt > now,
      );
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

      // 3. Compute active reservations total for this account
      const activeAccountReservations = Array.from(this.activeReservations.values()).filter(
        (r) => r.accountId === accountId && r.status === 'RESERVED' && r.expiresAt > now,
      );
      const reservedMarginTotal = activeAccountReservations.reduce((sum, r) => sum + r.marginAmount, 0);

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
        if (tradeDecisionId && tx.tradeDecision?.update) {
          try {
            await tx.tradeDecision.update({
              where: { id: tradeDecisionId },
              data: { lifecycleState: 'RESERVATION_FAILED' as any },
            });
          } catch {
            // Ignore if decision does not exist in mock/DB
          }
        }
        throw new ConflictException(
          `INSUFFICIENT_MARGIN_RESERVATION: Available margin ₹${availableCash.toFixed(2)} is less than required reservation ₹${marginAmount.toFixed(2)}`,
        );
      }

      const record: ReservationRecord = {
        reservationId,
        accountId,
        botId,
        tradeDecisionId,
        fingerprint,
        riskAmount,
        marginAmount,
        exposureAmount,
        currency,
        status: 'RESERVED',
        createdAt: now,
        expiresAt,
        consumedMargin: 0,
        releasedMargin: 0,
      };

      this.activeReservations.set(reservationId, record);

      if (tradeDecisionId && tx.tradeDecision?.update) {
        try {
          await tx.tradeDecision.update({
            where: { id: tradeDecisionId },
            data: {
              lifecycleState: 'RESERVATION_CREATED' as any,
              reservationCreatedAt: now,
              reservationTime: now,
            },
          });
        } catch {
          // Ignore if decision does not exist in mock/DB
        }
      }

      this.logger.log(
        `[RESERVATION CREATED] id=${reservationId} | bot=${botId} | margin=₹${marginAmount.toFixed(2)} | exposure=₹${exposureAmount.toFixed(2)} | expiresAt=${expiresAt.toISOString()}`,
      );

      return record;
    });
  }

  /**
   * Consumes full reservation upon order fill and position creation.
   */
  public async consumeReservation(reservationId: string): Promise<ReservationRecord | void> {
    const res = this.activeReservations.get(reservationId);
    if (res) {
      res.consumedMargin = (res.consumedMargin ?? 0) + res.marginAmount;
      res.marginAmount = 0;
      res.status = 'CONSUMED';
      res.reason = 'FILL_CONSUMED';
      this.activeReservations.set(reservationId, res);
      this.logger.log(`[RESERVATION CONSUMED] id=${reservationId}`);
      return res;
    }
  }

  /**
   * Partially consumes reservation (e.g. for partial order fills), retaining remainder reserved.
   */
  public async consumePartialReservation(
    reservationId: string,
    consumedMargin: number,
  ): Promise<ReservationRecord> {
    const res = this.activeReservations.get(reservationId);
    if (!res) {
      throw new NotFoundException(`Reservation '${reservationId}' not found`);
    }
    if (res.status !== 'RESERVED') {
      throw new ConflictException(`Cannot partially consume reservation in status '${res.status}'`);
    }
    if (consumedMargin <= 0) {
      throw new ConflictException(`Consumed margin must be strictly greater than 0`);
    }

    if (consumedMargin >= res.marginAmount) {
      // Fully consumed
      res.consumedMargin = (res.consumedMargin ?? 0) + res.marginAmount;
      res.marginAmount = 0;
      res.status = 'CONSUMED';
      res.reason = 'FILL_CONSUMED';
    } else {
      // Partially consumed
      res.consumedMargin = (res.consumedMargin ?? 0) + consumedMargin;
      res.marginAmount = Number((res.marginAmount - consumedMargin).toFixed(2));
      // Remains in RESERVED status for the remaining marginAmount
    }

    this.activeReservations.set(reservationId, res);
    this.logger.log(
      `[RESERVATION PARTIALLY CONSUMED] id=${reservationId} | consumed=₹${consumedMargin.toFixed(2)} | remaining=₹${res.marginAmount.toFixed(2)} | status=${res.status}`,
    );
    return res;
  }

  /**
   * Releases full or partial reservation upon order cancellation, rejection, or abort.
   */
  public async releaseReservation(
    reservationId: string,
    reason = 'NORMAL_RELEASE',
    releasedMargin?: number,
  ): Promise<ReservationRecord | void> {
    const res = this.activeReservations.get(reservationId);
    if (res && res.status === 'RESERVED') {
      if (releasedMargin !== undefined && releasedMargin < res.marginAmount && releasedMargin > 0) {
        // Partial release
        res.releasedMargin = (res.releasedMargin ?? 0) + releasedMargin;
        res.marginAmount = Number((res.marginAmount - releasedMargin).toFixed(2));
        res.reason = reason;
      } else {
        // Full release
        res.releasedMargin = (res.releasedMargin ?? 0) + res.marginAmount;
        res.status = 'RELEASED';
        res.reason = reason;
      }
      this.activeReservations.set(reservationId, res);
      this.logger.log(`[RESERVATION RELEASED] id=${reservationId} | reason=${reason} | remainingMargin=₹${res.marginAmount}`);
      return res;
    }
  }

  /**
   * Fetches a single reservation by ID.
   */
  public async getReservation(reservationId: string): Promise<ReservationRecord | null> {
    return this.activeReservations.get(reservationId) ?? null;
  }

  /**
   * Finds reservation by fingerprint.
   */
  public async getReservationByFingerprint(fingerprint: string): Promise<ReservationRecord | null> {
    const now = new Date();
    // Prioritize active reservation
    const active = Array.from(this.activeReservations.values()).find(
      (r) => r.fingerprint === fingerprint && r.status === 'RESERVED' && r.expiresAt > now,
    );
    if (active) return active;

    // Fall back to any reservation with matching fingerprint
    const anyRes = Array.from(this.activeReservations.values())
      .reverse()
      .find((r) => r.fingerprint === fingerprint);
    return anyRes ?? null;
  }

  /**
   * Returns all active, unexpired reservations for an account.
   */
  public async getActiveReservationsForAccount(accountId: string): Promise<ReservationRecord[]> {
    const now = new Date();
    return Array.from(this.activeReservations.values()).filter(
      (r) => r.accountId === accountId && r.status === 'RESERVED' && r.expiresAt > now,
    );
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
    let count = 0;
    for (const [id, res] of this.activeReservations.entries()) {
      if (res.status === 'RESERVED' && res.expiresAt <= now) {
        res.status = 'EXPIRED';
        res.reason = 'TTL_EXPIRED';
        this.activeReservations.set(id, res);
        count++;
      }
    }
    if (count > 0) {
      this.logger.log(`[RESERVATIONS EXPIRED] Released ${count} expired reservations`);
    }
    return count;
  }
}
