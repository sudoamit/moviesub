import { BadRequestException } from '@nestjs/common';
import { CircuitBreakerService } from '../circuit-breaker.service';
import { RiskService } from '../risk.service';
import { PrismaService } from '../../common/prisma/prisma.service';

describe('Phase 23 — Kill Switches & Circuit Breakers Engine', () => {
  let service: CircuitBreakerService;
  let mockPrisma: any;

  beforeEach(() => {
    mockPrisma = {
      tradingSystemConfig: {
        findUnique: jest.fn().mockResolvedValue({ id: 'SYSTEM_DEFAULT', emergencyStop: false }),
        upsert: jest.fn().mockResolvedValue({ id: 'SYSTEM_DEFAULT', emergencyStop: true }),
      },
      auditEvent: {
        create: jest.fn().mockResolvedValue({ id: 'audit_123' }),
      },
      paperAccount: {
        findUnique: jest.fn(),
      },
      paperPosition: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      paperOrder: {
        findMany: jest.fn().mockResolvedValue([]),
      },
    };

    service = new CircuitBreakerService(mockPrisma as unknown as PrismaService);
  });

  describe('1. Global Kill Switch', () => {
    it('should trip GLOBAL into HALTED mode and reject both ENTRY and normal EXIT', async () => {
      const record = await service.tripCircuitBreaker({
        scope: 'GLOBAL',
        mode: 'HALTED',
        reason: 'Market-wide black swan event',
        trippedBy: 'RISK_OFFICER',
      });

      expect(record.scope).toBe('GLOBAL');
      expect(record.mode).toBe('HALTED');

      // Check evaluateExecutionAllowed for ENTRY
      const entryEval = await service.evaluateExecutionAllowed({
        action: 'ENTRY',
        accountId: 'acc_1',
        symbol: 'BTCUSDT',
      });
      expect(entryEval.allowed).toBe(false);
      expect(entryEval.mode).toBe('HALTED');
      expect(entryEval.reasonCode).toBe('CIRCUIT_BREAKER_HALTED');

      // Check evaluateExecutionAllowed for normal EXIT
      const exitEval = await service.evaluateExecutionAllowed({
        action: 'EXIT',
        accountId: 'acc_1',
        symbol: 'BTCUSDT',
      });
      expect(exitEval.allowed).toBe(false);
      expect(exitEval.mode).toBe('HALTED');

      // assertExecutionAllowed should throw BadRequestException
      await expect(
        service.assertExecutionAllowed({
          action: 'ENTRY',
          accountId: 'acc_1',
          symbol: 'BTCUSDT',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should permit emergency EXIT under HALTED when isEmergencyExit is true', async () => {
      await service.tripCircuitBreaker({
        scope: 'GLOBAL',
        mode: 'HALTED',
        reason: 'Broker emergency outage',
      });

      const emergencyExitEval = await service.evaluateExecutionAllowed({
        action: 'EXIT',
        accountId: 'acc_1',
        symbol: 'BTCUSDT',
        isEmergencyExit: true,
      });

      expect(emergencyExitEval.allowed).toBe(true);
      expect(emergencyExitEval.mode).toBe('HALTED');
      expect(emergencyExitEval.message).toContain('Emergency exit permitted');
    });

    it('should reset GLOBAL back to NORMAL', async () => {
      await service.tripCircuitBreaker({
        scope: 'GLOBAL',
        mode: 'HALTED',
        reason: 'Temporary glitch',
      });

      const reset = await service.resetCircuitBreaker('GLOBAL', 'GLOBAL', 'ADMIN');
      expect(reset.mode).toBe('NORMAL');

      const check = await service.evaluateExecutionAllowed({
        action: 'ENTRY',
        accountId: 'acc_1',
        symbol: 'BTCUSDT',
      });
      expect(check.allowed).toBe(true);
      expect(check.mode).toBe('NORMAL');
    });
  });

  describe('2. Account, Bot, and Instrument Scoped Kill Switches', () => {
    it('should halt a specific account while keeping other accounts unaffected', async () => {
      await service.tripCircuitBreaker({
        scope: 'ACCOUNT',
        targetId: 'acc_alpha',
        mode: 'HALTED',
        reason: 'Margin deficit investigation',
      });

      const evalAlpha = await service.evaluateExecutionAllowed({
        action: 'ENTRY',
        accountId: 'acc_alpha',
        symbol: 'NIFTY',
      });
      expect(evalAlpha.allowed).toBe(false);
      expect(evalAlpha.effectiveScope).toBe('ACCOUNT');
      expect(evalAlpha.effectiveTargetId).toBe('ACC_ALPHA');

      const evalBeta = await service.evaluateExecutionAllowed({
        action: 'ENTRY',
        accountId: 'acc_beta',
        symbol: 'NIFTY',
      });
      expect(evalBeta.allowed).toBe(true);
      expect(evalBeta.mode).toBe('NORMAL');
    });

    it('should halt a specific bot while keeping other bots unaffected', async () => {
      await service.tripCircuitBreaker({
        scope: 'BOT',
        targetId: 'bot_fvg_scalp',
        mode: 'HALTED',
        reason: 'Strategy logic runaway detection',
      });

      const evalTrippedBot = await service.evaluateExecutionAllowed({
        action: 'ENTRY',
        botId: 'bot_fvg_scalp',
        symbol: 'NIFTY',
      });
      expect(evalTrippedBot.allowed).toBe(false);
      expect(evalTrippedBot.effectiveScope).toBe('BOT');

      const evalOtherBot = await service.evaluateExecutionAllowed({
        action: 'ENTRY',
        botId: 'bot_orb_breakout',
        symbol: 'NIFTY',
      });
      expect(evalOtherBot.allowed).toBe(true);
    });

    it('should halt a specific symbol while keeping other symbols unaffected', async () => {
      await service.tripCircuitBreaker({
        scope: 'INSTRUMENT',
        targetId: 'BANKNIFTY',
        mode: 'HALTED',
        reason: 'Exchange price band circuit trigger',
      });

      const evalBankNifty = await service.evaluateExecutionAllowed({
        action: 'ENTRY',
        symbol: 'BANKNIFTY',
      });
      expect(evalBankNifty.allowed).toBe(false);
      expect(evalBankNifty.effectiveScope).toBe('INSTRUMENT');

      const evalNifty = await service.evaluateExecutionAllowed({
        action: 'ENTRY',
        symbol: 'NIFTY',
      });
      expect(evalNifty.allowed).toBe(true);
    });
  });

  describe('3. CLOSE_ONLY Mode Invariant: Blocks ENTRY, Permits EXIT', () => {
    it('should strictly block new ENTRY orders but permit EXIT liquidations in CLOSE_ONLY mode', async () => {
      await service.tripCircuitBreaker({
        scope: 'INSTRUMENT',
        targetId: 'FINNIFTY',
        mode: 'CLOSE_ONLY',
        reason: 'Upcoming expiry risk reduction',
      });

      // 1. ENTRY is rejected
      const entryEval = await service.evaluateExecutionAllowed({
        action: 'ENTRY',
        symbol: 'FINNIFTY',
      });
      expect(entryEval.allowed).toBe(false);
      expect(entryEval.mode).toBe('CLOSE_ONLY');
      expect(entryEval.reasonCode).toBe('CIRCUIT_BREAKER_CLOSE_ONLY');
      expect(entryEval.message).toContain('New position entries prohibited');

      await expect(
        service.assertExecutionAllowed({
          action: 'ENTRY',
          symbol: 'FINNIFTY',
        }),
      ).rejects.toThrow(BadRequestException);

      // 2. EXIT is permitted
      const exitEval = await service.evaluateExecutionAllowed({
        action: 'EXIT',
        symbol: 'FINNIFTY',
      });
      expect(exitEval.allowed).toBe(true);
      expect(exitEval.mode).toBe('CLOSE_ONLY');
      expect(exitEval.message).toContain('Position exit permitted under CLOSE_ONLY mode');

      // assertExecutionAllowed for EXIT does not throw
      await expect(
        service.assertExecutionAllowed({
          action: 'EXIT',
          symbol: 'FINNIFTY',
        }),
      ).resolves.toBeUndefined();
    });
  });

  describe('4. Hierarchical Restrictiveness Invariant', () => {
    it('should enforce GLOBAL HALT over individual ACCOUNT NORMAL or CLOSE_ONLY', async () => {
      // Account is set to CLOSE_ONLY
      await service.tripCircuitBreaker({
        scope: 'ACCOUNT',
        targetId: 'acc_omega',
        mode: 'CLOSE_ONLY',
        reason: 'Account daily risk limit reached',
      });

      // Global is set to HALTED
      await service.tripCircuitBreaker({
        scope: 'GLOBAL',
        mode: 'HALTED',
        reason: 'System maintenance',
      });

      // Both ENTRY and regular EXIT are blocked by GLOBAL HALT
      const entryEval = await service.evaluateExecutionAllowed({
        action: 'ENTRY',
        accountId: 'acc_omega',
      });
      expect(entryEval.allowed).toBe(false);
      expect(entryEval.mode).toBe('HALTED');
      expect(entryEval.effectiveScope).toBe('GLOBAL');

      const exitEval = await service.evaluateExecutionAllowed({
        action: 'EXIT',
        accountId: 'acc_omega',
      });
      expect(exitEval.allowed).toBe(false);
      expect(exitEval.mode).toBe('HALTED');
      expect(exitEval.effectiveScope).toBe('GLOBAL');
    });

    it('should enforce ACCOUNT CLOSE_ONLY over BOT NORMAL', async () => {
      await service.tripCircuitBreaker({
        scope: 'ACCOUNT',
        targetId: 'acc_sub',
        mode: 'CLOSE_ONLY',
        reason: 'Target profit secured for the day',
      });

      const evalResult = await service.evaluateExecutionAllowed({
        action: 'ENTRY',
        accountId: 'acc_sub',
        botId: 'bot_arbitrage',
      });

      expect(evalResult.allowed).toBe(false);
      expect(evalResult.mode).toBe('CLOSE_ONLY');
      expect(evalResult.effectiveScope).toBe('ACCOUNT');
    });
  });

  describe('5. Automated Consecutive Failure Tripping', () => {
    it('should automatically trip into CLOSE_ONLY upon reaching 3 consecutive failures', async () => {
      const scope = 'INSTRUMENT';
      const targetId = 'RELIANCE';

      // 1st failure
      const f1 = await service.recordFailure(scope, targetId, 'HTTP 504 Gateway Timeout', 3);
      expect(f1.tripped).toBe(false);

      // 2nd failure
      const f2 = await service.recordFailure(scope, targetId, 'Broker order socket dropped', 3);
      expect(f2.tripped).toBe(false);

      // Status before 3rd failure
      const statusBefore = await service.getBreakerStatus(scope, targetId);
      expect(statusBefore.mode).toBe('NORMAL');
      expect(statusBefore.consecutiveFailures).toBe(2);

      // 3rd failure: trips!
      const f3 = await service.recordFailure(scope, targetId, 'Broker rejected order', 3);
      expect(f3.tripped).toBe(true);
      expect(f3.record?.mode).toBe('CLOSE_ONLY');
      expect(f3.record?.reason).toContain('3 consecutive execution failures exceeded threshold');

      // Now ENTRY is blocked
      const entryEval = await service.evaluateExecutionAllowed({
        action: 'ENTRY',
        symbol: 'RELIANCE',
      });
      expect(entryEval.allowed).toBe(false);
      expect(entryEval.mode).toBe('CLOSE_ONLY');
    });

    it('should escalate to HALTED if failures continue while in CLOSE_ONLY mode', async () => {
      const scope = 'BOT';
      const targetId = 'bot_flaky';

      // Trip to CLOSE_ONLY
      await service.tripCircuitBreaker({
        scope,
        targetId,
        mode: 'CLOSE_ONLY',
        reason: 'Initial warning trip',
      });

      // Record failures up to threshold
      await service.recordFailure(scope, targetId, 'Error 1', 2);
      const res = await service.recordFailure(scope, targetId, 'Error 2', 2);

      expect(res.tripped).toBe(true);
      expect(res.record?.mode).toBe('HALTED');
    });

    it('should reset consecutive failure counters upon successful execution', async () => {
      const scope = 'INSTRUMENT';
      const targetId = 'INFY';

      await service.recordFailure(scope, targetId, 'Transient error 1', 3);
      await service.recordFailure(scope, targetId, 'Transient error 2', 3);

      // Record success
      await service.recordSuccess(scope, targetId);

      const status = await service.getBreakerStatus(scope, targetId);
      expect(status.consecutiveFailures).toBe(0);

      // Next failure should be #1, not tripping
      const fAfter = await service.recordFailure(scope, targetId, 'Transient error 3', 3);
      expect(fAfter.tripped).toBe(false);
    });
  });

  describe('6. Cooldown Auto-Reset & Active Breakers Listing', () => {
    it('should auto-reset to NORMAL when cooldown period expires', async () => {
      await service.tripCircuitBreaker({
        scope: 'INSTRUMENT',
        targetId: 'TCS',
        mode: 'HALTED',
        reason: 'Micro-cooldown test',
        cooldownSeconds: 0.05, // 50ms
      });

      const initialStatus = await service.getBreakerStatus('INSTRUMENT', 'TCS');
      expect(initialStatus.mode).toBe('HALTED');

      // Wait for cooldown to expire
      await new Promise((resolve) => setTimeout(resolve, 70));

      const expiredStatus = await service.getBreakerStatus('INSTRUMENT', 'TCS');
      expect(expiredStatus.mode).toBe('NORMAL');
      expect(expiredStatus.reason).toContain('Auto-reset: Cooldown expired');
    });

    it('should list all active non-NORMAL breakers', async () => {
      await service.tripCircuitBreaker({
        scope: 'GLOBAL',
        mode: 'CLOSE_ONLY',
        reason: 'Global close only test',
      });
      await service.tripCircuitBreaker({
        scope: 'INSTRUMENT',
        targetId: 'SBIN',
        mode: 'HALTED',
        reason: 'SBIN halted test',
      });

      const active = await service.getActiveBreakers();
      expect(active.length).toBeGreaterThanOrEqual(2);

      const scopes = active.map((a) => `${a.scope}:${a.targetId}`);
      expect(scopes).toContain('GLOBAL:GLOBAL');
      expect(scopes).toContain('INSTRUMENT:SBIN');
    });
  });

  describe('7. Integration with RiskService', () => {
    it('should reject pre-trade risk evaluation when circuit breaker is tripped', async () => {
      const riskService = new RiskService(
        mockPrisma as unknown as PrismaService,
        service,
      );

      mockPrisma.paperAccount.findUnique.mockResolvedValue({
        id: 'acc_risk_test',
        balance: 100000,
        initialCapital: 100000,
        equity: 100000,
      });

      // Trip instrument kill switch
      await service.tripCircuitBreaker({
        scope: 'INSTRUMENT',
        targetId: 'NIFTY',
        mode: 'CLOSE_ONLY',
        reason: 'High volatility close only trigger',
      });

      const riskResult = await riskService.evaluateOrderRisk({
        accountId: 'acc_risk_test',
        symbol: 'NIFTY',
        instrumentType: 'INDEX',
        orderSide: 'BUY',
        quantity: 50,
        entryPrice: 24000,
        stopLoss: 23900,
        requiredMargin: 120000,
        riskAmountAccount: 5000,
      });

      expect(riskResult.allowed).toBe(false);
      expect(riskResult.reasonCode).toBe('CIRCUIT_BREAKER_CLOSE_ONLY');
      expect(riskResult.message).toContain('New position entries prohibited');
    });
  });
});
