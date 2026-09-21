import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ExecutionService } from '../execution.service';
import { Direction } from '@quant/shared';
import { AlgoBotExecutionState } from '@prisma/client';

describe('ExecutionService', () => {
  let executionService: ExecutionService;
  let mockExecutions: any[] = [];

  const mockPrisma: any = {
    algoBotExecution: {
      create: jest.fn(({ data }) => {
        const record = {
          id: `exec_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
          ...data,
          state: data.state || AlgoBotExecutionState.RESERVED,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        mockExecutions.push(record);
        return record;
      }),
      findUnique: jest.fn(({ where }) => {
        if (where.id) return mockExecutions.find((e) => e.id === where.id) || null;
        if (where.fingerprint) return mockExecutions.find((e) => e.fingerprint === where.fingerprint) || null;
        return null;
      }),
      findMany: jest.fn(({ where }) => {
        let list = [...mockExecutions];
        if (where?.botId) list = list.filter((e) => e.botId === where.botId);
        if (where?.failureReasonCode) list = list.filter((e) => e.failureReasonCode === where.failureReasonCode);
        return list;
      }),
      update: jest.fn(({ where, data }) => {
        const item = mockExecutions.find((e) => e.id === where.id);
        if (!item) throw new NotFoundException(`Execution '${where.id}' not found`);
        Object.assign(item, data, { updatedAt: new Date() });
        return item;
      }),
    },
  };

  beforeEach(async () => {
    mockExecutions = [];
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ExecutionService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    executionService = module.get<ExecutionService>(ExecutionService);
  });

  describe('Execution Creation', () => {
    it('creates an execution in RESERVED state with complete metadata', async () => {
      const exec = await executionService.createExecution({
        fingerprint: 'fp_exec_test_1',
        botId: 'bot_alpha',
        symbol: 'BTCUSDT',
        timeframe: '15m',
        direction: Direction.BULLISH,
        signalTimestamp: new Date(),
        correlationId: 'corr_1',
      });

      expect(exec.id).toMatch(/^exec_/);
      expect(exec.state).toBe(AlgoBotExecutionState.RESERVED);
      expect(exec.symbol).toBe('BTCUSDT');
      expect(exec.direction).toBe(Direction.BULLISH);
    });
  });

  describe('Lifecycle State Machine Transitions', () => {
    it('transitions RESERVED -> EXECUTING -> EXECUTED (happy path)', async () => {
      const exec = await executionService.createExecution({
        fingerprint: 'fp_happy_path',
        botId: 'bot_alpha',
        symbol: 'NIFTY_SPOT',
        timeframe: '5m',
        direction: Direction.BULLISH,
        signalTimestamp: new Date(),
        correlationId: 'corr_2',
      });

      // 1. Mark Started
      const started = await executionService.markStarted(exec.id);
      expect(started?.state).toBe(AlgoBotExecutionState.EXECUTING);
      expect(started?.startedAt).toBeDefined();

      // 2. Mark Executed
      const executed = await executionService.markExecuted(exec.id, 'pos_12345');
      expect(executed?.state).toBe(AlgoBotExecutionState.EXECUTED);
      expect(executed?.orderPositionId).toBe('pos_12345');
      expect(executed?.completedAt).toBeDefined();
    });

    it('is idempotent on repeated markStarted and markExecuted', async () => {
      const exec = await executionService.createExecution({
        fingerprint: 'fp_idempotent',
        botId: 'bot_alpha',
        symbol: 'BTCUSDT',
        timeframe: '1h',
        direction: Direction.BEARISH,
        signalTimestamp: new Date(),
        correlationId: 'corr_3',
      });

      await executionService.markStarted(exec.id);
      const secondStarted = await executionService.markStarted(exec.id);
      expect(secondStarted?.state).toBe(AlgoBotExecutionState.EXECUTING);

      await executionService.markExecuted(exec.id, 'pos_999');
      const secondExecuted = await executionService.markExecuted(exec.id, 'pos_999');
      expect(secondExecuted?.state).toBe(AlgoBotExecutionState.EXECUTED);
    });

    it('transitions to CANCELLED from RESERVED or EXECUTING', async () => {
      const exec1 = await executionService.createExecution({
        fingerprint: 'fp_cancel_1',
        botId: 'bot_alpha',
        symbol: 'BANKNIFTY',
        timeframe: '15m',
        direction: Direction.BULLISH,
        signalTimestamp: new Date(),
        correlationId: 'corr_c1',
      });

      const cancelled1 = await executionService.markCancelled(exec1.id, 'RISK_GATE_ABORT');
      expect(cancelled1?.state).toBe(AlgoBotExecutionState.CANCELLED);
      expect(cancelled1?.failureReason).toBe('RISK_GATE_ABORT');

      const exec2 = await executionService.createExecution({
        fingerprint: 'fp_cancel_2',
        botId: 'bot_alpha',
        symbol: 'BANKNIFTY',
        timeframe: '15m',
        direction: Direction.BULLISH,
        signalTimestamp: new Date(),
        correlationId: 'corr_c2',
      });
      await executionService.markStarted(exec2.id);
      const cancelled2 = await executionService.markCancelled(exec2.id, 'USER_ABORT');
      expect(cancelled2?.state).toBe(AlgoBotExecutionState.CANCELLED);
    });

    it('rejects illegal transitions with ConflictException', async () => {
      const exec = await executionService.createExecution({
        fingerprint: 'fp_illegal',
        botId: 'bot_alpha',
        symbol: 'ETHUSDT',
        timeframe: '15m',
        direction: Direction.BULLISH,
        signalTimestamp: new Date(),
        correlationId: 'corr_ill',
      });

      await executionService.markStarted(exec.id);
      await executionService.markExecuted(exec.id, 'pos_done');

      // Illegal: EXECUTED cannot transition back to EXECUTING
      await expect(executionService.markStarted(exec.id)).rejects.toThrow(ConflictException);

      // Illegal: EXECUTED cannot transition to CANCELLED
      await expect(executionService.markCancelled(exec.id)).rejects.toThrow(ConflictException);
    });

    it('handles retryable and final failures with proper transition gates', async () => {
      const exec = await executionService.createExecution({
        fingerprint: 'fp_fail',
        botId: 'bot_alpha',
        symbol: 'SOLUSDT',
        timeframe: '1h',
        direction: Direction.BULLISH,
        signalTimestamp: new Date(),
        correlationId: 'corr_fail',
      });

      await executionService.markStarted(exec.id);

      // Transient failure
      const retryable = await executionService.markFailed(
        exec.id,
        'TIMEOUT_TRANSIENT',
        'Gateway timeout on submission',
        true,
      );
      expect(retryable?.state).toBe(AlgoBotExecutionState.FAILED_RETRYABLE);

      // Retry: FAILED_RETRYABLE -> EXECUTING
      const retried = await executionService.markStarted(exec.id);
      expect(retried?.state).toBe(AlgoBotExecutionState.EXECUTING);

      // Definitive failure
      const finalFailed = await executionService.markFailed(
        exec.id,
        'INSUFFICIENT_MARGIN_BROKER',
        'Broker margin rejected order',
        false,
      );
      expect(finalFailed?.state).toBe(AlgoBotExecutionState.FAILED_FINAL);
    });
  });

  describe('Reconciliation Protocol', () => {
    it('flags RECONCILIATION_REQUIRED on broker disconnect without blind retry', async () => {
      const exec = await executionService.createExecution({
        fingerprint: 'fp_recon',
        botId: 'bot_alpha',
        symbol: 'BTCUSDT',
        timeframe: '15m',
        direction: Direction.BULLISH,
        signalTimestamp: new Date(),
        correlationId: 'corr_recon',
      });

      await executionService.markStarted(exec.id);
      await executionService.markReconciliationRequired(exec.id, 'Broker socket dropped after submission');

      const pending = await executionService.getPendingReconciliations();
      expect(pending.length).toBe(1);
      expect(pending[0].failureReasonCode).toBe('RECONCILIATION_REQUIRED');
      expect(pending[0].failureReason).toContain('Broker socket dropped after submission');
    });

    it('authoritatively resolves reconciliation to EXECUTED or FAILED_FINAL', async () => {
      const exec = await executionService.createExecution({
        fingerprint: 'fp_recon_resolve',
        botId: 'bot_alpha',
        symbol: 'BTCUSDT',
        timeframe: '15m',
        direction: Direction.BULLISH,
        signalTimestamp: new Date(),
        correlationId: 'corr_rr',
      });

      await executionService.markStarted(exec.id);
      await executionService.markReconciliationRequired(exec.id, 'Broker timeout');

      // Resolve as EXECUTED following exchange trade log discovery
      const resolved = await executionService.resolveReconciliation(
        exec.id,
        'EXECUTED',
        'Order fill found in broker historical logs',
        'pos_recovered_99',
      );

      expect(resolved.state).toBe(AlgoBotExecutionState.EXECUTED);
      expect(resolved.orderPositionId).toBe('pos_recovered_99');
      expect(resolved.failureReasonCode).toBe('RECONCILIATION_RESOLVED');

      // No longer in pending reconciliations
      const pending = await executionService.getPendingReconciliations();
      expect(pending.length).toBe(0);
    });

    it('rejects resolveReconciliation if execution is not in RECONCILIATION_REQUIRED status', async () => {
      const exec = await executionService.createExecution({
        fingerprint: 'fp_not_recon',
        botId: 'bot_alpha',
        symbol: 'BTCUSDT',
        timeframe: '15m',
        direction: Direction.BULLISH,
        signalTimestamp: new Date(),
        correlationId: 'corr_nr',
      });

      await expect(
        executionService.resolveReconciliation(exec.id, 'EXECUTED', 'Invalid resolution'),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('Query APIs & Transition Evaluation', () => {
    it('looks up executions by fingerprint and by botId', async () => {
      await executionService.createExecution({
        fingerprint: 'fp_q1',
        botId: 'bot_query_test',
        symbol: 'BTCUSDT',
        timeframe: '15m',
        direction: Direction.BULLISH,
        signalTimestamp: new Date(),
        correlationId: 'c1',
      });

      const byFp = await executionService.getExecutionByFingerprint('fp_q1');
      expect(byFp?.fingerprint).toBe('fp_q1');

      const byBot = await executionService.getExecutionsByBotId('bot_query_test');
      expect(byBot.length).toBe(1);
    });

    it('validates transition paths with canTransition', () => {
      expect(executionService.canTransition('RESERVED', 'EXECUTING')).toBe(true);
      expect(executionService.canTransition('EXECUTING', 'EXECUTED')).toBe(true);
      expect(executionService.canTransition('EXECUTING', 'CANCELLED')).toBe(true);
      expect(executionService.canTransition('EXECUTED', 'EXECUTING')).toBe(false);
      expect(executionService.canTransition('CANCELLED', 'EXECUTED')).toBe(false);
      expect(executionService.canTransition('EXECUTED', 'EXECUTED')).toBe(true); // idempotent
    });
  });
});
