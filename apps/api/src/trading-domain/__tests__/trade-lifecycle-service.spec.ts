import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { TradeLifecycleService } from '../trade-lifecycle.service';
import { TradeLifecycleState } from '@quant/shared';

describe('TradeLifecycleService', () => {
  let service: TradeLifecycleService;
  let mockDecisions: any[] = [];

  const mockPrisma: any = {
    tradeDecision: {
      findUnique: jest.fn(({ where, select }) => {
        const found = mockDecisions.find((d) => d.id === where.id);
        if (!found) return null;
        if (select?.lifecycleState) {
          return { lifecycleState: found.lifecycleState };
        }
        return found;
      }),
      update: jest.fn(({ where, data }) => {
        const found = mockDecisions.find((d) => d.id === where.id);
        if (!found) throw new NotFoundException(`TradeDecision '${where.id}' not found`);
        Object.assign(found, data, { updatedAt: new Date() });
        return found;
      }),
    },
  };

  beforeEach(async () => {
    mockDecisions = [];
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TradeLifecycleService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get<TradeLifecycleService>(TradeLifecycleService);
  });

  describe('Terminal States and Queries', () => {
    it('correctly identifies terminal states', () => {
      expect(service.isTerminalState(TradeLifecycleState.TRADE_CLOSED)).toBe(true);
      expect(service.isTerminalState(TradeLifecycleState.TRADE_REJECTED)).toBe(true);
      expect(service.isTerminalState(TradeLifecycleState.TRADE_FAILED)).toBe(true);
      expect(service.isTerminalState(TradeLifecycleState.TRADE_CANCELLED)).toBe(true);

      // Non-terminal states
      expect(service.isTerminalState(TradeLifecycleState.SIGNAL_DETECTED)).toBe(false);
      expect(service.isTerminalState(TradeLifecycleState.ORDER_SUBMITTED)).toBe(false);
      expect(service.isTerminalState(TradeLifecycleState.POSITION_OPENED)).toBe(false);
      expect(service.isTerminalState(TradeLifecycleState.EXIT_TRIGGERED)).toBe(false);
    });

    it('returns empty next states for terminal states and non-empty for non-terminal', () => {
      expect(service.getAllowedNextStates(TradeLifecycleState.TRADE_CLOSED)).toEqual([]);
      expect(service.getAllowedNextStates(TradeLifecycleState.TRADE_REJECTED)).toEqual([]);
      expect(service.getAllowedNextStates(TradeLifecycleState.TRADE_FAILED)).toEqual([]);
      expect(service.getAllowedNextStates(TradeLifecycleState.TRADE_CANCELLED)).toEqual([]);

      const nextFromSignal = service.getAllowedNextStates(TradeLifecycleState.SIGNAL_DETECTED);
      expect(nextFromSignal).toContain(TradeLifecycleState.SIGNAL_VALIDATED);
      expect(nextFromSignal).toContain(TradeLifecycleState.TRADE_REJECTED);
      expect(nextFromSignal).toContain(TradeLifecycleState.TRADE_CANCELLED);
    });

    it('retrieves lifecycle state from database', async () => {
      mockDecisions.push({
        id: 'dec_lookup_1',
        lifecycleState: TradeLifecycleState.POSITION_OPENED,
      });

      const state = await service.getLifecycleState('dec_lookup_1');
      expect(state).toBe(TradeLifecycleState.POSITION_OPENED);

      const nonExistent = await service.getLifecycleState('does_not_exist');
      expect(nonExistent).toBeNull();
    });
  });

  describe('FSM Transition Validation', () => {
    it('allows valid transitions and allows same-state transitions (idempotency)', () => {
      expect(
        service.isValidTransition(TradeLifecycleState.SIGNAL_DETECTED, TradeLifecycleState.SIGNAL_VALIDATED),
      ).toBe(true);
      expect(
        service.isValidTransition(TradeLifecycleState.POSITION_OPENED, TradeLifecycleState.POSITION_OPENED),
      ).toBe(true);
    });

    it('disallows invalid skip transitions', () => {
      expect(
        service.isValidTransition(TradeLifecycleState.SIGNAL_DETECTED, TradeLifecycleState.ORDER_FILLED),
      ).toBe(false);
      expect(
        service.isValidTransition(TradeLifecycleState.PRE_TRADE_APPROVED, TradeLifecycleState.POSITION_OPENED),
      ).toBe(false);
      expect(
        service.isValidTransition(TradeLifecycleState.TRADE_CLOSED, TradeLifecycleState.POSITION_OPENED),
      ).toBe(false);
    });
  });

  describe('Full End-to-End Lifecycle Progression', () => {
    it('progresses through happy path lifecycle stages and sets milestone timestamps', async () => {
      const decisionId = 'dec_happy_path';
      mockDecisions.push({
        id: decisionId,
        lifecycleState: TradeLifecycleState.SIGNAL_DETECTED,
      });

      // 1. SIGNAL_DETECTED -> SIGNAL_VALIDATED
      const res1 = await service.transition({
        tradeDecisionId: decisionId,
        expectedState: TradeLifecycleState.SIGNAL_DETECTED,
        newState: TradeLifecycleState.SIGNAL_VALIDATED,
        event: 'VALIDATION_PASSED',
        correlationId: 'corr_1',
      });
      expect(res1.previousState).toBe(TradeLifecycleState.SIGNAL_DETECTED);
      expect(res1.currentState).toBe(TradeLifecycleState.SIGNAL_VALIDATED);
      expect(mockDecisions[0].canonicalDecisionTime).toBeDefined();

      // 2. SIGNAL_VALIDATED -> ELIGIBILITY_EVALUATED
      await service.transition({
        tradeDecisionId: decisionId,
        expectedState: TradeLifecycleState.SIGNAL_VALIDATED,
        newState: TradeLifecycleState.ELIGIBILITY_EVALUATED,
        event: 'ELIGIBILITY_PASSED',
        correlationId: 'corr_2',
      });

      // 3. ELIGIBILITY_EVALUATED -> RISK_APPROVED
      await service.transition({
        tradeDecisionId: decisionId,
        expectedState: TradeLifecycleState.ELIGIBILITY_EVALUATED,
        newState: TradeLifecycleState.RISK_APPROVED,
        event: 'RISK_APPROVED',
        correlationId: 'corr_3',
      });

      // 4. RISK_APPROVED -> PRE_TRADE_APPROVED
      await service.transition({
        tradeDecisionId: decisionId,
        expectedState: TradeLifecycleState.RISK_APPROVED,
        newState: TradeLifecycleState.PRE_TRADE_APPROVED,
        event: 'PRE_TRADE_CHECK_PASSED',
        correlationId: 'corr_4',
      });

      // 5. PRE_TRADE_APPROVED -> TRADE_TAKEN
      await service.transition({
        tradeDecisionId: decisionId,
        expectedState: TradeLifecycleState.PRE_TRADE_APPROVED,
        newState: TradeLifecycleState.TRADE_TAKEN,
        event: 'TRIGGER_FIRED',
        correlationId: 'corr_5',
      });
      expect(mockDecisions[0].tradeTakenAt).toBeDefined();
      expect(mockDecisions[0].tradeTakenTime).toBeDefined();

      // 6. TRADE_TAKEN -> RESERVATION_CREATED
      await service.transition({
        tradeDecisionId: decisionId,
        expectedState: TradeLifecycleState.TRADE_TAKEN,
        newState: TradeLifecycleState.RESERVATION_CREATED,
        event: 'RESERVATION_LOCKED',
        correlationId: 'corr_6',
      });
      expect(mockDecisions[0].reservationCreatedAt).toBeDefined();

      // 7. RESERVATION_CREATED -> ORDER_SUBMITTED
      await service.transition({
        tradeDecisionId: decisionId,
        expectedState: TradeLifecycleState.RESERVATION_CREATED,
        newState: TradeLifecycleState.ORDER_SUBMITTED,
        event: 'ORDER_SENT_TO_BROKER',
        correlationId: 'corr_7',
      });
      expect(mockDecisions[0].orderSubmittedAt).toBeDefined();

      // 8. ORDER_SUBMITTED -> ORDER_FILLED
      await service.transition({
        tradeDecisionId: decisionId,
        expectedState: TradeLifecycleState.ORDER_SUBMITTED,
        newState: TradeLifecycleState.ORDER_FILLED,
        event: 'FILL_CONFIRMED',
        correlationId: 'corr_8',
      });
      expect(mockDecisions[0].firstFillAt).toBeDefined();
      expect(mockDecisions[0].fillTime).toBeDefined();

      // 9. ORDER_FILLED -> POSITION_OPENED
      await service.transition({
        tradeDecisionId: decisionId,
        expectedState: TradeLifecycleState.ORDER_FILLED,
        newState: TradeLifecycleState.POSITION_OPENED,
        event: 'POSITION_ESTABLISHED',
        correlationId: 'corr_9',
        metadata: {
          executionId: 'exec_abc',
          orderPositionId: 'pos_xyz',
        },
      });
      expect(mockDecisions[0].positionOpenedAt).toBeDefined();
      expect(mockDecisions[0].executionId).toBe('exec_abc');
      expect(mockDecisions[0].orderPositionId).toBe('pos_xyz');

      // 10. POSITION_OPENED -> TP1_TRIGGERED
      await service.transition({
        tradeDecisionId: decisionId,
        expectedState: TradeLifecycleState.POSITION_OPENED,
        newState: TradeLifecycleState.TP1_TRIGGERED,
        event: 'PRICE_HIT_TP1',
        correlationId: 'corr_10',
      });

      // 11. TP1_TRIGGERED -> POSITION_PARTIALLY_CLOSED
      await service.transition({
        tradeDecisionId: decisionId,
        expectedState: TradeLifecycleState.TP1_TRIGGERED,
        newState: TradeLifecycleState.POSITION_PARTIALLY_CLOSED,
        event: 'TP1_EXECUTION_COMPLETED',
        correlationId: 'corr_11',
      });

      // 12. POSITION_PARTIALLY_CLOSED -> POSITION_CLOSED
      await service.transition({
        tradeDecisionId: decisionId,
        expectedState: TradeLifecycleState.POSITION_PARTIALLY_CLOSED,
        newState: TradeLifecycleState.POSITION_CLOSED,
        event: 'FINAL_EXIT_FILLED',
        correlationId: 'corr_12',
      });

      // 13. POSITION_CLOSED -> TRADE_CLOSED
      const finalRes = await service.transition({
        tradeDecisionId: decisionId,
        expectedState: TradeLifecycleState.POSITION_CLOSED,
        newState: TradeLifecycleState.TRADE_CLOSED,
        event: 'ACCOUNTING_RECONCILED',
        correlationId: 'corr_13',
      });
      expect(finalRes.currentState).toBe(TradeLifecycleState.TRADE_CLOSED);
      expect(mockDecisions[0].lifecycleState).toBe(TradeLifecycleState.TRADE_CLOSED);
      expect(mockDecisions[0].decisionTime).toBeDefined();
    });
  });

  describe('Terminal State Invariants', () => {
    it('rejects any transition attempting to leave TRADE_CLOSED', async () => {
      mockDecisions.push({
        id: 'dec_closed',
        lifecycleState: TradeLifecycleState.TRADE_CLOSED,
      });

      await expect(
        service.transition({
          tradeDecisionId: 'dec_closed',
          newState: TradeLifecycleState.POSITION_OPENED,
          event: 'REOPEN_ATTEMPT',
          correlationId: 'corr_fail',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects any transition attempting to leave TRADE_REJECTED', async () => {
      mockDecisions.push({
        id: 'dec_rejected',
        lifecycleState: TradeLifecycleState.TRADE_REJECTED,
      });

      await expect(
        service.transition({
          tradeDecisionId: 'dec_rejected',
          newState: TradeLifecycleState.ORDER_SUBMITTED,
          event: 'RETRY_ORDER',
          correlationId: 'corr_fail',
        }),
      ).rejects.toThrow(/INVALID_LIFECYCLE_TRANSITION/);
    });

    it('rejects any transition attempting to leave TRADE_FAILED', async () => {
      mockDecisions.push({
        id: 'dec_failed',
        lifecycleState: TradeLifecycleState.TRADE_FAILED,
      });

      await expect(
        service.transition({
          tradeDecisionId: 'dec_failed',
          newState: TradeLifecycleState.TRADE_TAKEN,
          event: 'RETRY_TRADE',
          correlationId: 'corr_fail',
        }),
      ).rejects.toThrow(/INVALID_LIFECYCLE_TRANSITION/);
    });

    it('rejects any transition attempting to leave TRADE_CANCELLED', async () => {
      mockDecisions.push({
        id: 'dec_cancelled',
        lifecycleState: TradeLifecycleState.TRADE_CANCELLED,
      });

      await expect(
        service.transition({
          tradeDecisionId: 'dec_cancelled',
          newState: TradeLifecycleState.ORDER_SUBMITTED,
          event: 'RESUBMIT',
          correlationId: 'corr_fail',
        }),
      ).rejects.toThrow(/INVALID_LIFECYCLE_TRANSITION/);
    });
  });

  describe('Concurrency & Expected State Verification', () => {
    it('throws LIFECYCLE_CONFLICT if expectedState does not match current state', async () => {
      mockDecisions.push({
        id: 'dec_conflict',
        lifecycleState: TradeLifecycleState.ORDER_SUBMITTED,
      });

      await expect(
        service.transition({
          tradeDecisionId: 'dec_conflict',
          expectedState: TradeLifecycleState.TRADE_TAKEN, // Mismatch! Current is ORDER_SUBMITTED
          newState: TradeLifecycleState.ORDER_FILLED,
          event: 'FILL_EVENT',
          correlationId: 'corr_c1',
        }),
      ).rejects.toThrow(/LIFECYCLE_CONFLICT/);
    });

    it('accepts array of expected states when current matches one of them', async () => {
      mockDecisions.push({
        id: 'dec_array_expected',
        lifecycleState: TradeLifecycleState.ORDER_PARTIALLY_FILLED,
      });

      const res = await service.transition({
        tradeDecisionId: 'dec_array_expected',
        expectedState: [TradeLifecycleState.ORDER_SUBMITTED, TradeLifecycleState.ORDER_PARTIALLY_FILLED],
        newState: TradeLifecycleState.ORDER_FILLED,
        event: 'FINAL_FILL',
        correlationId: 'corr_array',
      });

      expect(res.currentState).toBe(TradeLifecycleState.ORDER_FILLED);
    });
  });

  describe('Idempotent Same-State Transitions', () => {
    it('handles idempotent transitions without error', async () => {
      mockDecisions.push({
        id: 'dec_idem',
        lifecycleState: TradeLifecycleState.POSITION_OPENED,
      });

      const res = await service.transition({
        tradeDecisionId: 'dec_idem',
        expectedState: TradeLifecycleState.POSITION_OPENED,
        newState: TradeLifecycleState.POSITION_OPENED,
        event: 'DUPLICATE_POSITION_OPENED_MSG',
        correlationId: 'corr_idem',
      });

      expect(res.success).toBe(true);
      expect(res.currentState).toBe(TradeLifecycleState.POSITION_OPENED);
      expect(res.previousState).toBe(TradeLifecycleState.POSITION_OPENED);
    });
  });

  describe('Error Handling', () => {
    it('throws NotFoundException if trade decision does not exist', async () => {
      await expect(
        service.transition({
          tradeDecisionId: 'non_existent_id',
          newState: TradeLifecycleState.TRADE_TAKEN,
          event: 'TEST',
          correlationId: 'corr_err',
        }),
      ).rejects.toThrow(NotFoundException);
    });
  });
});
