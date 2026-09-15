import { BadRequestException, Injectable, Logger, NotFoundException, OnModuleInit, Optional } from '@nestjs/common';
import { PaperTradingService } from '../paper-trading/paper-trading.service';
import { AlertsService } from '../alerts/alerts.service';
import { PrismaService } from '../common/prisma/prisma.service';
import { RedisService } from '../common/redis/redis.service';
import {
  Direction,
  getAuthoritativeInstrument,
  hasInstrument,
  IInstrument,
  ISignalSetup,
  MarketDataUnavailableError,
  SignalGrade,
  SignalState,
  StaleMarketDataError,
  Timeframe,
} from '@quant/shared';

export interface IAlgoBot {
  id: string;
  name: string;
  symbol: string;
  direction: 'BULLISH' | 'BEARISH' | 'ANY';
  timeframe: string;
  minScore: number;
  smcCondition: 'ORDER_BLOCK' | 'FVG' | 'LIQUIDITY_SWEEP' | 'ANY_CONFLUENCE';
  lots: number;
  autoExecutePaper: boolean;
  notifyWebhook: boolean;
  isActive: boolean;
  createdAt: string;
  triggerCount: number;
  lastTriggeredAt?: string;
  lastTriggerDetails?: string;
}

export interface IStrategyMatchResult {
  matches: boolean;
  reasonCode?: string;
  details?: string;
}

@Injectable()
export class AlgoBotsService implements OnModuleInit {
  private readonly logger = new Logger(AlgoBotsService.name);

  // Process-local lock cache optimization
  private readonly inMemoryLocks = new Set<string>();

  // Fallback in-memory store if DB is empty on first boot
  private presetBots: IAlgoBot[] = [
    {
      id: 'bot_nifty_smc_pro',
      name: 'NIFTY 15m Institutional Order Flow Scalper',
      symbol: 'NIFTY',
      direction: 'ANY',
      timeframe: '15m',
      minScore: 80,
      smcCondition: 'ORDER_BLOCK',
      lots: 1,
      autoExecutePaper: false,
      notifyWebhook: true,
      isActive: false,
      createdAt: new Date().toISOString(),
      triggerCount: 0,
    },
    {
      id: 'bot_banknifty_fvg',
      name: 'BANKNIFTY 15m Fair Value Gap Hunter',
      symbol: 'BANKNIFTY',
      direction: 'BEARISH',
      timeframe: '15m',
      minScore: 85,
      smcCondition: 'FVG',
      lots: 1,
      autoExecutePaper: false,
      notifyWebhook: true,
      isActive: false,
      createdAt: new Date().toISOString(),
      triggerCount: 0,
    },
    {
      id: 'bot_btc_liquidity_sweep',
      name: 'BTCUSDT 15m Liquidity Pool Sweeper',
      symbol: 'BTCUSDT',
      direction: 'BULLISH',
      timeframe: '15m',
      minScore: 75,
      smcCondition: 'LIQUIDITY_SWEEP',
      lots: 1,
      autoExecutePaper: false,
      notifyWebhook: false,
      isActive: false,
      createdAt: new Date().toISOString(),
      triggerCount: 0,
    },
  ];

  constructor(
    private readonly paperTradingService: PaperTradingService,
    private readonly alertsService: AlertsService,
    @Optional() private readonly prisma?: PrismaService,
    @Optional() private readonly redis?: RedisService,
  ) {
    this.logger.log('Algo Strategy Studio Service Initialized.');
  }

  async onModuleInit() {
    if (this.prisma) {
      try {
        const count = await this.prisma.algoBot.count();
        if (count === 0) {
          this.logger.log('Seeding initial preset AlgoBots into database...');
          for (const bot of this.presetBots) {
            await this.prisma.algoBot.create({
              data: {
                id: bot.id,
                name: bot.name,
                symbol: bot.symbol,
                direction: bot.direction as any,
                timeframe: bot.timeframe,
                minScore: bot.minScore,
                smcCondition: bot.smcCondition as any,
                lots: bot.lots,
                autoExecutePaper: bot.autoExecutePaper,
                notifyWebhook: bot.notifyWebhook,
                isActive: bot.isActive,
                triggerCount: bot.triggerCount,
              },
            });
          }
        }
      } catch (err: any) {
        this.logger.warn(`Failed to seed/sync preset AlgoBots in database: ${err?.message}`);
      }
    }
  }

