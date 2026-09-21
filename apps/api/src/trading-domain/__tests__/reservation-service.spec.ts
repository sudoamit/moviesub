import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ReservationService } from '../reservation.service';
import { PositionState } from '@quant/shared';

describe('ReservationService', () => {
  let reservationService: ReservationService;

  const mockAccounts: any[] = [
    {
      id: 'acc_res_1',
      cashBalance: 100000,
      usedMargin: 0,
      currency: 'INR',
    },
    {
      id: 'acc_res_2',
      cashBalance: 5000,
      usedMargin: 0,
      currency: 'INR',
    },
  ];

  const mockPositions: any[] = [
    {
      id: 'pos_1',
      accountId: 'acc_res_1',
      usedMargin: 20000,
      status: PositionState.OPEN,
    },
  ];

  let mockReservations: any[] = [];

  const mockPrisma: any = {
    paperAccount: {
      findUnique: jest.fn(({ where }) => mockAccounts.find((a) => a.id === where.id) || null),
    },
    paperPosition: {
      findMany: jest.fn(({ where }) => {
        let res = [...mockPositions];
        if (where?.accountId) res = res.filter((p) => p.accountId === where.accountId);
        if (where?.status?.in) res = res.filter((p) => where.status.in.includes(p.status));
        return res;
      }),
    },
    tradeReservation: {
      create: jest.fn(({ data }) => {
        const r = { id: `tr_${Date.now()}_${Math.random()}`, createdAt: new Date(), ...data };
        mockReservations.push(r);
        return r;
      }),
      findUnique: jest.fn(({ where }) => {
        return mockReservations.find((r) => r.reservationId === where.reservationId || r.id === where.id) || null;
      }),
      findFirst: jest.fn(({ where }) => {
        let list = [...mockReservations];
        if (where?.fingerprint) list = list.filter((r) => r.fingerprint === where.fingerprint);
        if (where?.status) list = list.filter((r) => r.status === where.status);
        if (where?.expiresAt?.gt) {
          list = list.filter((r) => r.expiresAt > where.expiresAt.gt);
        }
        return list[list.length - 1] || null;
      }),
      findMany: jest.fn(({ where }) => {
        let list = [...mockReservations];
        if (where?.accountId) list = list.filter((r) => r.accountId === where.accountId);
        if (where?.status) list = list.filter((r) => r.status === where.status);
        if (where?.expiresAt?.gt) {
          list = list.filter((r) => r.expiresAt > where.expiresAt.gt);
        }
        return list;
      }),
      update: jest.fn(({ where, data }) => {
        const r = mockReservations.find((res) => res.reservationId === where.reservationId || res.id === where.id);
        if (r) Object.assign(r, data);
        return r;
      }),
      updateMany: jest.fn(({ where, data }) => {
        let count = 0;
        mockReservations.forEach((r) => {
          let matches = true;
          if (where?.status && r.status !== where.status) matches = false;
          if (where?.expiresAt?.lte && !(r.expiresAt <= where.expiresAt.lte)) matches = false;
          if (matches) {
            Object.assign(r, data);
            count++;
          }
        });
        return { count };
      }),
    },
    tradeDecision: {
      update: jest.fn(),
    },
    $transaction: jest.fn(async (cb) => cb(mockPrisma)),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    mockReservations = [];

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReservationService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    reservationService = module.get<ReservationService>(ReservationService);
  });

  describe('Atomic Reservation Creation', () => {
    it('creates an atomic reservation with finite TTL and initializes audit fields in database', async () => {
      const res = await reservationService.reserveResources({
        accountId: 'acc_res_1',
        botId: 'bot_alpha',
        tradeDecisionId: 'dec_101',
        fingerprint: 'fp_res_test_1',
        riskAmount: 1500,
        marginAmount: 15000,
        exposureAmount: 75000,
        currency: 'INR',
        expiresInSeconds: 45,
      });

      expect(res.reservationId).toMatch(/^res_\d+_[a-f0-9]{8}$/);
      expect(res.status).toBe('RESERVED');
      expect(res.consumedMargin).toBe(0);
      expect(res.releasedMargin).toBe(0);
      expect(res.expiresAt.getTime()).toBeGreaterThan(Date.now());
      expect(res.marginAmount).toBe(15000);
      expect(res.exposureAmount).toBe(75000);
      expect(res.riskAmount).toBe(1500);

      // Verify persisted in mock database
      expect(mockPrisma.tradeReservation.create).toHaveBeenCalled();

      // Verify lookup by ID and fingerprint
      const byId = await reservationService.getReservation(res.reservationId);
      expect(byId).toEqual(res);

      const byFp = await reservationService.getReservationByFingerprint('fp_res_test_1');
      expect(byFp).toEqual(res);
    });

    it('rejects duplicate concurrent reservation for identical fingerprint in DB', async () => {
      await reservationService.reserveResources({
        accountId: 'acc_res_1',
        botId: 'bot_alpha',
        tradeDecisionId: 'dec_102',
        fingerprint: 'fp_dup_check',
        riskAmount: 1000,
        marginAmount: 10000,
        exposureAmount: 50000,
        currency: 'INR',
      });

      await expect(
        reservationService.reserveResources({
          accountId: 'acc_res_1',
          botId: 'bot_beta',
          tradeDecisionId: 'dec_103',
          fingerprint: 'fp_dup_check',
          riskAmount: 1000,
          marginAmount: 10000,
          exposureAmount: 50000,
          currency: 'INR',
        }),
      ).rejects.toThrow(ConflictException);
    });

    it('rejects reservation when available cash is insufficient', async () => {
      // acc_res_2 only has 5000 cash balance
      await expect(
        reservationService.reserveResources({
          accountId: 'acc_res_2',
          botId: 'bot_gamma',
          tradeDecisionId: 'dec_104',
          fingerprint: 'fp_insufficient_margin',
          riskAmount: 2000,
          marginAmount: 8000, // exceeds 5000
          exposureAmount: 40000,
          currency: 'INR',
        }),
      ).rejects.toThrow(/INSUFFICIENT_MARGIN_RESERVATION/);
    });

    it('throws NotFoundException for non-existent account', async () => {
      await expect(
        reservationService.reserveResources({
          accountId: 'acc_non_existent',
          botId: 'bot_gamma',
          tradeDecisionId: 'dec_105',
          fingerprint: 'fp_no_account',
          riskAmount: 1000,
          marginAmount: 1000,
          exposureAmount: 5000,
          currency: 'INR',
        }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('Multi-Dimensional Aggregations', () => {
    it('aggregates total reserved margin, exposure, and risk across multiple active reservations from database', async () => {
      await reservationService.reserveResources({
        accountId: 'acc_res_1',
        botId: 'bot_1',
        tradeDecisionId: 'dec_agg_1',
        fingerprint: 'fp_agg_1',
        riskAmount: 1000,
        marginAmount: 10000,
        exposureAmount: 50000,
        currency: 'INR',
      });

      await reservationService.reserveResources({
        accountId: 'acc_res_1',
        botId: 'bot_2',
        tradeDecisionId: 'dec_agg_2',
        fingerprint: 'fp_agg_2',
        riskAmount: 1500,
        marginAmount: 15000,
        exposureAmount: 75000,
        currency: 'INR',
      });

      const totalMargin = await reservationService.getTotalReservedMargin('acc_res_1');
      const totalExposure = await reservationService.getTotalReservedExposure('acc_res_1');
      const totalRisk = await reservationService.getTotalReservedRisk('acc_res_1');

      expect(totalMargin).toBe(25000);
      expect(totalExposure).toBe(125000);
      expect(totalRisk).toBe(25000 * 0.1); // 2500
    });
  });

  describe('Lifecycle State Transitions: Consumption & Release', () => {
    it('consumes full reservation upon order fill', async () => {
      const res = await reservationService.reserveResources({
        accountId: 'acc_res_1',
        botId: 'bot_alpha',
        tradeDecisionId: 'dec_consume_1',
        fingerprint: 'fp_consume_1',
        riskAmount: 1000,
        marginAmount: 10000,
        exposureAmount: 50000,
        currency: 'INR',
      });

      const consumed = await reservationService.consumeReservation(res.reservationId);
      expect(consumed?.status).toBe('CONSUMED');
      expect(consumed?.consumedMargin).toBe(10000);
      expect(consumed?.marginAmount).toBe(0);
      expect(consumed?.reason).toBe('FILL_CONSUMED');

      // Consumed reservation no longer encumbers margin
      const active = await reservationService.getActiveReservationsForAccount('acc_res_1');
      expect(active.find((r) => r.reservationId === res.reservationId)).toBeUndefined();
    });

    it('supports partial reservation consumption for partial fills', async () => {
      const res = await reservationService.reserveResources({
        accountId: 'acc_res_1',
        botId: 'bot_alpha',
        tradeDecisionId: 'dec_partial_1',
        fingerprint: 'fp_partial_1',
        riskAmount: 2000,
        marginAmount: 20000,
        exposureAmount: 100000,
        currency: 'INR',
      });

      // Partial fill 1: 40% fill (8000 margin)
      const step1 = await reservationService.consumePartialReservation(res.reservationId, 8000);
      expect(step1.status).toBe('RESERVED');
      expect(step1.consumedMargin).toBe(8000);
      expect(step1.marginAmount).toBe(12000);

      // Remaining 12000 still active in account reserved margin
      const activeMargin = await reservationService.getTotalReservedMargin('acc_res_1');
      expect(activeMargin).toBe(12000);

      // Partial fill 2: remaining 60% fill (12000 margin)
      const step2 = await reservationService.consumePartialReservation(res.reservationId, 12000);
      expect(step2.status).toBe('CONSUMED');
      expect(step2.consumedMargin).toBe(20000);
      expect(step2.marginAmount).toBe(0);
    });

    it('releases reservation upon order rejection or cancellation', async () => {
      const res = await reservationService.reserveResources({
        accountId: 'acc_res_1',
        botId: 'bot_alpha',
        tradeDecisionId: 'dec_release_1',
        fingerprint: 'fp_release_1',
        riskAmount: 1000,
        marginAmount: 10000,
        exposureAmount: 50000,
        currency: 'INR',
      });

      const released = await reservationService.releaseReservation(
        res.reservationId,
        'ORDER_REJECTED_BY_EXCHANGE',
      );
      expect(released?.status).toBe('RELEASED');
      expect(released?.reason).toBe('ORDER_REJECTED_BY_EXCHANGE');
      expect(released?.releasedMargin).toBe(10000);

      // Active reservations count is now 0
      const active = await reservationService.getActiveReservationsForAccount('acc_res_1');
      expect(active.find((r) => r.reservationId === res.reservationId)).toBeUndefined();
    });

    it('supports partial release when residual order quantity is cancelled', async () => {
      const res = await reservationService.reserveResources({
        accountId: 'acc_res_1',
        botId: 'bot_alpha',
        tradeDecisionId: 'dec_part_rel',
        fingerprint: 'fp_part_rel',
        riskAmount: 2000,
        marginAmount: 20000,
        exposureAmount: 100000,
        currency: 'INR',
      });

      // Partially release 5,000 margin
      const part = await reservationService.releaseReservation(res.reservationId, 'PARTIAL_CANCEL', 5000);
      expect(part?.status).toBe('RESERVED');
      expect(part?.marginAmount).toBe(15000);
      expect(part?.releasedMargin).toBe(5000);
    });
  });

  describe('Automated Sweep and Expiration', () => {
    it('automatically transitions expired reservations to EXPIRED status and frees resources', async () => {
      // Create an immediate-expiring reservation (in past)
      const res = await reservationService.reserveResources({
        accountId: 'acc_res_1',
        botId: 'bot_alpha',
        tradeDecisionId: 'dec_expired_1',
        fingerprint: 'fp_expired_1',
        riskAmount: 1000,
        marginAmount: 10000,
        exposureAmount: 50000,
        currency: 'INR',
        expiresInSeconds: -1, // Already expired in the past
      });

      const sweptCount = await reservationService.releaseExpiredReservations();
      expect(sweptCount).toBeGreaterThanOrEqual(1);

      const record = await reservationService.getReservation(res.reservationId);
      expect(record?.status).toBe('EXPIRED');
      expect(record?.reason).toBe('TTL_EXPIRED');

      // No longer encumbers margin
      const active = await reservationService.getActiveReservationsForAccount('acc_res_1');
      expect(active.find((r) => r.reservationId === res.reservationId)).toBeUndefined();
    });

    it('sweeps expired reservations automatically onModuleInit (startup recovery)', async () => {
      const expiredRes = {
        reservationId: 'res_startup_expired',
        fingerprint: 'fp_startup_expired',
        accountId: 'acc_res_1',
        botId: 'bot_alpha',
        status: 'RESERVED',
        expiresAt: new Date(Date.now() - 5000),
        marginAmount: 10000,
        exposureAmount: 50000,
        riskAmount: 1000,
        consumedMargin: 0,
        releasedMargin: 0,
      };
      mockReservations.push(expiredRes);

      await reservationService.onModuleInit();
      expect(mockPrisma.tradeReservation.updateMany).toHaveBeenCalled();
      const check = await reservationService.getReservation('res_startup_expired');
      expect(check?.status).toBe('EXPIRED');
    });
  });
});
