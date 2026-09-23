import { Injectable, Logger, NotFoundException, ConflictException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { AlgoBotExecutionState } from '@prisma/client';
import {
  IExecutionDomainService,
  ExecutionRecord,
  ExecutionReconciliationEvidence,
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
      AlgoBotExecutionState.RECONCILIATION_REQUIRED,
      AlgoBotExecutionState.CANCELLED,
      AlgoBotExecutionState.FAILED_FINAL,
      AlgoBotExecutionState.FAILED_RETRYABLE,
    ],
    [AlgoBotExecutionState.RECONCILIATION_REQUIRED]: [
      AlgoBotExecutionState.EXECUTED,
      AlgoBotExecutionState.FAILED_FINAL,
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
   * the definitive result, flag first-class RECONCILIATION_REQUIRED. Never retry an uncertain order blindly.
   */
  public async markReconciliationRequired(executionId: string, message: string): Promise<ExecutionRecord | void> {
    const existing = await this.prisma.algoBotExecution.findUnique({ where: { id: executionId } });
    if (!existing) {
      throw new NotFoundException(`Execution '${executionId}' not found`);
    }

    if (existing.state === AlgoBotExecutionState.RECONCILIATION_REQUIRED) {
      return this.mapToRecord(existing); // Idempotent
    }

    this.validateTransition(existing, AlgoBotExecutionState.RECONCILIATION_REQUIRED);

    const updated = await this.prisma.algoBotExecution.update({
      where: { id: executionId },
      data: {
        state: AlgoBotExecutionState.RECONCILIATION_REQUIRED,
        failedAt: new Date(),
        failureReason: `[RECONCILIATION_REQUIRED] ${message}`,
        failureReasonCode: 'RECONCILIATION_REQUIRED',
      },
    });
    this.logger.error(`🚨 [RECONCILIATION REQUIRED] Execution '${executionId}' requires external broker reconciliation: ${message}`);
    return this.mapToRecord(updated);
  }

  /**
   * Authoritatively resolves an execution flagged as RECONCILIATION_REQUIRED as EXECUTED
   * based on verified broker order/fill evidence.
   */
  public async resolveExecutionAsExecuted(
    executionId: string,
    evidence: ExecutionReconciliationEvidence,
    orderPositionId?: string,
  ): Promise<ExecutionRecord> {
    const existing = await this.prisma.algoBotExecution.findUnique({ where: { id: executionId } });
    if (!existing) {
      throw new NotFoundException(`Execution '${executionId}' not found`);
    }

    if (!evidence) {
      throw new BadRequestException('Reconciliation evidence is strictly required');
    }
    if (!evidence.reconciliationActor) {
      throw new BadRequestException('Reconciliation actor must be specified in evidence');
    }
    if (!evidence.reason) {
      throw new BadRequestException('Reconciliation reason must be specified in evidence');
    }

    if (
      existing.state !== AlgoBotExecutionState.RECONCILIATION_REQUIRED &&
      existing.failureReasonCode !== 'RECONCILIATION_REQUIRED'
    ) {
      throw new ConflictException(
        `CANNOT_RESOLVE_RECONCILIATION: Execution '${executionId}' is in state '${existing.state}', expected '${AlgoBotExecutionState.RECONCILIATION_REQUIRED}'`,
      );
    }

    this.validateTransition(existing, AlgoBotExecutionState.EXECUTED);

    const now = new Date();
    const evidencePayload = {
      brokerOrderId: evidence.brokerOrderId ?? null,
      brokerStatus: evidence.brokerStatus ?? 'FILLED',
      brokerFilledQuantity: evidence.brokerFilledQuantity ?? null,
      brokerAveragePrice: evidence.brokerAveragePrice ?? null,
      brokerFills: evidence.brokerFills ?? [],
      timestamp: evidence.timestamp ? new Date(evidence.timestamp) : now,
      reconciliationActor: evidence.reconciliationActor,
      reason: evidence.reason,
      evidenceSnapshot: evidence.evidenceSnapshot ?? {},
    };

    const updated = await this.prisma.algoBotExecution.update({
      where: { id: executionId },
      data: {
        state: AlgoBotExecutionState.EXECUTED,
        completedAt: now,
        orderPositionId: orderPositionId || undefined,
        failureReason: `[RESOLVED_EXECUTED] ${evidence.reason} (Actor: ${evidence.reconciliationActor})`,
        failureReasonCode: 'RECONCILIATION_RESOLVED',
        reconciliationMetadataJson: evidencePayload as any,
        reconciledAt: now,
        reconciledBy: evidence.reconciliationActor,
      },
    });

    this.logger.log(
      `[RECONCILIATION RESOLVED EXECUTED] id=${executionId} | actor=${evidence.reconciliationActor} | reason=${evidence.reason}`,
    );

    return this.mapToRecord(updated);
  }

  /**
   * Authoritatively resolves an execution flagged as RECONCILIATION_REQUIRED as FAILED_FINAL
   * based on verified broker order/fill rejection or non-existence evidence.
   */
  public async resolveExecutionAsFailed(
    executionId: string,
    evidence: ExecutionReconciliationEvidence,
  ): Promise<ExecutionRecord> {
    const existing = await this.prisma.algoBotExecution.findUnique({ where: { id: executionId } });
    if (!existing) {
      throw new NotFoundException(`Execution '${executionId}' not found`);
    }

    if (!evidence) {
      throw new BadRequestException('Reconciliation evidence is strictly required');
    }
    if (!evidence.reconciliationActor) {
      throw new BadRequestException('Reconciliation actor must be specified in evidence');
    }
    if (!evidence.reason) {
      throw new BadRequestException('Reconciliation reason must be specified in evidence');
    }

    if (
      existing.state !== AlgoBotExecutionState.RECONCILIATION_REQUIRED &&
      existing.failureReasonCode !== 'RECONCILIATION_REQUIRED'
    ) {
      throw new ConflictException(
        `CANNOT_RESOLVE_RECONCILIATION: Execution '${executionId}' is in state '${existing.state}', expected '${AlgoBotExecutionState.RECONCILIATION_REQUIRED}'`,
      );
    }

    this.validateTransition(existing, AlgoBotExecutionState.FAILED_FINAL);

    const now = new Date();
    const evidencePayload = {
      brokerOrderId: evidence.brokerOrderId ?? null,
      brokerStatus: evidence.brokerStatus ?? 'REJECTED',
      brokerFilledQuantity: evidence.brokerFilledQuantity ?? 0,
      brokerAveragePrice: evidence.brokerAveragePrice ?? null,
      brokerFills: evidence.brokerFills ?? [],
      timestamp: evidence.timestamp ? new Date(evidence.timestamp) : now,
      reconciliationActor: evidence.reconciliationActor,
      reason: evidence.reason,
      evidenceSnapshot: evidence.evidenceSnapshot ?? {},
    };

    const updated = await this.prisma.algoBotExecution.update({
      where: { id: executionId },
      data: {
        state: AlgoBotExecutionState.FAILED_FINAL,
        failedAt: now,
        failureReason: `[RESOLVED_FAILED] ${evidence.reason} (Actor: ${evidence.reconciliationActor})`,
        failureReasonCode: 'RECONCILIATION_RESOLVED',
        reconciliationMetadataJson: evidencePayload as any,
        reconciledAt: now,
        reconciledBy: evidence.reconciliationActor,
      },
    });

    this.logger.log(
      `[RECONCILIATION RESOLVED FAILED] id=${executionId} | actor=${evidence.reconciliationActor} | reason=${evidence.reason}`,
    );

    return this.mapToRecord(updated);
  }

  /**
   * Backward-compatible bridge resolving an execution flagged as RECONCILIATION_REQUIRED.
   */
  public async resolveReconciliation(
    executionId: string,
    outcome: 'EXECUTED' | 'FAILED_FINAL',
    resolutionNotes: string,
    orderPositionId?: string,
    evidence?: ExecutionReconciliationEvidence,
  ): Promise<ExecutionRecord> {
    const resolvedEvidence: ExecutionReconciliationEvidence = evidence || {
      timestamp: new Date(),
      reconciliationActor: 'RECONCILIATION_SERVICE',
      reason: resolutionNotes,
      evidenceSnapshot: { outcome, orderPositionId },
    };

    if (outcome === 'EXECUTED') {
      return this.resolveExecutionAsExecuted(executionId, resolvedEvidence, orderPositionId);
    } else {
      return this.resolveExecutionAsFailed(executionId, resolvedEvidence);
    }
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
      where: {
        OR: [
          { state: AlgoBotExecutionState.RECONCILIATION_REQUIRED },
          { failureReasonCode: 'RECONCILIATION_REQUIRED' },
        ],
      },
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
      reconciliationMetadataJson: exec.reconciliationMetadataJson || undefined,
      reconciledAt: exec.reconciledAt || undefined,
      reconciledBy: exec.reconciledBy || undefined,
    };
  }
}
