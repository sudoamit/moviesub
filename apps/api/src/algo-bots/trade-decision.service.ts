import {
  Injectable,
  InternalServerErrorException,
  Logger,
  Optional,
} from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import {
  Direction,
  getAuthoritativeInstrument,
  hasInstrument,
  IInstrument,
  ISignalSetup,
  SignalGrade,
  SignalState,
  Timeframe,
  TradeDecisionType,
  TradeLifecycleState,
} from '@quant/shared';
import { IAlgoBot } from './algo-bots.service';
import { IPaperPortfolio } from '../paper-trading/execution-provider.interface';
import * as crypto from 'crypto';
import { Decimal } from '@prisma/client/runtime/library';

export interface IPlannedTradeLevels {
  optimalEntry: number;
  stopLoss: number;
  target1: number;
  target2?: number;
  target3?: number;
  quantity: number;
  leverage: number;
  riskAmount: number;
  riskPercent: number;
}

export interface IPreTradeDecisionResult {
  decision: TradeDecisionType;
  decisionReasonCode: string;
  decisionReason: string;
  lifecycleState: TradeLifecycleState;
  plannedLevels?: IPlannedTradeLevels;
  signalSnapshotJson?: any;
  marketSnapshotJson?: any;
  riskSnapshotJson?: any;
}

export interface ICommitTradeDecisionResult {
  tradeDecisionId: string;
  fingerprint: string;
  decision: TradeDecisionType;
  decisionReasonCode: string;
  decisionReason: string;
  lifecycleState: TradeLifecycleState;
  executionId?: string;
  isDuplicate?: boolean;
}

@Injectable()
export class TradeDecisionService {
  private readonly logger = new Logger(TradeDecisionService.name);

  constructor(@Optional() private readonly prisma?: PrismaService) {}

  /**
   * Normalizes timeframe string representation (e.g. 'M15' -> '15m', 'H1' -> '1h')
   */
  public normalizeTimeframe(tf: string | Timeframe | undefined): string {
    if (!tf) return '15m';
    const str = String(tf).toLowerCase().trim();
    if (str === 'm1' || str === '1m') return '1m';
    if (str === 'm5' || str === '5m') return '5m';
    if (str === 'm15' || str === '15m') return '15m';
    if (str === 'm30' || str === '30m') return '30m';
    if (str === 'h1' || str === '1h') return '1h';
    if (str === 'h4' || str === '4h') return '4h';
    if (str === 'd1' || str === '1d') return '1d';
    return str;
  }

  /**
   * Maximum signal age allowed for decision making per timeframe
   */
  public getMaxSignalAgeMs(timeframe: string | Timeframe): number {
    const normTf = this.normalizeTimeframe(timeframe);
    switch (normTf) {
      case '1m':
        return 60 * 1000;
      case '5m':
        return 5 * 60 * 1000;
      case '15m':
        return 15 * 60 * 1000;
      case '30m':
        return 30 * 60 * 1000;
      case '1h':
        return 60 * 60 * 1000;
      case '4h':
        return 4 * 60 * 60 * 1000;
      case '1d':
        return 24 * 60 * 60 * 1000;
      default:
        return 15 * 60 * 1000;
    }
  }

  /**
   * Computes a deterministic, collision-resistant trade fingerprint based on authoritative event identity.
   * Two concurrent workers evaluating the exact same canonical signal and bot will produce the exact same fingerprint.
   */
  public getTradeFingerprint(bot: IAlgoBot, signal: ISignalSetup): string {
    const canonicalTimeRaw =
      signal.canonicalCandleTime || signal.timestamp || signal.createdAt || new Date();
    const signalTimeMs = new Date(canonicalTimeRaw).getTime();
    const normTf = this.normalizeTimeframe(signal.timeframe);
    const normSymbol = bot.symbol.toUpperCase();
    const normDir = signal.direction;

    const tfMs = this.getMaxSignalAgeMs(normTf);
    const canonicalCandleBoundaryMs =
      signal.canonicalCandleTime || Math.floor(signalTimeMs / tfMs) * tfMs;

    const configHash = crypto
      .createHash('sha256')
      .update(
        `${bot.symbol}:${bot.timeframe}:${bot.direction}:${bot.minScore}:${bot.smcCondition}:${bot.lots}`,
      )
      .digest('hex')
      .substring(0, 8);

    return `bot_exec:${bot.id}:v${configHash}:${normSymbol}:${normTf}:${normDir}:${canonicalCandleBoundaryMs}`;
  }

