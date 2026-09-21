import { Injectable, Logger, NotFoundException, ConflictException } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { AlgoBotExecutionState } from '@prisma/client';
import {
  IExecutionDomainService,
  ExecutionRecord,
  Direction,
} from '@quant/shared';

@Injectable()
export class ExecutionService implements IExecutionDomainService {
  private readonly logger = new Logger(ExecutionService.name);

  private static readonly ALLOWED_TRANSITIONS: Record<AlgoBotExecutionState, AlgoBotExecutionState[]> = {
    [AlgoBotExecutionState.RESERVED]: [
      AlgoBotExecutionState.EXECUTING,
      AlgoBotExecutionState.CANCELLED,
      AlgoBotExecutionState.FAILED_FINAL,
      AlgoBotExecutionState.FAILED_RETRYABLE,
    ],
    [AlgoBotExecutionState.EXECUTING]: [
      AlgoBotExecutionState.EXECUTED,
      AlgoBotExecutionState.CANCELLED,
      AlgoBotExecutionState.FAILED_FINAL,
      AlgoBotExecutionState.FAILED_RETRYABLE,
    ],
    [AlgoBotExecutionState.FAILED_RETRYABLE]: [
      AlgoBotExecutionState.EXECUTING,
      AlgoBotExecutionState.CANCELLED,
      AlgoBotExecutionState.FAILED_FINAL,
    ],
    [AlgoBotExecutionState.EXECUTED]: [],
    [AlgoBotExecutionState.CANCELLED]: [],
    [AlgoBotExecutionState.FAILED_FINAL]: [],
  };

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Evaluates if a transition between two execution states is allowed.
   */
  public canTransition(fromState: string, toState: string): boolean {
    if (fromState === toState) return true; // Idempotent self-transition
    const allowed = ExecutionService.ALLOWED_TRANSITIONS[fromState as AlgoBotExecutionState];
    return allowed ? allowed.includes(toState as AlgoBotExecutionState) : false;
  }

  private validateTransition(current: any, targetState: AlgoBotExecutionState): void {
    if (current.state === targetState) return; // Idempotent
    if (!this.canTransition(current.state, targetState)) {
      throw new ConflictException(
        `INVALID_EXECUTION_TRANSITION: Cannot transition execution '${current.id}' from '${current.state}' to '${targetState}'`,
      );
    }
  }

  public async createExecution(params: {
    fingerprint: string;
    botId: string;
    symbol: string;
    contractSymbol?: string;
    executionInstrument?: string;
    executionInstrumentType?: string;
    strike?: number;
    optionType?: string;
    expiry?: string;
    timeframe: string;
    direction: Direction;
    signalId?: string;
    signalTimestamp: Date;
    correlationId: string;
  }): Promise<ExecutionRecord> {
    const created = await this.prisma.algoBotExecution.create({
      data: {
        fingerprint: params.fingerprint,
        botId: params.botId,
        symbol: params.symbol,
        contractSymbol: params.contractSymbol,
        executionInstrument: params.executionInstrument,
        executionInstrumentType: params.executionInstrumentType,
        strike: params.strike,
        optionType: params.optionType,
        expiry: params.expiry,
        timeframe: params.timeframe,
        direction: params.direction,
        signalId: params.signalId,
        signalTimestamp: params.signalTimestamp,
        state: AlgoBotExecutionState.RESERVED,
        correlationId: params.correlationId,
      },
    });

    return this.mapToRecord(created);
  }

  public async markStarted(executionId: string): Promise<ExecutionRecord | void> {
    const existing = await this.prisma.algoBotExecution.findUnique({ where: { id: executionId } });
    if (!existing) {
      throw new NotFoundException(`Execution '${executionId}' not found`);
    }

    if (existing.state === AlgoBotExecutionState.EXECUTING) {
      return this.mapToRecord(existing); // Idempotent
    }

    this.validateTransition(existing, AlgoBotExecutionState.EXECUTING);

    const updated = await this.prisma.algoBotExecution.update({
      where: { id: executionId },
      data: {
        state: AlgoBotExecutionState.EXECUTING,
        startedAt: new Date(),
      },
    });

    this.logger.log(`[EXECUTION STARTED] id=${executionId}`);
    return this.mapToRecord(updated);
  }

