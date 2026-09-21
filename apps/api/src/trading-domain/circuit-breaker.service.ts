import { Injectable, Logger, BadRequestException, OnModuleInit, Optional } from '@nestjs/common';
import {
  BreakerEvaluationResult,
  CircuitBreakerAction,
  CircuitBreakerMode,
  CircuitBreakerRecord,
  CircuitBreakerScope,
  EvaluateExecutionParams,
  ICircuitBreakerDomainService,
  TripBreakerParams,
} from '@quant/shared';
import { PrismaService } from '../common/prisma/prisma.service';
import * as crypto from 'crypto';

@Injectable()
export class CircuitBreakerService implements ICircuitBreakerDomainService, OnModuleInit {
  private readonly logger = new Logger(CircuitBreakerService.name);

  // In-memory fast store keyed by `${scope}:${targetId}`
  private readonly breakers = new Map<string, CircuitBreakerRecord>();

  // Consecutive failure tracker keyed by `${scope}:${targetId}`
  private readonly failureCounters = new Map<string, { count: number; lastFailureAt: Date }>();

  constructor(@Optional() private readonly prisma?: PrismaService) {}

  async onModuleInit(): Promise<void> {
    await this.syncWithSystemConfig();
  }

  /**
   * Generates canonical key for the breaker map
   */
  private getBreakerKey(scope: CircuitBreakerScope, targetId?: string): string {
    const target = scope === 'GLOBAL' ? 'GLOBAL' : (targetId || 'DEFAULT');
    return `${scope}:${target.toUpperCase()}`;
  }

  /**
   * Checks whether an existing breaker has expired past its cooldown period.
   * If expired, resets it to NORMAL.
   */
  private checkCooldownExpiration(record: CircuitBreakerRecord): CircuitBreakerRecord {
    if (record.mode !== 'NORMAL' && record.expiresAt) {
      if (new Date() >= record.expiresAt) {
        this.logger.log(
          `⏱️ [CIRCUIT BREAKER COOLDOWN EXPIRED] ${record.scope}:${record.targetId} auto-resetting to NORMAL`,
        );
        const resetRecord: CircuitBreakerRecord = {
          ...record,
          mode: 'NORMAL',
          reason: `Auto-reset: Cooldown expired (${record.cooldownSeconds}s)`,
          trippedAt: new Date(),
          trippedBy: 'SYSTEM_COOLDOWN',
          expiresAt: undefined,
          cooldownSeconds: undefined,
        };
        const key = this.getBreakerKey(record.scope, record.targetId);
        this.breakers.set(key, resetRecord);
        return resetRecord;
      }
    }
    return record;
  }

