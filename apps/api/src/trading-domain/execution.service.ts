import { Injectable, Logger, NotFoundException } from '@nestjs/common';
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

  constructor(private readonly prisma: PrismaService) {}

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

    return {
      id: created.id,
      fingerprint: created.fingerprint,
      botId: created.botId,
      symbol: created.symbol,
      contractSymbol: created.contractSymbol || undefined,
      timeframe: created.timeframe,
      direction: created.direction as any as Direction,
      state: created.state,
      correlationId: created.correlationId,
    };
  }

  public async markStarted(executionId: string): Promise<void> {
    await this.prisma.algoBotExecution.update({
      where: { id: executionId },
      data: {
        state: AlgoBotExecutionState.EXECUTING,
        startedAt: new Date(),
      },
    });
    this.logger.log(`[EXECUTION STARTED] id=${executionId}`);
  }

  public async markExecuted(executionId: string, orderPositionId?: string): Promise<void> {
    await this.prisma.algoBotExecution.update({
      where: { id: executionId },
      data: {
        state: AlgoBotExecutionState.EXECUTED,
        completedAt: new Date(),
        orderPositionId: orderPositionId || undefined,
      },
    });
    this.logger.log(`[EXECUTION EXECUTED] id=${executionId} | positionId=${orderPositionId}`);
  }

  public async markFailed(
    executionId: string,
    reasonCode: string,
    message: string,
    retryable: boolean,
  ): Promise<void> {
    const newState = retryable
      ? AlgoBotExecutionState.FAILED_RETRYABLE
      : AlgoBotExecutionState.FAILED_FINAL;

    await this.prisma.algoBotExecution.update({
      where: { id: executionId },
      data: {
        state: newState,
        failedAt: new Date(),
        failureReason: message,
        failureReasonCode: reasonCode,
      },
    });
    this.logger.warn(`[EXECUTION FAILED] id=${executionId} | state=${newState} | code=${reasonCode} | msg=${message}`);
  }

  /**
   * CRITICAL INVARIANT: If an external order may have executed but the database cannot establish
   * the definitive result, flag RECONCILIATION_REQUIRED. Never retry an uncertain order blindly.
   */
  public async markReconciliationRequired(executionId: string, message: string): Promise<void> {
    await this.prisma.algoBotExecution.update({
      where: { id: executionId },
      data: {
        state: AlgoBotExecutionState.FAILED_FINAL, // Fallback in enum until schema migration adds RECONCILIATION_REQUIRED
        failedAt: new Date(),
        failureReason: `[RECONCILIATION_REQUIRED] ${message}`,
        failureReasonCode: 'RECONCILIATION_REQUIRED',
      },
    });
    this.logger.error(`🚨 [RECONCILIATION REQUIRED] Execution '${executionId}' requires external broker reconciliation: ${message}`);
  }

  public async getExecutionById(executionId: string): Promise<ExecutionRecord | null> {
    const exec = await this.prisma.algoBotExecution.findUnique({ where: { id: executionId } });
    if (!exec) return null;
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
    };
  }
}