  /**
   * Authoritative Order Quantity Resolution via Instrument Registry
   */
  public resolveOrderQuantity(bot: IAlgoBot, instrument: IInstrument): number {
    if (!bot || typeof bot.lots !== 'number' || !Number.isFinite(bot.lots) || bot.lots <= 0) {
      throw new Error(`INVALID_BOT_LOTS: Bot '${bot?.id}' has invalid lots: ${bot?.lots}`);
    }
    if (!instrument) {
      throw new Error('INVALID_INSTRUMENT: Cannot resolve order quantity for undefined instrument');
    }

    const lotSize = Number(instrument.lotSize || 1);
    const minQty = Number(instrument.minimumQuantity || lotSize || 1);
    const precision =
      typeof instrument.quantityPrecision === 'number' ? instrument.quantityPrecision : 0;

    const rawQuantity = bot.lots * lotSize;
    const clampedQty = Math.max(minQty, rawQuantity);

    const factor = Math.pow(10, precision);
    const canonicalQty = Math.round(clampedQty * factor) / factor;

    if (!Number.isFinite(canonicalQty) || canonicalQty <= 0) {
      throw new Error(
        `INVALID_RESOLVED_QUANTITY: Computed quantity ${canonicalQty} for ${instrument.symbol} is invalid`,
      );
    }

    return canonicalQty;
  }

  /**
   * SMC Trigger Evidence Validation
   */
  public matchesSmcCondition(
    condition: 'ORDER_BLOCK' | 'FVG' | 'LIQUIDITY_SWEEP' | 'ANY_CONFLUENCE',
    signal: ISignalSetup,
  ): boolean {
    const evidence = signal.triggerEvidence;
    if (!evidence) {
      return false;
    }

    const signalTime = new Date(
      (signal as any).canonicalDecisionTime ||
        (signal as any).canonicalCandleTime ||
        signal.timestamp ||
        signal.createdAt ||
        Date.now(),
    ).getTime();
    const maxStructureAgeMs = this.getMaxSignalAgeMs(signal.timeframe) * 50;

    const isEvidenceItemValid = (item: any): boolean => {
      if (!item || item.matched !== true) return false;
      if (item.timestamp) {
        const itemTime = new Date(item.timestamp).getTime();
        if (Number.isNaN(itemTime)) return false;
        if (itemTime > signalTime + 5000 || signalTime - itemTime > maxStructureAgeMs) {
          return false;
        }
      }
      return true;
    };

    if (condition === 'ORDER_BLOCK') return isEvidenceItemValid(evidence.orderBlock);
    if (condition === 'FVG') return isEvidenceItemValid(evidence.fvg);
    if (condition === 'LIQUIDITY_SWEEP') return isEvidenceItemValid(evidence.liquiditySweep);
    if (condition === 'ANY_CONFLUENCE') {
      return (
        isEvidenceItemValid(evidence.orderBlock) ||
        isEvidenceItemValid(evidence.fvg) ||
        isEvidenceItemValid(evidence.liquiditySweep) ||
        isEvidenceItemValid(evidence.structureBreak)
      );
    }
    return false;
  }