  /**
   * Trips a circuit breaker into CLOSE_ONLY or HALTED mode.
   */
  async tripCircuitBreaker(params: TripBreakerParams): Promise<CircuitBreakerRecord> {
    const targetId = params.scope === 'GLOBAL' ? 'GLOBAL' : (params.targetId || 'DEFAULT');
    const key = this.getBreakerKey(params.scope, targetId);
    const now = new Date();

    const expiresAt = params.cooldownSeconds
      ? new Date(now.getTime() + params.cooldownSeconds * 1000)
      : undefined;

    const record: CircuitBreakerRecord = {
      id: `cb_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
      scope: params.scope,
      targetId: targetId.toUpperCase(),
      mode: params.mode,
      reason: params.reason,
      trippedAt: now,
      trippedBy: params.trippedBy || 'SYSTEM',
      expiresAt,
      cooldownSeconds: params.cooldownSeconds,
      metadata: params.metadata,
      consecutiveFailures: this.failureCounters.get(key)?.count || 0,
      lastFailureAt: this.failureCounters.get(key)?.lastFailureAt,
    };

    this.breakers.set(key, record);

    this.logger.warn(
      `🚨 [CIRCUIT BREAKER TRIPPED] Scope: ${record.scope}, Target: ${record.targetId}, Mode: ${record.mode}, Reason: ${record.reason}`,
    );

    // If GLOBAL breaker is tripped to HALTED, synchronize with Prisma TradingSystemConfig
    if (params.scope === 'GLOBAL' && this.prisma) {
      try {
        await this.prisma.tradingSystemConfig.upsert({
          where: { id: 'SYSTEM_DEFAULT' },
          update: { emergencyStop: params.mode === 'HALTED' },
          create: { id: 'SYSTEM_DEFAULT', emergencyStop: params.mode === 'HALTED' },
        });
      } catch (err: any) {
        this.logger.error(`Failed to update Prisma TradingSystemConfig on trip: ${err.message}`);
      }
    }

    // Persist Audit Event
    if (this.prisma) {
      try {
        await this.prisma.auditEvent.create({
          data: {
            actor: record.trippedBy,
            service: 'TRADING_ENGINE',
            eventType: record.mode === 'HALTED' ? 'EMERGENCY_STOP' : 'RISK_REJECTED',
            entityType: 'CONFIG',
            entityId: `${record.scope}:${record.targetId}`,
            payloadJson: {
              scope: record.scope,
              targetId: record.targetId,
              mode: record.mode,
              reason: record.reason,
              cooldownSeconds: record.cooldownSeconds,
              metadata: record.metadata,
            },
            correlationId: `corr_cb_${Date.now()}`,
          },
        });
      } catch (err: any) {
        this.logger.debug(`Could not write auditEvent for circuit breaker trip: ${err.message}`);
      }
    }

    return record;
  }

  /**
   * Resets a circuit breaker back to NORMAL.
   */
  async resetCircuitBreaker(
    scope: CircuitBreakerScope,
    targetId?: string,
    actor = 'ADMIN',
    reason = 'Manual reset / re-arm',
  ): Promise<CircuitBreakerRecord> {
    const target = scope === 'GLOBAL' ? 'GLOBAL' : (targetId || 'DEFAULT');
    const key = this.getBreakerKey(scope, target);
    const now = new Date();

    // Reset failure count
    this.failureCounters.delete(key);

    const record: CircuitBreakerRecord = {
      id: `cb_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
      scope,
      targetId: target.toUpperCase(),
      mode: 'NORMAL',
      reason,
      trippedAt: now,
      trippedBy: actor,
      consecutiveFailures: 0,
    };

    this.breakers.set(key, record);

    this.logger.log(
      `✅ [CIRCUIT BREAKER RESET] Scope: ${scope}, Target: ${record.targetId}, Reset by: ${actor}`,
    );

    // If GLOBAL breaker reset, synchronize with Prisma TradingSystemConfig
    if (scope === 'GLOBAL' && this.prisma) {
      try {
        await this.prisma.tradingSystemConfig.upsert({
          where: { id: 'SYSTEM_DEFAULT' },
          update: { emergencyStop: false },
          create: { id: 'SYSTEM_DEFAULT', emergencyStop: false },
        });
      } catch (err: any) {
        this.logger.error(`Failed to update Prisma TradingSystemConfig on reset: ${err.message}`);
      }
    }

    // Persist Audit Event
    if (this.prisma) {
      try {
        await this.prisma.auditEvent.create({
          data: {
            actor,
            service: 'TRADING_ENGINE',
            eventType: 'TRADING_ENABLED',
            entityType: 'CONFIG',
            entityId: `${scope}:${record.targetId}`,
            payloadJson: { scope, targetId: record.targetId, reason },
            correlationId: `corr_cb_${Date.now()}`,
          },
        });
      } catch (err: any) {
        this.logger.debug(`Could not write auditEvent for circuit breaker reset: ${err.message}`);
      }
    }

    return record;
  }

