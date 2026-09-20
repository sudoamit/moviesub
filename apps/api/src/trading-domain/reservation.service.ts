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
      };

      this.activeReservations.set(reservationId, record);
      this.logger.log(
        `[RESERVATION CREATED] id=${reservationId} | bot=${botId} | margin=₹${marginAmount.toFixed(2)} | expiresAt=${expiresAt.toISOString()}`,
      );

      return record;
    });
  }

  public async consumeReservation(reservationId: string): Promise<void> {
    const res = this.activeReservations.get(reservationId);
    if (res) {
      res.status = 'CONSUMED';
      this.activeReservations.set(reservationId, res);
      this.logger.log(`[RESERVATION CONSUMED] id=${reservationId}`);
    }
  }

  public async releaseReservation(reservationId: string, reason = 'NORMAL_RELEASE'): Promise<void> {
    const res = this.activeReservations.get(reservationId);
    if (res && res.status === 'RESERVED') {
      res.status = 'RELEASED';
      this.activeReservations.set(reservationId, res);
      this.logger.log(`[RESERVATION RELEASED] id=${reservationId} | reason=${reason}`);
    }
  }

  public async getActiveReservationsForAccount(accountId: string): Promise<ReservationRecord[]> {
    const now = new Date();
    return Array.from(this.activeReservations.values()).filter(
      (r) => r.accountId === accountId && r.status === 'RESERVED' && r.expiresAt > now,
    );
  }

  public async releaseExpiredReservations(): Promise<number> {
    const now = new Date();
    let count = 0;
    for (const [id, res] of this.activeReservations.entries()) {
      if (res.status === 'RESERVED' && res.expiresAt <= now) {
        res.status = 'EXPIRED';
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