  public async markExecuted(
    executionId: string,
    orderPositionId?: string,
  ): Promise<ExecutionRecord | void> {
    const existing = await this.prisma.algoBotExecution.findUnique({ where: { id: executionId } });
    if (!existing) {
      throw new NotFoundException(`Execution '${executionId}' not found`);
    }

    if (existing.state === AlgoBotExecutionState.EXECUTED) {
      return this.mapToRecord(existing); // Idempotent
    }

    this.validateTransition(existing, AlgoBotExecutionState.EXECUTED);

    const updated = await this.prisma.algoBotExecution.update({
      where: { id: executionId },
      data: {
        state: AlgoBotExecutionState.EXECUTED,
        completedAt: new Date(),
        orderPositionId: orderPositionId || undefined,
      },
    });

    this.logger.log(`[EXECUTION EXECUTED] id=${executionId} | positionId=${orderPositionId}`);
    return this.mapToRecord(updated);
  }

  public async markFailed(
    executionId: string,
    reasonCode: string,
    message: string,
    retryable: boolean,
  ): Promise<ExecutionRecord | void> {
    const existing = await this.prisma.algoBotExecution.findUnique({ where: { id: executionId } });
    if (!existing) {
      throw new NotFoundException(`Execution '${executionId}' not found`);
    }

    const newState = retryable
      ? AlgoBotExecutionState.FAILED_RETRYABLE
      : AlgoBotExecutionState.FAILED_FINAL;

    if (existing.state === newState) {
      return this.mapToRecord(existing); // Idempotent
    }

    this.validateTransition(existing, newState);

    const updated = await this.prisma.algoBotExecution.update({
      where: { id: executionId },
      data: {
        state: newState,
        failedAt: new Date(),
        failureReason: message,
        failureReasonCode: reasonCode,
      },
    });

    this.logger.warn(`[EXECUTION FAILED] id=${executionId} | state=${newState} | code=${reasonCode} | msg=${message}`);
    return this.mapToRecord(updated);
  }

  public async markCancelled(executionId: string, reason = 'CANCELLED'): Promise<ExecutionRecord | void> {
    const existing = await this.prisma.algoBotExecution.findUnique({ where: { id: executionId } });
    if (!existing) {
      throw new NotFoundException(`Execution '${executionId}' not found`);
    }

    if (existing.state === AlgoBotExecutionState.CANCELLED) {
      return this.mapToRecord(existing); // Idempotent
    }

    this.validateTransition(existing, AlgoBotExecutionState.CANCELLED);

    const updated = await this.prisma.algoBotExecution.update({
      where: { id: executionId },
      data: {
        state: AlgoBotExecutionState.CANCELLED,
        completedAt: new Date(),
        failureReason: reason,
        failureReasonCode: 'CANCELLED',
      },
    });

    this.logger.log(`[EXECUTION CANCELLED] id=${executionId} | reason=${reason}`);
    return this.mapToRecord(updated);
  }

  /**
   * CRITICAL INVARIANT: If an external order may have executed but the database cannot establish
   * the definitive result, flag RECONCILIATION_REQUIRED. Never retry an uncertain order blindly.
   */
  public async markReconciliationRequired(executionId: string, message: string): Promise<ExecutionRecord | void> {
    const updated = await this.prisma.algoBotExecution.update({
      where: { id: executionId },
      data: {
        state: AlgoBotExecutionState.FAILED_FINAL,
        failedAt: new Date(),
        failureReason: `[RECONCILIATION_REQUIRED] ${message}`,
        failureReasonCode: 'RECONCILIATION_REQUIRED',
      },
    });
    this.logger.error(`🚨 [RECONCILIATION REQUIRED] Execution '${executionId}' requires external broker reconciliation: ${message}`);
    return this.mapToRecord(updated);
  }

