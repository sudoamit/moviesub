import { ConflictException } from '@nestjs/common';
import { TradeDecisionService, ExecutionFailureReason } from '../trade-decision.service';
import {
  TradeDecisionType,
  TradeLifecycleState,
  Direction,
  Timeframe,
  SignalGrade,
  SignalState,
} from '@quant/shared';

describe('Phase 18 — Strategy Engine Domain Invariant Bridges', () => {
  let tradeDecisionService: TradeDecisionService;
  let mockPrisma: any;
  let mockLifecycleService: any;
  let mockReservationService: any;
  let mockExecutionService: any;

  const mockBot: any = {
    id: 'bot_nifty_momentum',
    name: 'NIFTY Momentum Pro',
    symbol: 'NIFTY',
    timeframe: Timeframe.M15,
    direction: 'ANY',
    strategyType: 'SMC',
    smcCondition: 'ORDER_BLOCK',
    minScore: 70,
    lots: 1,
    isActive: true,
    autoExecutePaper: true,
    leverage: 1.0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const mockSignal: any = {
    id: 'sig_101',
    symbol: 'NIFTY',
    timeframe: Timeframe.M15,
    direction: Direction.BULLISH,
    score: 85,
    grade: SignalGrade.A,
    state: SignalState.ACTIVE,
    canonicalCandleTime: Date.now() - 30000,
    canonicalDecisionTime: new Date(Date.now() - 30000),
    entryZone: { min: 24000, max: 24050, optimal: 24020 },
    stopLoss: 23950,
    takeProfits: { tp1: 24100, tp2: 24200, tp3: 24300 },
    riskRewardRatios: { tp1: 1.5, tp2: 2.5, tp3: 4.0 },
    reasoning: ['Order block validation passed'],
    scoreBreakdown: {},
    triggerEvidence: {
      orderBlock: { matched: true, timestamp: new Date().toISOString() },
    },
  };

  beforeEach(() => {
    mockPrisma = {
      tradeDecision: {
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
      },
      algoBotExecution: {
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      $transaction: jest.fn(async (cb: any) => cb(mockPrisma)),
    };

    mockLifecycleService = {
      transition: jest.fn().mockResolvedValue({
        success: true,
        tradeDecisionId: 'dec_123',
        currentState: TradeLifecycleState.RESERVATION_CREATED,
        transitionTime: new Date(),
      }),
      isValidTransition: jest.fn().mockReturnValue(true),
      getLifecycleState: jest.fn().mockResolvedValue(TradeLifecycleState.RESERVATION_CREATED),
    };

    mockReservationService = {
      reserveResources: jest.fn().mockResolvedValue({
        reservationId: 'res_abc123',
        accountId: 'acc_live_1',
        fingerprint: 'fp_123',
        status: 'RESERVED',
        marginAmount: 24020,
        exposureAmount: 24020,
        riskAmount: 70,
        expiresAt: new Date(Date.now() + 60000),
      }),
      consumeReservation: jest.fn().mockResolvedValue({
        reservationId: 'res_abc123',
        status: 'CONSUMED',
      }),
      releaseReservation: jest.fn().mockResolvedValue({
        reservationId: 'res_abc123',
        status: 'RELEASED',
      }),
      getReservationByFingerprint: jest.fn().mockResolvedValue({
        reservationId: 'res_abc123',
        fingerprint: 'fp_123',
        status: 'RESERVED',
      }),
    };

    mockExecutionService = {
      markStarted: jest.fn().mockResolvedValue({ state: 'EXECUTING' }),
      markExecuted: jest.fn().mockResolvedValue({ state: 'EXECUTED' }),
      markFailed: jest.fn().mockResolvedValue({ state: 'FAILED_FINAL' }),
    };

    tradeDecisionService = new TradeDecisionService(
      mockPrisma,
      mockLifecycleService,
      mockReservationService,
      mockExecutionService,
    );
  });

  describe('1. Pre-Trade Resource Reservation', () => {
    it('should atomically reserve margin, notional exposure, and risk when committing a TAKE decision', async () => {
      mockPrisma.tradeDecision.findUnique.mockResolvedValue(null);
      mockPrisma.tradeDecision.create.mockResolvedValue({
        id: 'dec_new_1',
        fingerprint: 'fp_123',
        decisionReasonCode: 'PRE_TRADE_APPROVED',
      });
      mockPrisma.algoBotExecution.create.mockResolvedValue({
        id: 'exec_new_1',
        fingerprint: 'fp_123',
      });
      mockPrisma.tradeDecision.update.mockResolvedValue({
        id: 'dec_new_1',
      });

      const decisionResult: any = {
        decision: TradeDecisionType.TAKE,
        decisionReasonCode: 'PRE_TRADE_APPROVED',
        decisionReason: 'Eligible',
        lifecycleState: TradeLifecycleState.PRE_TRADE_APPROVED,
        plannedLevels: {
          optimalEntry: 24020,
          stopLoss: 23950,
          target1: 24100,
          quantity: 25,
          riskAmount: 1750,
          leverage: 1.0,
          riskPercent: 1.0,
        },
      };

      const result = await tradeDecisionService.commitTradeDecisionAndReservation({
        bot: mockBot,
        signal: mockSignal,
        decisionResult,
        fingerprint: 'fp_123',
        correlationId: 'corr_123',
        accountId: 'acc_live_1',
      });

      expect(mockReservationService.reserveResources).toHaveBeenCalledWith(
        expect.objectContaining({
          accountId: 'acc_live_1',
          botId: 'bot_nifty_momentum',
          fingerprint: 'fp_123',
          marginAmount: expect.any(Number),
          exposureAmount: expect.any(Number),
          riskAmount: 1750,
        }),
      );

      expect(result.decision).toBe(TradeDecisionType.TAKE);
      expect(result.lifecycleState).toBe(TradeLifecycleState.RESERVATION_CREATED);
      expect(result.executionId).toBe('exec_new_1');
    });

    it('should reject trade decision with RESERVATION_FAILED if margin reservation is declined', async () => {
      mockReservationService.reserveResources.mockRejectedValue(
        new ConflictException('INSUFFICIENT_MARGIN_RESERVATION: Available margin ₹500 is less than ₹24020'),
      );

      const decisionResult: any = {
        decision: TradeDecisionType.TAKE,
        decisionReasonCode: 'PRE_TRADE_APPROVED',
        decisionReason: 'Eligible',
        lifecycleState: TradeLifecycleState.PRE_TRADE_APPROVED,
        plannedLevels: {
          optimalEntry: 24020,
          stopLoss: 23950,
          target1: 24100,
          quantity: 1,
          riskAmount: 70,
          leverage: 1.0,
          riskPercent: 1.0,
        },
      };

      const result = await tradeDecisionService.commitTradeDecisionAndReservation({
        bot: mockBot,
        signal: mockSignal,
        decisionResult,
        fingerprint: 'fp_123',
        correlationId: 'corr_123',
        accountId: 'acc_live_1',
      });

      expect(result.decision).toBe(TradeDecisionType.REJECT);
      expect(result.decisionReasonCode).toBe('INSUFFICIENT_MARGIN');
      expect(result.lifecycleState).toBe(TradeLifecycleState.RESERVATION_FAILED);
      expect(mockPrisma.tradeDecision.create).not.toHaveBeenCalled();
    });

    it('should return duplicate conflict if ReservationService detects duplicate active reservation', async () => {
      mockReservationService.reserveResources.mockRejectedValue(
        new ConflictException('RESERVATION_CONFLICT: Active reservation already held'),
      );

      const decisionResult: any = {
        decision: TradeDecisionType.TAKE,
        decisionReasonCode: 'PRE_TRADE_APPROVED',
        decisionReason: 'Eligible',
        lifecycleState: TradeLifecycleState.PRE_TRADE_APPROVED,
        plannedLevels: {
          optimalEntry: 24020,
          stopLoss: 23950,
          target1: 24100,
          quantity: 1,
          riskAmount: 70,
          leverage: 1.0,
          riskPercent: 1.0,
        },
      };

      const result = await tradeDecisionService.commitTradeDecisionAndReservation({
        bot: mockBot,
        signal: mockSignal,
        decisionResult,
        fingerprint: 'fp_123',
        correlationId: 'corr_123',
        accountId: 'acc_live_1',
      });

      expect(result.decision).toBe(TradeDecisionType.REJECT);
      expect(result.decisionReasonCode).toBe('DUPLICATE_RESERVATION');
      expect(result.isDuplicate).toBe(true);
      expect(result.lifecycleState).toBe(TradeLifecycleState.RESERVATION_FAILED);
    });

    it('should release reservation if subsequent database transaction aborts', async () => {
      mockPrisma.$transaction.mockRejectedValue(new Error('DB_DEADLOCK_ERROR'));

      const decisionResult: any = {
        decision: TradeDecisionType.TAKE,
        decisionReasonCode: 'PRE_TRADE_APPROVED',
        decisionReason: 'Eligible',
        lifecycleState: TradeLifecycleState.PRE_TRADE_APPROVED,
        plannedLevels: {
          optimalEntry: 24020,
          stopLoss: 23950,
          target1: 24100,
          quantity: 1,
          riskAmount: 70,
          leverage: 1.0,
          riskPercent: 1.0,
        },
      };

      await expect(
        tradeDecisionService.commitTradeDecisionAndReservation({
          bot: mockBot,
          signal: mockSignal,
          decisionResult,
          fingerprint: 'fp_trans_fail',
          correlationId: 'corr_123',
          accountId: 'acc_live_1',
        }),
      ).rejects.toThrow('DB_DEADLOCK_ERROR');

      expect(mockReservationService.releaseReservation).toHaveBeenCalledWith(
        'res_abc123',
        'TRANSACTION_ABORTED',
      );
    });
  });

  describe('2. Trade Lifecycle Service Delegation', () => {
    it('should delegate updateTradeLifecycleState to TradeLifecycleService.transition', async () => {
      mockPrisma.tradeDecision.findUnique.mockResolvedValue({
        id: 'dec_123',
        lifecycleState: TradeLifecycleState.RESERVATION_CREATED,
      });

      await tradeDecisionService.updateTradeLifecycleState(
        'dec_123',
        TradeLifecycleState.ORDER_SUBMITTED,
        { executionId: 'exec_123' },
        TradeLifecycleState.RESERVATION_CREATED,
      );

      expect(mockLifecycleService.transition).toHaveBeenCalledWith({
        tradeDecisionId: 'dec_123',
        expectedState: TradeLifecycleState.RESERVATION_CREATED,
        newState: TradeLifecycleState.ORDER_SUBMITTED,
        event: 'ORDER_SUBMITTED',
        correlationId: 'exec_123',
        metadata: { executionId: 'exec_123' },
      });
    });

    it('should handle idempotent same-state without error', async () => {
      mockPrisma.tradeDecision.findUnique.mockResolvedValue({
        id: 'dec_123',
        lifecycleState: TradeLifecycleState.POSITION_OPENED,
      });

      await expect(
        tradeDecisionService.updateTradeLifecycleState(
          'dec_123',
          TradeLifecycleState.POSITION_OPENED,
          { executionId: 'exec_123' },
        ),
      ).resolves.not.toThrow();

      expect(mockLifecycleService.transition).not.toHaveBeenCalled();
    });

    it('should treat transition to ORDER_FILLED as idempotent no-op if position is already POSITION_OPENED', async () => {
      mockPrisma.tradeDecision.findUnique.mockResolvedValue({
        id: 'dec_123',
        lifecycleState: TradeLifecycleState.POSITION_OPENED,
      });

      await expect(
        tradeDecisionService.updateTradeLifecycleState(
          'dec_123',
          TradeLifecycleState.ORDER_FILLED,
          { executionId: 'exec_123' },
        ),
      ).resolves.not.toThrow();

      expect(mockLifecycleService.transition).not.toHaveBeenCalled();
    });
  });

  describe('3. Execution State Machine Coordination & Reservation Settlement', () => {
    it('should coordinate markExecutionStarted with ExecutionService', async () => {
      await tradeDecisionService.markExecutionStarted('exec_123');

      expect(mockExecutionService.markStarted).toHaveBeenCalledWith('exec_123');
    });

    it('should coordinate markExecutionExecuted and consume reservation upon fill', async () => {
      mockPrisma.algoBotExecution.findUnique.mockResolvedValue({
        id: 'exec_123',
        fingerprint: 'fp_123',
      });

      await tradeDecisionService.markExecutionExecuted('exec_123', 'pos_123');

      expect(mockExecutionService.markExecuted).toHaveBeenCalledWith('exec_123', 'pos_123');
      expect(mockReservationService.getReservationByFingerprint).toHaveBeenCalledWith('fp_123');
      expect(mockReservationService.consumeReservation).toHaveBeenCalledWith('res_abc123');
    });

    it('should coordinate markExecutionFailed and release reservation upon failure', async () => {
      mockPrisma.algoBotExecution.findUnique.mockResolvedValue({
        id: 'exec_123',
        fingerprint: 'fp_123',
      });

      await tradeDecisionService.markExecutionFailed('exec_123', new Error('BROKER_DISCONNECT'), {
        reasonCode: ExecutionFailureReason.BROKER_UNAVAILABLE,
        message: 'Broker socket closed',
        retryable: false,
      });

      expect(mockExecutionService.markFailed).toHaveBeenCalledWith(
        'exec_123',
        ExecutionFailureReason.BROKER_UNAVAILABLE,
        'Broker socket closed',
        false,
      );
      expect(mockReservationService.getReservationByFingerprint).toHaveBeenCalledWith('fp_123');
      expect(mockReservationService.releaseReservation).toHaveBeenCalledWith(
        'res_abc123',
        ExecutionFailureReason.BROKER_UNAVAILABLE,
      );
    });
  });

  describe('4. Standalone Fallback & Backward Compatibility', () => {
    it('should function in isolated in-memory unit test mode without domain services', async () => {
      const standaloneService = new TradeDecisionService();

      const decisionResult: any = {
        decision: TradeDecisionType.TAKE,
        decisionReasonCode: 'PRE_TRADE_APPROVED',
        decisionReason: 'Eligible',
        lifecycleState: TradeLifecycleState.PRE_TRADE_APPROVED,
        plannedLevels: {
          optimalEntry: 24020,
          stopLoss: 23950,
          target1: 24100,
          quantity: 1,
          riskAmount: 70,
          leverage: 1.0,
          riskPercent: 1.0,
        },
      };

      const res = await standaloneService.commitTradeDecisionAndReservation({
        bot: mockBot,
        signal: mockSignal,
        decisionResult,
        fingerprint: 'fp_standalone',
        correlationId: 'corr_1',
        accountId: 'acc_1',
      });

      expect(res.decision).toBe(TradeDecisionType.TAKE);
      expect(res.tradeDecisionId).toBe('test_dec_fp_standalone');
      expect(res.lifecycleState).toBe(TradeLifecycleState.RESERVATION_CREATED);
    });
  });
});