  /**
   * Retrieves breaker status for a specific scope & target.
   */
  async getBreakerStatus(
    scope: CircuitBreakerScope,
    targetId?: string,
  ): Promise<CircuitBreakerRecord> {
    const target = scope === 'GLOBAL' ? 'GLOBAL' : (targetId || 'DEFAULT');
    const key = this.getBreakerKey(scope, target);
    const record = this.breakers.get(key);

    if (!record) {
      return {
        id: `default_${scope}_${target}`,
        scope,
        targetId: target.toUpperCase(),
        mode: 'NORMAL',
        reason: 'Normal operational state',
        trippedAt: new Date(0),
        trippedBy: 'SYSTEM_DEFAULT',
        consecutiveFailures: this.failureCounters.get(key)?.count || 0,
      };
    }

    return this.checkCooldownExpiration(record);
  }

  /**
   * Retrieves all currently active (non-NORMAL) breakers.
   */
  async getActiveBreakers(): Promise<CircuitBreakerRecord[]> {
    const active: CircuitBreakerRecord[] = [];
    for (const record of this.breakers.values()) {
      const refreshed = this.checkCooldownExpiration(record);
      if (refreshed.mode !== 'NORMAL') {
        active.push(refreshed);
      }
    }
    return active;
  }

  /**
   * Evaluates if order execution is permitted under active circuit breakers.
   * Enforces hierarchical restrictiveness:
   * GLOBAL -> ACCOUNT -> BOT -> INSTRUMENT -> STRATEGY
   * If any scope is HALTED: blocks all non-emergency executions.
   * If any scope is CLOSE_ONLY: blocks ENTRY, permits EXIT.
   */
  async evaluateExecutionAllowed(
    params: EvaluateExecutionParams,
  ): Promise<BreakerEvaluationResult> {
    const { action, accountId, botId, symbol, strategyId, isEmergencyExit } = params;

    // Check scopes in hierarchical order
    const checks: { scope: CircuitBreakerScope; targetId?: string }[] = [
      { scope: 'GLOBAL', targetId: 'GLOBAL' },
    ];
    if (accountId) checks.push({ scope: 'ACCOUNT', targetId: accountId });
    if (botId) checks.push({ scope: 'BOT', targetId: botId });
    if (symbol) checks.push({ scope: 'INSTRUMENT', targetId: symbol });
    if (strategyId) checks.push({ scope: 'STRATEGY', targetId: strategyId });

    let haltedBreaker: CircuitBreakerRecord | null = null;
    let closeOnlyBreaker: CircuitBreakerRecord | null = null;

    for (const { scope, targetId } of checks) {
      const status = await this.getBreakerStatus(scope, targetId);
      if (status.mode === 'HALTED' && !haltedBreaker) {
        haltedBreaker = status;
      } else if (status.mode === 'CLOSE_ONLY' && !closeOnlyBreaker) {
        closeOnlyBreaker = status;
      }
    }

    // 1. If any level is HALTED
    if (haltedBreaker) {
      if (action === 'EXIT' && isEmergencyExit) {
        return {
          allowed: true,
          mode: 'HALTED',
          effectiveScope: haltedBreaker.scope,
          effectiveTargetId: haltedBreaker.targetId,
          message: `Emergency exit permitted under HALTED breaker (${haltedBreaker.scope}:${haltedBreaker.targetId})`,
        };
      }

      return {
        allowed: false,
        mode: 'HALTED',
        effectiveScope: haltedBreaker.scope,
        effectiveTargetId: haltedBreaker.targetId,
        reasonCode: 'CIRCUIT_BREAKER_HALTED',
        message: `Trading halted by ${haltedBreaker.scope} circuit breaker (${haltedBreaker.targetId}): ${haltedBreaker.reason}`,
      };
    }

    // 2. If any level is CLOSE_ONLY
    if (closeOnlyBreaker) {
      if (action === 'ENTRY') {
        return {
          allowed: false,
          mode: 'CLOSE_ONLY',
          effectiveScope: closeOnlyBreaker.scope,
          effectiveTargetId: closeOnlyBreaker.targetId,
          reasonCode: 'CIRCUIT_BREAKER_CLOSE_ONLY',
          message: `New position entries prohibited: ${closeOnlyBreaker.scope} circuit breaker (${closeOnlyBreaker.targetId}) is in CLOSE_ONLY mode: ${closeOnlyBreaker.reason}`,
        };
      }

      // action === 'EXIT' is permitted under CLOSE_ONLY
      return {
        allowed: true,
        mode: 'CLOSE_ONLY',
        effectiveScope: closeOnlyBreaker.scope,
        effectiveTargetId: closeOnlyBreaker.targetId,
        message: `Position exit permitted under CLOSE_ONLY mode (${closeOnlyBreaker.scope}:${closeOnlyBreaker.targetId})`,
      };
    }

    // 3. All clear
    return {
      allowed: true,
      mode: 'NORMAL',
      message: 'All circuit breakers clear',
    };
  }