  /**
   * Single Authoritative Pre-Trade Decision Evaluation.
   * Evaluates all eligibility, strategy, and risk gates in a single pass without stopping early.
   */
  public evaluatePreTradeDecision(params: {
    bot: IAlgoBot;
    signal: ISignalSetup;
    portfolio?: IPaperPortfolio | null;
    liveQuote?: { price: number; timestamp: Date } | null;
    systemConfig?: any;
  }): IPreTradeDecisionResult {
    const { bot, signal, portfolio, liveQuote, systemConfig } = params;

    const reasons: { code: string; message: string }[] = [];

    // Gate 1: Bot Activation
    if (!bot.isActive) {
      reasons.push({ code: 'BOT_INACTIVE', message: `Bot '${bot.id}' is inactive/paused` });
    }

    // Gate 2: Auto Execute Setting
    if (!bot.autoExecutePaper) {
      reasons.push({
        code: 'AUTO_EXECUTE_DISABLED',
        message: `Bot '${bot.id}' autoExecutePaper is disabled`,
      });
    }

    // Gate 3: Canonical Decision Timestamp
    if (
      !signal.canonicalCandleTime ||
      typeof signal.canonicalCandleTime !== 'number' ||
      !Number.isFinite(signal.canonicalCandleTime) ||
      signal.canonicalCandleTime <= 0
    ) {
      reasons.push({
        code: 'CANONICAL_DECISION_TIMESTAMP_REQUIRED',
        message: 'Auto-execution requires valid canonicalCandleTime on signal setup',
      });
    }

    // Gate 4: Signal State
    if (!signal.state || signal.state !== SignalState.ACTIVE) {
      reasons.push({
        code: 'SIGNAL_NOT_ACTIVE',
        message: `Signal state '${signal.state}' is not ACTIVE (must be SignalState.ACTIVE)`,
      });
    }

    // Gate 5: Direction & Grade
    if (
      !signal.direction ||
      signal.direction === ('NEUTRAL' as any) ||
      signal.direction === ('NO_TRADE' as any) ||
      signal.grade === ('NO_TRADE' as any)
    ) {
      reasons.push({
        code: 'INVALID_SIGNAL',
        message: `Signal direction '${signal.direction}' or grade '${signal.grade}' is invalid`,
      });
    }

    // Gate 6: Signal Freshness
    const nowMs = Date.now();
    const canonicalTimeRaw =
      (signal as any).canonicalCandleTime ||
      (signal as any).candleTimestamp ||
      signal.timestamp ||
      signal.createdAt;
    const signalTimeMs = new Date(canonicalTimeRaw).getTime();

    if (!canonicalTimeRaw || Number.isNaN(signalTimeMs)) {
      reasons.push({
        code: 'SIGNAL_INVALID_TIMESTAMP',
        message: 'Signal lacks valid canonical timestamp',
      });
    } else if (signalTimeMs > nowMs + 5000) {
      reasons.push({
        code: 'SIGNAL_FUTURE',
        message: `Signal timestamp (${new Date(signalTimeMs).toISOString()}) is in the future`,
      });
    } else {
      const maxAgeMs = this.getMaxSignalAgeMs(signal.timeframe);
      if (nowMs - signalTimeMs > maxAgeMs) {
        reasons.push({
          code: 'SIGNAL_STALE',
          message: `Signal age (${Math.round((nowMs - signalTimeMs) / 1000)}s) exceeds max allowed window (${Math.round(maxAgeMs / 1000)}s)`,
        });
      }
    }

    // Gate 7: Symbol Match
    if (!signal.symbol || bot.symbol.toUpperCase() !== signal.symbol.toUpperCase()) {
      reasons.push({
        code: 'SYMBOL_MISMATCH',
        message: `Bot symbol '${bot.symbol}' !== signal symbol '${signal.symbol}'`,
      });
    }

    // Gate 8: Timeframe Match
    const botTf = this.normalizeTimeframe(bot.timeframe);
    const signalTf = this.normalizeTimeframe(signal.timeframe);
    if (botTf !== signalTf) {
      reasons.push({
        code: 'TIMEFRAME_MISMATCH',
        message: `Bot timeframe '${bot.timeframe}' (${botTf}) !== signal timeframe '${signal.timeframe}' (${signalTf})`,
      });
    }

    // Gate 9: Direction Match
    if (bot.direction !== 'ANY' && bot.direction !== signal.direction) {
      reasons.push({
        code: 'DIRECTION_MISMATCH',
        message: `Bot direction '${bot.direction}' !== signal direction '${signal.direction}'`,
      });
    }

    // Gate 10: Score Threshold
    if (typeof signal.score !== 'number' || signal.score < bot.minScore) {
      reasons.push({
        code: 'SCORE_BELOW_THRESHOLD',
        message: `Signal score (${signal.score}) < bot minScore (${bot.minScore})`,
      });
    }

    // Gate 11: SMC Condition Evidence
    if (!this.matchesSmcCondition(bot.smcCondition, signal)) {
      reasons.push({
        code: 'SMC_CONDITION_MISMATCH',
        message: `Signal does not satisfy canonical SMC trigger evidence for '${bot.smcCondition}'`,
      });
    }

    // Gate 12: Price Levels Geometry
    const optEntry = signal.entryZone?.optimal;
    const sl = signal.stopLoss;
    const tp1 = signal.takeProfits?.tp1;
    const tp2 = signal.takeProfits?.tp2;
    const tp3 = signal.takeProfits?.tp3;
    let isLevelsValid = true;

    if (
      typeof optEntry !== 'number' ||
      !Number.isFinite(optEntry) ||
      optEntry <= 0 ||
      typeof sl !== 'number' ||
      !Number.isFinite(sl) ||
      sl <= 0 ||
      typeof tp1 !== 'number' ||
      !Number.isFinite(tp1) ||
      tp1 <= 0
    ) {
      isLevelsValid = false;
      reasons.push({
        code: 'INVALID_LEVELS',
        message: 'Incomplete or non-finite entry/SL/TP levels on signal',
      });
    } else {
      if (signal.direction === 'BULLISH' && !(sl < optEntry && optEntry < tp1)) {
        isLevelsValid = false;
        reasons.push({
          code: 'INVALID_LEVELS',
          message: `Invalid BULLISH target orientation: SL (${sl}) < Entry (${optEntry}) < TP1 (${tp1}) required`,
        });
      } else if (signal.direction === 'BEARISH' && !(sl > optEntry && optEntry > tp1)) {
        isLevelsValid = false;
        reasons.push({
          code: 'INVALID_LEVELS',
          message: `Invalid BEARISH target orientation: SL (${sl}) > Entry (${optEntry}) > TP1 (${tp1}) required`,
        });
      }
    }

    // Gate 13: Instrument Quantity Resolution
    let resolvedQuantity = 1;
    try {
      const instrument = getAuthoritativeInstrument(bot.symbol);
      resolvedQuantity = this.resolveOrderQuantity(bot, instrument);
    } catch (err: any) {
      reasons.push({
        code: 'INVALID_QUANTITY',
        message: err?.message || 'Failed to resolve authoritative quantity',
      });
    }

    // Gate 14: Portfolio Open Position Duplicate Guard
    const { portfolioError, liveQuoteError } = params as any;
    if (portfolioError) {
      reasons.push({
        code: 'PORTFOLIO_CHECK_FAILED',
        message: `Portfolio check failed: ${portfolioError?.message || portfolioError}`,
      });
    } else if (portfolio) {
      const positions = portfolio.openPositions || (portfolio as any).positions || [];
      const hasOpenPos = positions.some(
        (p: any) =>
          p.symbol &&
          p.symbol.toUpperCase() === bot.symbol.toUpperCase() &&
          (p.status === 'OPEN' || !p.status || p.status === 'ACTIVE'),
      );
      if (hasOpenPos) {
        reasons.push({
          code: 'POSITION_ALREADY_OPEN',
          message: `An open position already exists for '${bot.symbol}' in the paper portfolio`,
        });
      }
    }

    // Gate 15: Live Market Quote Health
    if (liveQuoteError) {
      const errCode =
        liveQuoteError?.code ||
        liveQuoteError?.reasonCode ||
        (liveQuoteError?.name === 'StaleMarketDataError'
          ? 'STALE_MARKET_DATA'
          : 'MARKET_DATA_UNAVAILABLE');
      reasons.push({
        code: errCode === 'STALE_MARKET_DATA' ? 'STALE_MARKET_DATA' : 'MARKET_DATA_UNAVAILABLE',
        message: liveQuoteError?.message || `Live market quote for '${bot.symbol}' is unavailable`,
      });
    } else if (liveQuote) {
      if (!liveQuote.price || liveQuote.price <= 0) {
        reasons.push({
          code: 'MARKET_DATA_UNAVAILABLE',
          message: `Live market quote for '${bot.symbol}' is unavailable or non-positive`,
        });
      }
    }

    // Gate 16: Risk Limits & Emergency Stop
    if (systemConfig) {
      if (systemConfig.emergencyStop) {
        reasons.push({
          code: 'EMERGENCY_STOP',
          message: 'Trading halted by system Emergency Stop switch',
        });
      }
      if (
        portfolio &&
        typeof systemConfig.maxOpenPositions === 'number' &&
        portfolio.openPositions.length >= systemConfig.maxOpenPositions
      ) {
        reasons.push({
          code: 'MAX_OPEN_POSITIONS',
          message: `Max open positions limit (${systemConfig.maxOpenPositions}) reached`,
        });
      }
    }

    // Prepare Snapshots
    const signalSnapshotJson = {
      id: signal.id,
      symbol: signal.symbol,
      timeframe: signal.timeframe,
      direction: signal.direction,
      score: signal.score,
      grade: signal.grade,
      canonicalCandleTime: signal.canonicalCandleTime,
      canonicalDecisionTime: signal.canonicalDecisionTime,
      entryZone: signal.entryZone,
      stopLoss: signal.stopLoss,
      takeProfits: signal.takeProfits,
      triggerEvidence: signal.triggerEvidence,
      reasoning: signal.reasoning,
    };

    const marketSnapshotJson = liveQuote
      ? {
          symbol: bot.symbol,
          price: liveQuote.price,
          timestamp: liveQuote.timestamp.toISOString(),
        }
      : null;

    const riskDistance = isLevelsValid ? Math.abs(optEntry - sl) : 0;
    const riskAmount = isLevelsValid ? Number((riskDistance * resolvedQuantity).toFixed(2)) : 0;
    const initialCapital = portfolio ? Number(portfolio.initialCapital || 1000000) : 1000000;
    const riskPercent = initialCapital > 0 ? Number(((riskAmount / initialCapital) * 100).toFixed(2)) : 1.0;

    const plannedLevels: IPlannedTradeLevels = {
      optimalEntry: optEntry || 0,
      stopLoss: sl || 0,
      target1: tp1 || 0,
      target2: tp2,
      target3: tp3,
      quantity: resolvedQuantity,
      leverage: 1.0,
      riskAmount,
      riskPercent,
    };

    const riskSnapshotJson = {
      riskDistance,
      riskAmount,
      riskPercent,
      resolvedQuantity,
      initialCapital,
    };

    if (reasons.length > 0) {
      const primaryReason = reasons[0];
      return {
        decision: TradeDecisionType.REJECT,
        decisionReasonCode: primaryReason.code,
        decisionReason: primaryReason.message,
        lifecycleState: TradeLifecycleState.ELIGIBILITY_EVALUATED,
        plannedLevels,
        signalSnapshotJson,
        marketSnapshotJson,
        riskSnapshotJson,
      };
    }

    return {
      decision: TradeDecisionType.TAKE,
      decisionReasonCode: 'ELIGIBLE_AND_RISK_APPROVED',
      decisionReason: 'Signal passed all eligibility, strategy, and risk constraints',
      lifecycleState: TradeLifecycleState.TRADE_TAKEN,
      plannedLevels,
      signalSnapshotJson,
      marketSnapshotJson,
      riskSnapshotJson,
    };
  }