  /**
   * Authoritatively resolves an execution flagged as RECONCILIATION_REQUIRED following
   * broker sync / operational reconciliation.
   */
  public async resolveReconciliation(
    executionId: string,
    outcome: 'EXECUTED' | 'FAILED_FINAL',
    resolutionNotes: string,
    orderPositionId?: string,
  ): Promise<ExecutionRecord> {
    const existing = await this.prisma.algoBotExecution.findUnique({ where: { id: executionId } });
    if (!existing) {
      throw new NotFoundException(`Execution '${executionId}' not found`);
    }

    if (existing.failureReasonCode !== 'RECONCILIATION_REQUIRED') {
      throw new ConflictException(
        `CANNOT_RESOLVE_RECONCILIATION: Execution '${executionId}' is not flagged as RECONCILIATION_REQUIRED (current code='${existing.failureReasonCode}')`,
      );
    }

    const now = new Date();
    const updateData: any =
      outcome === 'EXECUTED'
        ? {
            state: AlgoBotExecutionState.EXECUTED,
            completedAt: now,
            orderPositionId: orderPositionId || undefined,
            failureReason: `[RESOLVED_EXECUTED] ${resolutionNotes}`,
            failureReasonCode: 'RECONCILIATION_RESOLVED',
          }
        : {
            state: AlgoBotExecutionState.FAILED_FINAL,
            failedAt: now,
            failureReason: `[RESOLVED_FAILED] ${resolutionNotes}`,
            failureReasonCode: 'RECONCILIATION_RESOLVED',
          };

    const updated = await this.prisma.algoBotExecution.update({
      where: { id: executionId },
      data: updateData,
    });

    this.logger.log(
      `[RECONCILIATION RESOLVED] id=${executionId} | outcome=${outcome} | notes=${resolutionNotes}`,
    );

    return this.mapToRecord(updated);
  }

  public async getExecutionById(executionId: string): Promise<ExecutionRecord | null> {
    const exec = await this.prisma.algoBotExecution.findUnique({ where: { id: executionId } });
    if (!exec) return null;
    return this.mapToRecord(exec);
  }

  public async getExecutionByFingerprint(fingerprint: string): Promise<ExecutionRecord | null> {
    const exec = await this.prisma.algoBotExecution.findUnique({ where: { fingerprint } });
    if (!exec) return null;
    return this.mapToRecord(exec);
  }

  public async getExecutionsByBotId(botId: string, limit = 50): Promise<ExecutionRecord[]> {
    const records = await this.prisma.algoBotExecution.findMany({
      where: { botId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    return records.map((r) => this.mapToRecord(r));
  }

  public async getPendingReconciliations(): Promise<ExecutionRecord[]> {
    const records = await this.prisma.algoBotExecution.findMany({
      where: { failureReasonCode: 'RECONCILIATION_REQUIRED' },
      orderBy: { failedAt: 'desc' },
    });
    return records.map((r) => this.mapToRecord(r));
  }

  private mapToRecord(exec: any): ExecutionRecord {
    return {
      id: exec.id,
      fingerprint: exec.fingerprint,
      botId: exec.botId,
      symbol: exec.symbol,
      contractSymbol: exec.contractSymbol || undefined,
      timeframe: exec.timeframe,
      direction: exec.direction as any as Direction,
      state: exec.state,
      correlationId: exec.correlationId,
      orderPositionId: exec.orderPositionId || undefined,
      failureReason: exec.failureReason || undefined,
      failureReasonCode: exec.failureReasonCode || undefined,
      reservedAt: exec.reservedAt || undefined,
      startedAt: exec.startedAt || undefined,
      completedAt: exec.completedAt || undefined,
      failedAt: exec.failedAt || undefined,
    };
  }
}