  /**
   * P1 #15: Persistent Database Bot Configuration Read
   */
  async listBots(): Promise<IAlgoBot[]> {
    if (this.prisma) {
      try {
        const dbBots = await this.prisma.algoBot.findMany({
          orderBy: { createdAt: 'desc' },
        });
        if (dbBots && dbBots.length > 0) {
          return dbBots.map((b) => ({
            id: b.id,
            name: b.name,
            symbol: b.symbol,
            direction: b.direction as any,
            timeframe: b.timeframe,
            minScore: b.minScore,
            smcCondition: b.smcCondition as any,
            lots: b.lots,
            autoExecutePaper: b.autoExecutePaper,
            notifyWebhook: b.notifyWebhook,
            isActive: b.isActive,
            createdAt: b.createdAt.toISOString(),
            triggerCount: b.triggerCount,
            lastTriggeredAt: b.lastTriggeredAt ? b.lastTriggeredAt.toISOString() : undefined,
            lastTriggerDetails: b.lastTriggerDetails || undefined,
          }));
        }
      } catch {
        // Fallback to in-memory if DB fails
      }
    }
    return this.presetBots;
  }

  /**
   * P1 #14: DTO Validation for AlgoBot Configuration
   */
  public validateBotConfig(dto: Partial<IAlgoBot>): void {
    if (!dto.name || typeof dto.name !== 'string' || dto.name.trim().length === 0) {
      throw new BadRequestException('Bot name is required and must be a non-empty string');
    }

    const symbol = (dto.symbol || '').toUpperCase().trim();
    if (!hasInstrument(symbol)) {
      throw new BadRequestException(`Unsupported instrument symbol '${dto.symbol}'`);
    }

    const normTf = this.normalizeTimeframe(dto.timeframe);
    const validTimeframes = ['1m', '5m', '15m', '30m', '1h', '4h', '1d'];
    if (!validTimeframes.includes(normTf)) {
      throw new BadRequestException(`Unsupported timeframe '${dto.timeframe}'`);
    }

    if (dto.direction && !['BULLISH', 'BEARISH', 'ANY'].includes(dto.direction)) {
      throw new BadRequestException(`Unsupported bot direction '${dto.direction}'`);
    }

    if (
      dto.smcCondition &&
      !['ORDER_BLOCK', 'FVG', 'LIQUIDITY_SWEEP', 'ANY_CONFLUENCE'].includes(dto.smcCondition)
    ) {
      throw new BadRequestException(`Unsupported bot smcCondition '${dto.smcCondition}'`);
    }

    if (
      typeof dto.minScore === 'number' &&
      (dto.minScore < 0 || dto.minScore > 100 || !Number.isFinite(dto.minScore))
    ) {
      throw new BadRequestException('minScore must be a number between 0 and 100');
    }

    if (typeof dto.lots === 'number' && (dto.lots <= 0 || !Number.isFinite(dto.lots))) {
      throw new BadRequestException('lots must be a positive finite number');
    }
  }