  /**
   * Asserts execution is permitted; throws BadRequestException if blocked.
   */
  async assertExecutionAllowed(params: EvaluateExecutionParams): Promise<void> {
    const result = await this.evaluateExecutionAllowed(params);
    if (!result.allowed) {
      throw new BadRequestException(result.message);
    }
  }

  /**
   * Records execution failure. Automatically trips circuit breaker if failure threshold is reached.
   */
  async recordFailure(
    scope: CircuitBreakerScope,
    targetId: string,
    errorDetails?: string,
    failureThreshold = 3,
  ): Promise<{ tripped: boolean; record?: CircuitBreakerRecord }> {
    const key = this.getBreakerKey(scope, targetId);
    const existing = this.failureCounters.get(key) || { count: 0, lastFailureAt: new Date() };
    const newCount = existing.count + 1;
    const now = new Date();

    this.failureCounters.set(key, { count: newCount, lastFailureAt: now });

    this.logger.warn(
      `⚠️ [EXECUTION FAILURE RECORDED] ${scope}:${targetId.toUpperCase()} (Failure #${newCount}/${failureThreshold}): ${errorDetails || 'Unspecified failure'}`,
    );

    if (newCount >= failureThreshold) {
      // Check current mode; if already CLOSE_ONLY, escalate to HALTED; otherwise trip to CLOSE_ONLY
      const current = await this.getBreakerStatus(scope, targetId);
      const targetMode: 'CLOSE_ONLY' | 'HALTED' =
        current.mode === 'CLOSE_ONLY' ? 'HALTED' : 'CLOSE_ONLY';

      const record = await this.tripCircuitBreaker({
        scope,
        targetId,
        mode: targetMode,
        reason: `Automated trip: ${newCount} consecutive execution failures exceeded threshold (${failureThreshold}). Last error: ${errorDetails || 'Unknown'}`,
        trippedBy: 'AUTOMATED_FAILURE_MONITOR',
        cooldownSeconds: 300, // 5 min auto-cooldown
      });

      return { tripped: true, record };
    }

    return { tripped: false };
  }

  /**
   * Records execution success; resets consecutive failure counter.
   */
  async recordSuccess(scope: CircuitBreakerScope, targetId: string): Promise<void> {
    const key = this.getBreakerKey(scope, targetId);
    if (this.failureCounters.has(key)) {
      this.failureCounters.delete(key);
      this.logger.debug(`[FAILURE COUNTER RESET] ${scope}:${targetId.toUpperCase()} reset to 0`);
    }
  }

  /**
   * Synchronizes GLOBAL breaker with Prisma TradingSystemConfig.emergencyStop.
   */
  async syncWithSystemConfig(): Promise<void> {
    if (!this.prisma) return;

    try {
      const config = await this.prisma.tradingSystemConfig.findUnique({
        where: { id: 'SYSTEM_DEFAULT' },
      });

      if (config?.emergencyStop) {
        const globalStatus = await this.getBreakerStatus('GLOBAL');
        if (globalStatus.mode !== 'HALTED') {
          await this.tripCircuitBreaker({
            scope: 'GLOBAL',
            mode: 'HALTED',
            reason: 'Synchronized from TradingSystemConfig.emergencyStop',
            trippedBy: 'SYSTEM_CONFIG',
          });
        }
      }
    } catch (err: any) {
      this.logger.warn(`Could not sync circuit breaker with system config: ${err.message}`);
    }
  }
}