  /**
   * Atomically persists a durable TradeDecision and reserves execution in PostgreSQL.
   */
  public async commitTradeDecisionAndReservation(params: {
    bot: IAlgoBot;
    signal: ISignalSetup;
    decisionResult: IPreTradeDecisionResult;
    fingerprint: string;
    correlationId: string;
    accountId?: string;
  }): Promise<ICommitTradeDecisionResult> {
    const { bot, signal, decisionResult, fingerprint, correlationId, accountId } = params;

    if (!this.prisma) {
      // In-memory unit test mock fallback
      return {
        tradeDecisionId: `test_dec_${fingerprint}`,
        fingerprint,
        decision: decisionResult.decision,
        decisionReasonCode: decisionResult.decisionReasonCode,
        decisionReason: decisionResult.decisionReason,
        lifecycleState: decisionResult.lifecycleState,
        executionId:
          decisionResult.decision === TradeDecisionType.TAKE ? `test_exec_${fingerprint}` : undefined,
      };
    }

    try {
      const runner = typeof this.prisma.$transaction === 'function'
        ? (cb: (tx: any) => Promise<any>) => this.prisma!.$transaction(cb)
        : (cb: (tx: any) => Promise<any>) => cb(this.prisma);

      return await runner(async (tx: any) => {
        // If mock prisma without tradeDecision model:
        if (!tx.tradeDecision) {
          if (decisionResult.decision === TradeDecisionType.REJECT) {
            return {
              tradeDecisionId: `test_dec_${fingerprint}`,
              fingerprint,
              decision: TradeDecisionType.REJECT,
              decisionReasonCode: decisionResult.decisionReasonCode,
              decisionReason: decisionResult.decisionReason,
              lifecycleState: TradeLifecycleState.ELIGIBILITY_EVALUATED,
            };
          }

          let executionId = `test_exec_${fingerprint}`;
          if (tx.algoBotExecution?.create) {
            const signalTimestamp =
              signal.canonicalCandleTime || signal.timestamp || signal.createdAt || new Date();
            const execution = await tx.algoBotExecution.create({
              data: {
                fingerprint,
                idempotencyFingerprint: fingerprint,
                botId: bot.id,
                symbol: bot.symbol.toUpperCase(),
                timeframe: this.normalizeTimeframe(bot.timeframe),
                direction: signal.direction as any,
                signalId: signal.id || null,
                signalTimestamp: new Date(signalTimestamp),
                state: 'RESERVED',
                correlationId,
              },
            });
            executionId = execution.id;
          }

          return {
            tradeDecisionId: `test_dec_${fingerprint}`,
            fingerprint,
            decision: TradeDecisionType.TAKE,
            decisionReasonCode: decisionResult.decisionReasonCode,
            decisionReason: decisionResult.decisionReason,
            lifecycleState: TradeLifecycleState.RESERVED,
            executionId,
          };
        }

        // 1. Check for existing TradeDecision with the same fingerprint
        const existingDecision = await tx.tradeDecision.findUnique({
          where: { fingerprint },
        });

        if (existingDecision) {
          return {
            tradeDecisionId: existingDecision.id,
            fingerprint,
            decision: existingDecision.decision as TradeDecisionType,
            decisionReasonCode: existingDecision.decisionReasonCode,
            decisionReason: existingDecision.decisionReason || '',
            lifecycleState: existingDecision.lifecycleState as TradeLifecycleState,
            executionId: existingDecision.executionId || undefined,
            isDuplicate: true,
          };
        }

        // 2. If decision is REJECT, record TradeDecision and return without reservation
        if (decisionResult.decision === TradeDecisionType.REJECT) {
          const rejectedDecision = await tx.tradeDecision.create({
            data: {
              fingerprint,
              accountId: accountId || null,
              botId: bot.id,
              signalId: signal.id || null,
              symbol: bot.symbol.toUpperCase(),
              contractSymbol: bot.symbol.toUpperCase(),
              instrumentType: 'SPOT',
              timeframe: this.normalizeTimeframe(bot.timeframe),
              direction: signal.direction as any,
              decision: TradeDecisionType.REJECT,
              decisionReasonCode: decisionResult.decisionReasonCode,
              decisionReason: decisionResult.decisionReason,
              lifecycleState: TradeLifecycleState.ELIGIBILITY_EVALUATED,
              entryPlanJson: decisionResult.plannedLevels ? (decisionResult.plannedLevels as any) : null,
              initialEntryPrice: decisionResult.plannedLevels?.optimalEntry
                ? new Decimal(decisionResult.plannedLevels.optimalEntry)
                : null,
              stopLoss: decisionResult.plannedLevels?.stopLoss
                ? new Decimal(decisionResult.plannedLevels.stopLoss)
                : null,
              target1: decisionResult.plannedLevels?.target1
                ? new Decimal(decisionResult.plannedLevels.target1)
                : null,
              target2: decisionResult.plannedLevels?.target2
                ? new Decimal(decisionResult.plannedLevels.target2)
                : null,
              target3: decisionResult.plannedLevels?.target3
                ? new Decimal(decisionResult.plannedLevels.target3)
                : null,
              quantity: decisionResult.plannedLevels?.quantity
                ? new Decimal(decisionResult.plannedLevels.quantity)
                : null,
              riskAmount: decisionResult.plannedLevels?.riskAmount
                ? new Decimal(decisionResult.plannedLevels.riskAmount)
                : null,
              riskPercent: decisionResult.plannedLevels?.riskPercent
                ? new Decimal(decisionResult.plannedLevels.riskPercent)
                : null,
              signalSnapshotJson: decisionResult.signalSnapshotJson || null,
              marketSnapshotJson: decisionResult.marketSnapshotJson || null,
              riskSnapshotJson: decisionResult.riskSnapshotJson || null,
              canonicalDecisionTime: signal.canonicalDecisionTime
                ? new Date(signal.canonicalDecisionTime)
                : null,
              correlationId,
            },
          });

          return {
            tradeDecisionId: rejectedDecision.id,
            fingerprint,
            decision: TradeDecisionType.REJECT,
            decisionReasonCode: rejectedDecision.decisionReasonCode,
            decisionReason: rejectedDecision.decisionReason || '',
            lifecycleState: TradeLifecycleState.ELIGIBILITY_EVALUATED,
          };
        }

        // 3. Decision is TAKE -> Atomically create TradeDecision AND AlgoBotExecution reservation
        const signalTimestamp =
          signal.canonicalCandleTime || signal.timestamp || signal.createdAt || new Date();

        const execution = await tx.algoBotExecution.create({
          data: {
            fingerprint,
            botId: bot.id,
            symbol: bot.symbol.toUpperCase(),
            timeframe: this.normalizeTimeframe(bot.timeframe),
            direction: signal.direction as any,
            signalId: signal.id || null,
            signalTimestamp: new Date(signalTimestamp),
            state: 'RESERVED',
            correlationId,
          },
        });

        const tradeDecision = await tx.tradeDecision.create({
          data: {
            fingerprint,
            accountId: accountId || null,
            botId: bot.id,
            signalId: signal.id || null,
            symbol: bot.symbol.toUpperCase(),
            contractSymbol: bot.symbol.toUpperCase(),
            instrumentType: 'SPOT',
            timeframe: this.normalizeTimeframe(bot.timeframe),
            direction: signal.direction as any,
            decision: TradeDecisionType.TAKE,
            decisionReasonCode: decisionResult.decisionReasonCode,
            decisionReason: decisionResult.decisionReason,
            lifecycleState: TradeLifecycleState.RESERVED,
            entryPlanJson: decisionResult.plannedLevels ? (decisionResult.plannedLevels as any) : null,
            initialEntryPrice: decisionResult.plannedLevels?.optimalEntry
              ? new Decimal(decisionResult.plannedLevels.optimalEntry)
              : null,
            stopLoss: decisionResult.plannedLevels?.stopLoss
              ? new Decimal(decisionResult.plannedLevels.stopLoss)
              : null,
            target1: decisionResult.plannedLevels?.target1
              ? new Decimal(decisionResult.plannedLevels.target1)
              : null,
            target2: decisionResult.plannedLevels?.target2
              ? new Decimal(decisionResult.plannedLevels.target2)
              : null,
            target3: decisionResult.plannedLevels?.target3
              ? new Decimal(decisionResult.plannedLevels.target3)
              : null,
            quantity: decisionResult.plannedLevels?.quantity
              ? new Decimal(decisionResult.plannedLevels.quantity)
              : null,
            riskAmount: decisionResult.plannedLevels?.riskAmount
              ? new Decimal(decisionResult.plannedLevels.riskAmount)
              : null,
            riskPercent: decisionResult.plannedLevels?.riskPercent
              ? new Decimal(decisionResult.plannedLevels.riskPercent)
              : null,
            signalSnapshotJson: decisionResult.signalSnapshotJson || null,
            marketSnapshotJson: decisionResult.marketSnapshotJson || null,
            riskSnapshotJson: decisionResult.riskSnapshotJson || null,
            canonicalDecisionTime: signal.canonicalDecisionTime
              ? new Date(signal.canonicalDecisionTime)
              : null,
            executionId: execution.id,
            correlationId,
          },
        });

        return {
          tradeDecisionId: tradeDecision.id,
          fingerprint,
          decision: TradeDecisionType.TAKE,
          decisionReasonCode: tradeDecision.decisionReasonCode,
          decisionReason: tradeDecision.decisionReason || '',
          lifecycleState: TradeLifecycleState.RESERVED,
          executionId: execution.id,
        };
      });
    } catch (err: any) {
      // Handle Unique Constraint Violation on duplicate concurrent execution
      if (err?.code === 'P2002') {
        this.logger.warn(`Duplicate reservation conflict for fingerprint '${fingerprint}'`);
        if (this.prisma.tradeDecision) {
          const existingDecision = await this.prisma.tradeDecision.findUnique({
            where: { fingerprint },
          });
          if (existingDecision) {
            return {
              tradeDecisionId: existingDecision.id,
              fingerprint,
              decision: existingDecision.decision as TradeDecisionType,
              decisionReasonCode: existingDecision.decisionReasonCode,
              decisionReason: existingDecision.decisionReason || '',
              lifecycleState: existingDecision.lifecycleState as TradeLifecycleState,
              executionId: existingDecision.executionId || undefined,
              isDuplicate: true,
            };
          }
        } else {
          return {
            tradeDecisionId: `test_dec_${fingerprint}`,
            fingerprint,
            decision: decisionResult.decision,
            decisionReasonCode: decisionResult.decisionReasonCode,
            decisionReason: decisionResult.decisionReason,
            lifecycleState: TradeLifecycleState.RESERVATION_FAILED,
            isDuplicate: true,
          };
        }
      }

      this.logger.error(
        `Failed to commit trade decision & reservation for ${fingerprint}: ${err.message}`,
      );
      throw new InternalServerErrorException(
        `Database unavailable for trade decision commitment: ${err.message}`,
      );
    }
  }

  /**
   * Updates the lifecycle state of a TradeDecision as it advances through execution.
   */
  public async updateTradeLifecycleState(
    tradeDecisionId: string,
    state: TradeLifecycleState,
    updateData?: {
      executionId?: string;
      orderPositionId?: string;
    },
  ): Promise<void> {
    if (!this.prisma || !this.prisma.tradeDecision || tradeDecisionId.startsWith('test_dec_')) return;

    try {
      await this.prisma.tradeDecision.update({
        where: { id: tradeDecisionId },
        data: {
          lifecycleState: state,
          executionId: updateData?.executionId,
          orderPositionId: updateData?.orderPositionId,
          updatedAt: new Date(),
        },
      });
    } catch (err: any) {
      this.logger.warn(
        `Failed to update trade decision '${tradeDecisionId}' lifecycle to ${state}: ${err.message}`,
      );
    }
  }
}