  /**
   * P1 #15: Create Bot with DTO Validation & Database Persistence
   */
  async createBot(dto: Partial<IAlgoBot>): Promise<IAlgoBot> {
    const symbol = (dto.symbol || 'NIFTY').toUpperCase().trim();
    this.validateBotConfig({ ...dto, symbol });

    const newBot: IAlgoBot = {
      id: `bot_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      name: dto.name || `${symbol} Custom SMC Bot`,
      symbol,
      direction: dto.direction || 'ANY',
      timeframe: this.normalizeTimeframe(dto.timeframe),
      minScore: Number(dto.minScore || 80),
      smcCondition: dto.smcCondition || 'ANY_CONFLUENCE',
      lots: Number(dto.lots || 1),
      autoExecutePaper: dto.autoExecutePaper === true,
      notifyWebhook: dto.notifyWebhook !== false,
      isActive: dto.isActive === true,
      createdAt: new Date().toISOString(),
      triggerCount: 0,
    };

    if (this.prisma) {
      try {
        await this.prisma.algoBot.create({
          data: {
            id: newBot.id,
            name: newBot.name,
            symbol: newBot.symbol,
            direction: newBot.direction as any,
            timeframe: newBot.timeframe,
            minScore: newBot.minScore,
            smcCondition: newBot.smcCondition as any,
            lots: newBot.lots,
            autoExecutePaper: newBot.autoExecutePaper,
            notifyWebhook: newBot.notifyWebhook,
            isActive: newBot.isActive,
            triggerCount: 0,
          },
        });
      } catch (err: any) {
        this.logger.error(`Failed to persist new bot in DB: ${err.message}`);
      }
    }

    this.presetBots.unshift(newBot);
    this.logger.log(`✓ [ALGO BOT CREATED] '${newBot.name}' (${newBot.symbol} ${newBot.direction})`);
    return newBot;
  }

  async toggleBot(id: string): Promise<IAlgoBot> {
    let bot: IAlgoBot | undefined;
    if (this.prisma) {
      try {
        const existing = await this.prisma.algoBot.findUnique({ where: { id } });
        if (existing) {
          const updated = await this.prisma.algoBot.update({
            where: { id },
            data: { isActive: !existing.isActive },
          });
          bot = {
            id: updated.id,
            name: updated.name,
            symbol: updated.symbol,
            direction: updated.direction as any,
            timeframe: updated.timeframe,
            minScore: updated.minScore,
            smcCondition: updated.smcCondition as any,
            lots: updated.lots,
            autoExecutePaper: updated.autoExecutePaper,
            notifyWebhook: updated.notifyWebhook,
            isActive: updated.isActive,
            createdAt: updated.createdAt.toISOString(),
            triggerCount: updated.triggerCount,
          };
        }
      } catch {
        // Fallback to preset
      }
    }

    if (!bot) {
      bot = this.presetBots.find((b) => b.id === id);
      if (!bot) {
        throw new NotFoundException(`Bot '${id}' not found`);
      }
      bot.isActive = !bot.isActive;
    }

    this.logger.log(`✓ Bot '${bot.name}' is now ${bot.isActive ? 'ACTIVE' : 'PAUSED'}`);
    return bot;
  }

  async deleteBot(id: string): Promise<{ success: boolean }> {
    if (this.prisma) {
      try {
        await this.prisma.algoBot.delete({ where: { id } });
      } catch {
        // Fallback
      }
    }
    const index = this.presetBots.findIndex((b) => b.id === id);
    if (index !== -1) {
      this.presetBots.splice(index, 1);
    }
    return { success: true };
  }

  /**
   * Normalizes timeframes (e.g. 'M15' -> '15m', 'H1' -> '1h') for exact string comparison parity
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
   * P0 #7: Maximum Signal Age Policy
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
   * P0 #7: Signal Freshness Validation
   */
  public validateSignalFreshness(
    signal: ISignalSetup,
    asOfTimestamp: Date = new Date(),
  ): IStrategyMatchResult {
    const timestampRaw = signal.timestamp || signal.createdAt;
    if (!timestampRaw) {
      return { matches: false, reasonCode: 'SIGNAL_MISSING_TIMESTAMP', details: 'Signal lacks valid timestamp' };
    }

    const signalTime = new Date(timestampRaw).getTime();
    if (Number.isNaN(signalTime)) {
      return { matches: false, reasonCode: 'SIGNAL_INVALID_TIMESTAMP', details: 'Signal timestamp is invalid/NaN' };
    }

    const asOfMs = asOfTimestamp.getTime();

    // Reject future timestamps (> 5000ms ahead of asOfTimestamp)
    if (signalTime > asOfMs + 5000) {
      return {
        matches: false,
        reasonCode: 'SIGNAL_FUTURE',
        details: `Signal timestamp (${new Date(signalTime).toISOString()}) is in the future`,
      };
    }

    const maxAgeMs = this.getMaxSignalAgeMs(signal.timeframe);
    const ageMs = asOfMs - signalTime;

    if (ageMs > maxAgeMs) {
      return {
        matches: false,
        reasonCode: 'SIGNAL_STALE',
        details: `Signal age (${Math.round(ageMs / 1000)}s) exceeds max allowed age (${Math.round(maxAgeMs / 1000)}s) for ${signal.timeframe}`,
      };
    }

    return { matches: true };
  }

  /**
   * P0 #4: Authoritative Order Quantity Resolution (No hardcoded multipliers)
   */
  public resolveBotOrderQuantity(bot: IAlgoBot, instrument: IInstrument): number {
    if (!bot || typeof bot.lots !== 'number' || !Number.isFinite(bot.lots) || bot.lots <= 0) {
      throw new Error(`INVALID_BOT_LOTS: Bot '${bot?.id}' has invalid lots: ${bot?.lots}`);
    }
    if (!instrument) {
      throw new Error('INVALID_INSTRUMENT: Cannot resolve order quantity for undefined instrument');
    }

    const lotSize = Number(instrument.lotSize || 1);
    const minQty = Number(instrument.minimumQuantity || lotSize || 1);
    const precision = typeof instrument.quantityPrecision === 'number' ? instrument.quantityPrecision : 0;

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
   * P0 #5: Canonical SMC Condition Evidence Matching
   */
  public matchesSmcCondition(
    condition: 'ORDER_BLOCK' | 'FVG' | 'LIQUIDITY_SWEEP' | 'ANY_CONFLUENCE',
    signal: ISignalSetup,
  ): boolean {
    const evidence = signal.triggerEvidence;

    if (condition === 'ORDER_BLOCK') {
      return evidence?.orderBlock?.matched === true;
    }

    if (condition === 'FVG') {
      return evidence?.fvg?.matched === true;
    }

    if (condition === 'LIQUIDITY_SWEEP') {
      return evidence?.liquiditySweep?.matched === true;
    }

    if (condition === 'ANY_CONFLUENCE') {
      if (!evidence) {
        // Fallback for signals constructed without triggerEvidence: check if any trigger is present
        const breakdown = signal.scoreBreakdown || {};
        return (
          Number(breakdown.orderBlock || 0) > 0 ||
          Number(breakdown.fvg || 0) > 0 ||
          Number(breakdown.liquiditySweep || 0) > 0
        );
      }
      return (
        evidence.orderBlock?.matched === true ||
        evidence.fvg?.matched === true ||
        evidence.liquiditySweep?.matched === true ||
        evidence.structureBreak?.matched === true
      );
    }

    return false;
  }

  /**
   * P0 #1 & P0 #5: Authoritative Strategy Condition Matching
   */
  public matchesBotStrategy(bot: IAlgoBot, signal: ISignalSetup): IStrategyMatchResult {
    if (!bot || !signal) {
      return { matches: false, reasonCode: 'INVALID_SIGNAL', details: 'Bot or signal is missing' };
    }

    // 1. Symbol Match
    if (!signal.symbol || bot.symbol.toUpperCase() !== signal.symbol.toUpperCase()) {
      return {
        matches: false,
        reasonCode: 'SYMBOL_MISMATCH',
        details: `Bot symbol '${bot.symbol}' !== signal symbol '${signal.symbol}'`,
      };
    }

    // 2. Exact Timeframe Match
    const botTf = this.normalizeTimeframe(bot.timeframe);
    const signalTf = this.normalizeTimeframe(signal.timeframe);
    if (botTf !== signalTf) {
      return {
        matches: false,
        reasonCode: 'TIMEFRAME_MISMATCH',
        details: `Bot timeframe '${bot.timeframe}' (${botTf}) !== signal timeframe '${signal.timeframe}' (${signalTf})`,
      };
    }

    // 3. Direction Match
    if (bot.direction !== 'ANY' && bot.direction !== signal.direction) {
      return {
        matches: false,
        reasonCode: 'DIRECTION_MISMATCH',
        details: `Bot direction '${bot.direction}' !== signal direction '${signal.direction}'`,
      };
    }

    // 4. Min Score Threshold
    if (typeof signal.score !== 'number' || signal.score < bot.minScore) {
      return {
        matches: false,
        reasonCode: 'SCORE_BELOW_THRESHOLD',
        details: `Signal score (${signal.score}) < bot minScore (${bot.minScore})`,
      };
    }

    // 5. Canonical SMC Condition Evidence Match
    if (!this.matchesSmcCondition(bot.smcCondition, signal)) {
      return {
        matches: false,
        reasonCode: 'SMC_CONDITION_MISMATCH',
        details: `Signal does not satisfy canonical SMC trigger evidence for '${bot.smcCondition}'`,
      };
    }

    return { matches: true };
  }

  /**
   * P0 #6 & P1 #9: Complete Trade-Level & Signal Eligibility Validation
   */
  public validateExecutionEligibility(bot: IAlgoBot, signal: ISignalSetup): IStrategyMatchResult {
    if (!bot.isActive) {
      return { matches: false, reasonCode: 'BOT_INACTIVE', details: `Bot '${bot.id}' is inactive/paused` };
    }

    // P0 #6: Require signal.state === SignalState.ACTIVE
    if (!signal.state || signal.state !== SignalState.ACTIVE) {
      return {
        matches: false,
        reasonCode: 'SIGNAL_NOT_ACTIVE',
        details: `Signal state '${signal.state}' is not ACTIVE`,
      };
    }

    if (
      !signal.direction ||
      signal.direction === ('NEUTRAL' as any) ||
      signal.direction === ('NO_TRADE' as any)
    ) {
      return { matches: false, reasonCode: 'INVALID_SIGNAL', details: `Signal direction '${signal.direction}' is NEUTRAL or NO_TRADE` };
    }

    if (signal.grade === ('NO_TRADE' as any)) {
      return { matches: false, reasonCode: 'INVALID_SIGNAL', details: `Signal grade is NO_TRADE` };
    }

    // P0 #7: Signal Freshness Validation
    const freshness = this.validateSignalFreshness(signal);
    if (!freshness.matches) {
      return freshness;
    }

    // P1 #9: Validate all required trade levels
    const optimalEntry = signal.entryZone?.optimal;
    const stopLoss = signal.stopLoss;
    const tp1 = signal.takeProfits?.tp1;
    const tp2 = signal.takeProfits?.tp2;
    const tp3 = signal.takeProfits?.tp3;

    if (typeof signal.score !== 'number' || !Number.isFinite(signal.score) || signal.score <= 0) {
      return { matches: false, reasonCode: 'INVALID_LEVELS', details: 'Signal score must be a positive finite number' };
    }

    if (
      typeof optimalEntry !== 'number' || !Number.isFinite(optimalEntry) || optimalEntry <= 0 ||
      typeof stopLoss !== 'number' || !Number.isFinite(stopLoss) || stopLoss <= 0 ||
      typeof tp1 !== 'number' || !Number.isFinite(tp1) || tp1 <= 0 ||
      typeof tp2 !== 'number' || !Number.isFinite(tp2) || tp2 <= 0 ||
      typeof tp3 !== 'number' || !Number.isFinite(tp3) || tp3 <= 0
    ) {
      return { matches: false, reasonCode: 'INVALID_LEVELS', details: 'Incomplete or non-finite entry/SL/TP levels' };
    }

    const riskDistance = Math.abs(optimalEntry - stopLoss);
    if (!Number.isFinite(riskDistance) || riskDistance <= 0) {
      return { matches: false, reasonCode: 'INVALID_LEVELS', details: 'Invalid risk distance between entry and SL' };
    }

    if (signal.direction === 'BULLISH') {
      if (!(stopLoss < optimalEntry && optimalEntry < tp1 && tp1 <= tp2 && tp2 <= tp3)) {
        return {
          matches: false,
          reasonCode: 'INVALID_LEVELS',
          details: `Invalid BULLISH target orientation. SL (${stopLoss}) < entry (${optimalEntry}) < TP1 (${tp1}) <= TP2 (${tp2}) <= TP3 (${tp3})`,
        };
      }
    } else if (signal.direction === 'BEARISH') {
      if (!(stopLoss > optimalEntry && optimalEntry > tp1 && tp1 >= tp2 && tp2 >= tp3)) {
        return {
          matches: false,
          reasonCode: 'INVALID_LEVELS',
          details: `Invalid BEARISH target orientation. SL (${stopLoss}) > entry (${optimalEntry}) > TP1 (${tp1}) >= TP2 (${tp2}) >= TP3 (${tp3})`,
        };
      }
    }

    return { matches: true };
  }

  /**
   * P0 #8: Canonical Decision Fingerprint Generator
   */
  public getSignalFingerprint(bot: IAlgoBot, signal: ISignalSetup): string {
    const timestampRaw = signal.timestamp || signal.createdAt || new Date();
    const signalTimeMs = new Date(timestampRaw).getTime();
    const normTf = this.normalizeTimeframe(signal.timeframe);
    const normSymbol = bot.symbol.toUpperCase();
    const normDir = signal.direction;

    const tfMs = this.getMaxSignalAgeMs(normTf);
    const canonicalCandleBoundaryMs = Math.floor(signalTimeMs / tfMs) * tfMs;

    return `bot_exec:${bot.id}:${normSymbol}:${normTf}:${normDir}:${canonicalCandleBoundaryMs}`;
  }

  /**
   * P0 #1: True Atomic Execution Reservation via PostgreSQL `@unique(fingerprint)`
   */
  public async reserveExecutionLock(
    bot: IAlgoBot,
    signal: ISignalSetup,
    fingerprint: string,
  ): Promise<{ success: boolean; executionId?: string }> {
    if (this.inMemoryLocks.has(fingerprint)) {
      return { success: false };
    }

    const signalTimestamp = signal.timestamp || signal.createdAt || new Date();

    if (this.prisma) {
      try {
        const execution = await this.prisma.algoBotExecution.create({
          data: {
            fingerprint,
            botId: bot.id,
            symbol: bot.symbol.toUpperCase(),
            timeframe: this.normalizeTimeframe(bot.timeframe),
            direction: signal.direction as any,
            signalId: signal.id || null,
            signalTimestamp: new Date(signalTimestamp),
            state: 'RESERVED',
            correlationId: fingerprint,
          },
        });

        this.inMemoryLocks.add(fingerprint);
        return { success: true, executionId: execution.id };
      } catch (err: any) {
        if (err?.code === 'P2002') {
          const existing = await this.prisma.algoBotExecution.findUnique({
            where: { fingerprint },
          });

          if (existing && existing.state === 'FAILED_RETRYABLE') {
            const updated = await this.prisma.algoBotExecution.update({
              where: { id: existing.id },
              data: {
                state: 'RESERVED',
                failureReason: null,
                failedAt: null,
                updatedAt: new Date(),
              },
            });
            this.inMemoryLocks.add(fingerprint);
            return { success: true, executionId: updated.id };
          }

          this.inMemoryLocks.add(fingerprint);
          return { success: false };
        }

        // Fail closed if DB fails and Redis is unavailable
        if (this.redis) {
          const client = this.redis.getClient();
          if (client && client.status === 'ready') {
            try {
              const res = await client.set(`lock:${fingerprint}`, 'RESERVED', 'EX', 86400, 'NX');
              if (res === 'OK') {
                this.inMemoryLocks.add(fingerprint);
                return { success: true };
              }
            } catch {
              // Fail closed
            }
          }
        }

        return { success: false };
      }
    }

    // Redis optimization fallback
    if (this.redis) {
      const client = this.redis.getClient();
      if (client && client.status === 'ready') {
        try {
          const res = await client.set(`lock:${fingerprint}`, 'RESERVED', 'EX', 86400, 'NX');
          if (res === 'OK') {
            this.inMemoryLocks.add(fingerprint);
            return { success: true };
          }
        } catch {
          return { success: false };
        }
      }
    }

    // Fallback for isolated unit tests when neither DB nor Redis service is injected
    if (!this.prisma && !this.redis) {
      this.inMemoryLocks.add(fingerprint);
      return { success: true, executionId: `test_exec_${fingerprint}` };
    }

    return { success: false };
  }

  /**
   * P0 #2: State Machine Lifecycle Method — Mark Started
   */
  public async markExecutionStarted(executionId: string): Promise<void> {
    if (this.prisma && executionId) {
      try {
        await this.prisma.algoBotExecution.update({
          where: { id: executionId },
          data: {
            state: 'EXECUTING',
            startedAt: new Date(),
          },
        });
      } catch {
        // ignore
      }
    }
  }

  /**
   * P0 #2: State Machine Lifecycle Method — Mark Executed
   */
  public async markExecutionExecuted(executionId: string, orderPositionId?: string): Promise<void> {
    if (this.prisma && executionId) {
      try {
        await this.prisma.algoBotExecution.update({
          where: { id: executionId },
          data: {
            state: 'EXECUTED',
            orderPositionId: orderPositionId || null,
            completedAt: new Date(),
          },
        });
      } catch {
        // ignore
      }
    }
  }

  /**
   * P0 #2: State Machine Lifecycle Method — Mark Failed (Retryable vs Final)
   */
  public async markExecutionFailed(executionId: string, err: any): Promise<void> {
    if (!this.prisma || !executionId) return;

    let isRetryable = false;
    if (
      err instanceof MarketDataUnavailableError ||
      err instanceof StaleMarketDataError ||
      err?.name === 'MarketDataUnavailableError' ||
      err?.name === 'StaleMarketDataError' ||
      err?.message?.includes('MarketDataUnavailableError') ||
      err?.message?.includes('StaleMarketDataError') ||
      err?.message?.includes('streamer') ||
      err?.message?.includes('timeout') ||
      err?.message?.includes('network')
    ) {
      isRetryable = true;
    }

    const state = isRetryable ? 'FAILED_RETRYABLE' : 'FAILED_FINAL';
    const failureReason = err?.message || String(err);

    try {
      await this.prisma.algoBotExecution.update({
        where: { id: executionId },
        data: {
          state,
          failedAt: new Date(),
          failureReason,
        },
      });

      if (isRetryable) {
        const ex = await this.prisma.algoBotExecution.findUnique({ where: { id: executionId } });
        if (ex) {
          this.inMemoryLocks.delete(ex.fingerprint);
        }
      }
    } catch {
      // ignore
    }
  }

  private async recordBotTrigger(botId: string, signal: ISignalSetup): Promise<void> {
    const details = `${signal.direction} Trigger @ ₹${signal.entryZone.optimal.toFixed(2)} (Score: ${signal.score}/100)`;
    if (this.prisma) {
      try {
        await this.prisma.algoBot.update({
          where: { id: botId },
          data: {
            triggerCount: { increment: 1 },
            lastTriggeredAt: new Date(),
            lastTriggerDetails: details,
          },
        });
      } catch {
        // ignore
      }
    }
  }

  /**
   * Evaluates incoming signal against all active bot strategies
   */
  async evaluateSignalForBots(signal: ISignalSetup) {
    const bots = await this.listBots();

    for (const bot of bots) {
      // 1. Validate Bot Active & Signal Eligibility (ACTIVE state, trade levels, freshness)
      const eligibility = this.validateExecutionEligibility(bot, signal);
      if (!eligibility.matches) {
        if (!bot.isActive) {
          this.logger.debug(`[REJECTED: BOT_INACTIVE] Bot '${bot.id}' is inactive/paused`);
        } else {
          this.logger.warn(
            `[REJECTED: ${eligibility.reasonCode}] Bot '${bot.id}' rejected signal ${signal.symbol}: ${eligibility.details}`,
          );
        }
        continue;
      }

      // 2. Authoritative Strategy Matching (Symbol, Timeframe, Direction, MinScore, Canonical SMC Evidence)
      const match = this.matchesBotStrategy(bot, signal);
      if (!match.matches) {
        this.logger.debug(
          `[REJECTED: ${match.reasonCode}] Bot '${bot.id}' rejected signal ${signal.symbol} ${signal.direction}: ${match.details}`,
        );
        continue;
      }

      // P0 #3: NEVER RESERVE BEFORE autoExecutePaper CHECK
      if (!bot.autoExecutePaper) {
        this.logger.debug(`[AUTO_EXECUTE_DISABLED] Bot '${bot.id}' has autoExecutePaper=false`);
        await this.recordBotTrigger(bot.id, signal);
        continue;
      }

      // 3. P0 #4: Resolve Order Quantity via Authoritative Instrument Registry
      let quantity: number;
      try {
        const instrument = getAuthoritativeInstrument(bot.symbol);
        quantity = this.resolveBotOrderQuantity(bot, instrument);
      } catch (err: any) {
        this.logger.error(
          `[REJECTED: INVALID_QUANTITY] Failed to resolve order quantity for bot '${bot.id}': ${err.message}`,
        );
        continue;
      }

      // 4. P0 #1: Compute Fingerprint & Reserve Execution Lock via Database `@unique` constraint
      const fingerprint = this.getSignalFingerprint(bot, signal);
      const reservation = await this.reserveExecutionLock(bot, signal, fingerprint);

      if (!reservation.success || !reservation.executionId) {
        this.logger.warn(
          `[REJECTED: EXECUTION_LOCKED] Duplicate signal or execution lock already held for fingerprint: ${fingerprint}`,
        );
        continue;
      }

      const executionId = reservation.executionId;
      await this.recordBotTrigger(bot.id, signal);

      // 5. P0 #2: Execution State Machine Lifecycle Management
      try {
        await this.markExecutionStarted(executionId);

        // P1 #10: Revalidate Live Market Data Freshness
        try {
          await this.paperTradingService.getValidatedMarketPrice(bot.symbol, 5);
        } catch (err: any) {
          this.logger.error(
            `[REJECTED: MARKET_DATA_UNAVAILABLE] Live market data unavailable for symbol '${bot.symbol}': ${err.message}`,
          );
          await this.markExecutionFailed(executionId, err);
          continue;
        }

        // P1 #11: Secondary Position Check
        const portfolio = await this.paperTradingService.getPortfolio();
        const alreadyOpen = portfolio.openPositions.some((p) => p.symbol === bot.symbol);
        if (alreadyOpen) {
          this.logger.warn(
            `[REJECTED: POSITION_ALREADY_OPEN] Open position already exists for symbol '${bot.symbol}'`,
          );
          const posErr = new Error('POSITION_ALREADY_OPEN');
          await this.markExecutionFailed(executionId, posErr);
          continue;
        }

        const orderResult = await this.paperTradingService.placeOrder({
          symbol: bot.symbol,
          direction: signal.direction === 'BULLISH' ? 'BUY' : 'SELL',
          quantity,
          orderType: 'MARKET',
          signalPrice: signal.entryZone.optimal,
          signalTime: signal.timestamp ? new Date(signal.timestamp).toISOString() : undefined,
          stopLoss: signal.stopLoss,
          target1: signal.takeProfits.tp1,
          target2: signal.takeProfits.tp2,
          target3: signal.takeProfits.tp3,
          idempotencyKey: fingerprint,
          correlationId: fingerprint,
        });

        await this.markExecutionExecuted(executionId, orderResult.id);

        this.logger.log(
          `✓ [BOT ORDER EXECUTED] Bot '${bot.id}' placed order for ${bot.symbol} ${signal.direction} | Qty: ${quantity} | Fingerprint: ${fingerprint} | Fill Price: ₹${orderResult.entryPrice} (Planned Entry: ₹${signal.entryZone.optimal}) | PositionID: ${orderResult.id}`,
        );
      } catch (e: any) {
        this.logger.error(`[BOT EXECUTION ERROR] Bot '${bot.id}' order placement failed: ${e.message}`);
        await this.markExecutionFailed(executionId, e);
      }
    }
  }
}
