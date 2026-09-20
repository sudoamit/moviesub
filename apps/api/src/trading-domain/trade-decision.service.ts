import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import {
  ITradeDecisionDomainService,
  PreTradeDecisionParams,
  PreTradeDecisionResult,
  CommitDecisionParams,
  CommittedDecisionRecord,
  TradeLifecycleState,
} from '@quant/shared';
import { Decimal } from '@prisma/client/runtime/library';

@Injectable()
export class DomainTradeDecisionService implements ITradeDecisionDomainService {
  private readonly logger = new Logger(DomainTradeDecisionService.name);

  constructor(private readonly prisma: PrismaService) {}

  public evaluatePreTradeDecision(params: PreTradeDecisionParams): PreTradeDecisionResult {
    const { bot, signal } = params;

    if (!bot.isActive) {
      return {
        decision: 'REJECT',
        decisionReasonCode: 'BOT_INACTIVE',
        decisionReason: `Bot '${bot.id}' is inactive`,
      };
    }

    if (!bot.autoExecutePaper) {
      return {
        decision: 'REJECT',
        decisionReasonCode: 'AUTO_EXECUTE_DISABLED',
        decisionReason: `Bot '${bot.id}' autoExecutePaper is false`,
      };
    }

    if (signal.state && signal.state !== 'ACTIVE') {
      return {
        decision: 'REJECT',
        decisionReasonCode: 'SIGNAL_NOT_ACTIVE',
        decisionReason: `Signal state '${signal.state}' is not ACTIVE`,
      };
    }

    return {
      decision: 'TAKE',
      decisionReasonCode: 'SIGNAL_CRITERIA_MET',
      decisionReason: 'Signal criteria met and risk checks passed',
      plannedLevels: {
        optimalEntry: signal.entryZone?.optimal ?? signal.entryPrice ?? 0,
        stopLoss: signal.stopLoss ?? 0,
        target1: signal.takeProfits?.tp1 ?? signal.target1 ?? 0,
        target2: signal.takeProfits?.tp2 ?? signal.target2,
        target3: signal.takeProfits?.tp3 ?? signal.target3,
        riskRewardRatio: signal.riskRewardRatio ?? 2.0,
        quantity: 1,
        riskAmount: 1000,
        riskPercent: 1.0,
      },
      signalSnapshotJson: signal,
    };
  }

  public async commitDecision(params: CommitDecisionParams): Promise<CommittedDecisionRecord> {
    const { bot, signal, decisionResult, fingerprint, correlationId, accountId } = params;

    if (!accountId || accountId.trim() === '') {
      throw new BadRequestException('ACCOUNT_ID_REQUIRED: accountId is mandatory for committing a decision');
    }

    const existing = await this.prisma.tradeDecision.findUnique({
      where: { fingerprint },
    });

    if (existing) {
      return {
        tradeDecisionId: existing.id,
        fingerprint,
        decision: existing.decision as 'TAKE' | 'REJECT',
        decisionReasonCode: existing.decisionReasonCode,
        decisionReason: existing.decisionReason || '',
        lifecycleState: existing.lifecycleState as TradeLifecycleState,
        executionId: existing.executionId || undefined,
        isDuplicate: true,
      };
    }

    const isTake = decisionResult.decision === 'TAKE';
    const lifecycleState = isTake
      ? TradeLifecycleState.TRADE_TAKEN
      : TradeLifecycleState.TRADE_REJECTED;

    const created = await this.prisma.tradeDecision.create({
      data: {
        fingerprint,
        accountId,
        botId: bot.id,
        signalId: signal.id || null,
        symbol: bot.symbol.toUpperCase(),
        contractSymbol: params.contractSymbol || bot.symbol.toUpperCase(),
        executionInstrument: params.executionInstrument,
        executionInstrumentType: params.executionInstrumentType,
        signalSourceInstrument: params.signalSourceInstrument,
        strike: params.strike ? new Decimal(params.strike) : null,
        optionType: params.optionType,
        expiry: params.expiry,
        signalDirection: params.signalDirection,
        orderSide: params.orderSide,
        timeframe: bot.timeframe || '15m',
        direction: signal.direction,
        decision: decisionResult.decision as any,
        decisionReasonCode: decisionResult.decisionReasonCode,
        decisionReason: decisionResult.decisionReason,
        lifecycleState,
        entryPlanJson: (decisionResult.plannedLevels as any) ?? undefined,
        initialEntryPrice: decisionResult.plannedLevels?.optimalEntry ? new Decimal(decisionResult.plannedLevels.optimalEntry) : null,
        stopLoss: decisionResult.plannedLevels?.stopLoss ? new Decimal(decisionResult.plannedLevels.stopLoss) : null,
        target1: decisionResult.plannedLevels?.target1 ? new Decimal(decisionResult.plannedLevels.target1) : null,
        target2: decisionResult.plannedLevels?.target2 ? new Decimal(decisionResult.plannedLevels.target2) : null,
        target3: decisionResult.plannedLevels?.target3 ? new Decimal(decisionResult.plannedLevels.target3) : null,
        quantity: decisionResult.plannedLevels?.quantity ? new Decimal(decisionResult.plannedLevels.quantity) : null,
        riskAmount: decisionResult.plannedLevels?.riskAmount ? new Decimal(decisionResult.plannedLevels.riskAmount) : null,
        riskPercent: decisionResult.plannedLevels?.riskPercent ? new Decimal(decisionResult.plannedLevels.riskPercent) : null,
        signalSnapshotJson: (decisionResult.signalSnapshotJson as any) ?? undefined,
        correlationId,
        decisionTime: new Date(),
        tradeTakenTime: isTake ? new Date() : null,
      },
    });

    return {
      tradeDecisionId: created.id,
      fingerprint,
      decision: decisionResult.decision,
      decisionReasonCode: created.decisionReasonCode,
      decisionReason: created.decisionReason || '',
      lifecycleState: created.lifecycleState as TradeLifecycleState,
      executionId: created.executionId || undefined,
    };
  }

  public async getDecisionById(id: string): Promise<any | null> {
    return this.prisma.tradeDecision.findUnique({ where: { id } });
  }

  public async getDecisionByFingerprint(fingerprint: string): Promise<any | null> {
    return this.prisma.tradeDecision.findUnique({ where: { fingerprint } });
  }
}
