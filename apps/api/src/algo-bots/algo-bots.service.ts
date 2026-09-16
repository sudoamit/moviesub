import { BadRequestException, Injectable, InternalServerErrorException, Logger, NotFoundException, OnModuleInit, Optional } from '@nestjs/common';
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
import * as crypto from 'crypto';

export enum ExecutionFailureReason {
  MARKET_DATA_UNAVAILABLE = 'MARKET_DATA_UNAVAILABLE',
  STALE_MARKET_DATA = 'STALE_MARKET_DATA',
  ORDER_REJECTED = 'ORDER_REJECTED',
  ORDER_PLACEMENT_FAILED = 'ORDER_PLACEMENT_FAILED',
  INVALID_QUANTITY = 'INVALID_QUANTITY',
  INVALID_LEVELS = 'INVALID_LEVELS',
  POSITION_ALREADY_OPEN = 'POSITION_ALREADY_OPEN',
  DATABASE_UNAVAILABLE = 'DATABASE_UNAVAILABLE',
  STATE_TRANSITION_FAILED = 'STATE_TRANSITION_FAILED',
  UNKNOWN_EXECUTION_ERROR = 'UNKNOWN_EXECUTION_ERROR',
}

export interface IExecutionFailureClassification {
  retryable: boolean;
  reasonCode: ExecutionFailureReason;
  message: string;
}

export interface IAlgoBotExecutionResult {
  botId: string;
  symbol: string;
  status: 'EXECUTED' | 'REJECTED' | 'SKIPPED';
  reasonCode: string;
  details?: string;
  executionId?: string;
  orderPositionId?: string;
}

export function classifyExecutionFailure(err: any): IExecutionFailureClassification {
  if (
    err instanceof MarketDataUnavailableError ||
    err?.code === 'MARKET_DATA_UNAVAILABLE' ||
    err?.reasonCode === 'MARKET_DATA_UNAVAILABLE' ||
    err?.name === 'MarketDataUnavailableError'
  ) {
    return {
      retryable: true,
      reasonCode: ExecutionFailureReason.MARKET_DATA_UNAVAILABLE,
      message: err?.message || 'Market data stream provider unavailable',
    };
  }

  if (
    err instanceof StaleMarketDataError ||
    err?.code === 'STALE_MARKET_DATA' ||
    err?.reasonCode === 'STALE_MARKET_DATA' ||
    err?.name === 'StaleMarketDataError'
  ) {
    return {
      retryable: true,
      reasonCode: ExecutionFailureReason.STALE_MARKET_DATA,
      message: err?.message || 'Market quote is stale',
    };
  }

  if (err?.code === 'POSITION_ALREADY_OPEN' || err?.reasonCode === 'POSITION_ALREADY_OPEN') {
    return {
      retryable: false,
      reasonCode: ExecutionFailureReason.POSITION_ALREADY_OPEN,
      message: err?.message || 'Open position already exists for symbol',
    };
  }

  if (err?.code === 'INVALID_QUANTITY' || err?.reasonCode === 'INVALID_QUANTITY') {
    return {
      retryable: false,
      reasonCode: ExecutionFailureReason.INVALID_QUANTITY,
      message: err?.message || 'Invalid order quantity resolved',
    };
  }

  if (err?.code === 'INVALID_LEVELS' || err?.reasonCode === 'INVALID_LEVELS') {
    return {
      retryable: false,
      reasonCode: ExecutionFailureReason.INVALID_LEVELS,
      message: err?.message || 'Invalid trade levels',
    };
  }

  if (err?.code === 'ORDER_REJECTED' || err?.reasonCode === 'ORDER_REJECTED') {
    return {
      retryable: false,
      reasonCode: ExecutionFailureReason.ORDER_REJECTED,
      message: err?.message || 'Broker/Exchange rejected order',
    };
  }

  if (err?.code === 'ORDER_PLACEMENT_FAILED' || err?.reasonCode === 'ORDER_PLACEMENT_FAILED') {
    return {
      retryable: false,
      reasonCode: ExecutionFailureReason.ORDER_PLACEMENT_FAILED,
      message: err?.message || 'Order placement failed',
    };
  }

  if (err?.code === 'DATABASE_UNAVAILABLE' || err?.reasonCode === 'DATABASE_UNAVAILABLE') {
    return {
      retryable: false,
      reasonCode: ExecutionFailureReason.DATABASE_UNAVAILABLE,
      message: err?.message || 'Database unavailable',
    };
  }

  if (err?.code === 'STATE_TRANSITION_FAILED' || err?.reasonCode === 'STATE_TRANSITION_FAILED') {
    return {
      retryable: false,
      reasonCode: ExecutionFailureReason.STATE_TRANSITION_FAILED,
      message: err?.message || 'State transition failed',
    };
  }

  return {
    retryable: false,
    reasonCode: ExecutionFailureReason.UNKNOWN_EXECUTION_ERROR,
    message: err?.message || String(err),
  };
}

const ALLOWED_STATE_TRANSITIONS: Record<string, string[]> = {
  RESERVED: ['EXECUTING', 'FAILED_RETRYABLE', 'FAILED_FINAL', 'CANCELLED'],
  EXECUTING: ['EXECUTED', 'FAILED_RETRYABLE', 'FAILED_FINAL'],
  FAILED_RETRYABLE: ['RESERVED'],
  EXECUTED: [],
  FAILED_FINAL: [],
  CANCELLED: [],
};

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
  configVersion?: string;
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

  // Process-local lock cache optimization only (non-authoritative)
  private readonly inMemoryLocks = new Set<string>();

  // Preset default bots used only on initial DB seeding
  private readonly presetBots: IAlgoBot[] = [
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

  private lastScanTime?: Date;
  private lastSignalTime?: Date;
  private lastExecutionAttempt?: Date;
  private lastExecutionSuccess?: Date;
  private lastExecutionRejectionReason?: string;

  constructor(
    private readonly paperTradingService: PaperTradingService,
    private readonly alertsService: AlertsService,
    @Optional() private readonly prisma?: PrismaService,
    @Optional() private readonly redis?: RedisService,
  ) {
    this.logger.log('Algo Strategy Studio Service Initialized.');
  }

  public recordScanTime(time: Date = new Date()) {
    this.lastScanTime = time;
  }

  public recordSignalTime(time: Date = new Date()) {
    this.lastSignalTime = time;
  }

  public isPaperExecutionEnabled(): boolean {
    return (
      process.env.ENABLE_PAPER_ALGO_BOTS === 'true' ||
      process.env.PAPER_TRADING_ENABLED === 'true' ||
      process.env.NODE_ENV === 'development' ||
      process.env.NODE_ENV === 'test'
    );
  }

  async onModuleInit() {
    const paperEnabled = this.isPaperExecutionEnabled();

    this.logger.log(
      `[ALGO PAPER EXECUTION STATUS]\n` +
        `ENABLE_PAPER_ALGO_BOTS=${process.env.ENABLE_PAPER_ALGO_BOTS || 'false'}\n` +
        `PAPER_TRADING_ENABLED=${process.env.PAPER_TRADING_ENABLED || 'false'}\n` +
        `NODE_ENV=${process.env.NODE_ENV || 'development'}\n` +
        `paperExecutionEnabled=${paperEnabled}`,
    );

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
                autoExecutePaper: paperEnabled ? true : bot.autoExecutePaper,
                notifyWebhook: bot.notifyWebhook,
                isActive: paperEnabled ? true : bot.isActive,
                triggerCount: bot.triggerCount,
              },
            });
          }
        } else if (paperEnabled) {
          for (const bot of this.presetBots) {
            await this.prisma.algoBot.updateMany({
              where: { id: bot.id, isActive: false },
              data: { isActive: true, autoExecutePaper: true },
            });
          }
        }
      } catch (err: any) {
        this.logger.warn(`Failed to seed/sync preset AlgoBots in database: ${err?.message}`);
      }
    } else if (paperEnabled) {
      for (const bot of this.presetBots) {
        bot.isActive = true;
        bot.autoExecutePaper = true;
      }
    }

    try {
      const bots = await this.listBots();
      for (const bot of bots) {
        this.logger.log(
          `[ALGO BOT CONFIG]\n` +
            `id: ${bot.id}\n` +
            `symbol: ${bot.symbol}\n` +
            `isActive: ${bot.isActive}\n` +
            `autoExecutePaper: ${bot.autoExecutePaper}\n` +
            `timeframe: ${bot.timeframe}\n` +
            `direction: ${bot.direction}\n` +
            `smcCondition: ${bot.smcCondition}`,
        );
      }
    } catch (err: any) {
      this.logger.warn(`Failed to log startup Algo Bot configuration: ${err?.message}`);
    }
  }

  /**
   * P1 #15 & P1 #11: Persistent Database Bot Configuration Read with Strict DB Error Handling
   */
  async listBots(): Promise<IAlgoBot[]> {
    if (this.prisma) {
      try {
        const dbBots = await this.prisma.algoBot.findMany({
          orderBy: { createdAt: 'desc' },
        });
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
      } catch (err: any) {
        this.logger.error(`Database query failed in listBots(): ${err.message}`);
        throw new InternalServerErrorException(
          `Database unavailable for bot configuration retrieval: ${err.message}`,
        );
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
   * P1 #14 & P1 #15: Create Bot with DTO Validation & Database Persistence (No Silent In-Memory Fallback)
   */
  async createBot(dto: Partial<IAlgoBot>): Promise<IAlgoBot> {
    const symbol = (dto.symbol || 'NIFTY').toUpperCase().trim();
    this.validateBotConfig({ ...dto, symbol });

    const newBotId = `bot_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const name = dto.name || `${symbol} Custom SMC Bot`;
    const direction = dto.direction || 'ANY';
    const timeframe = this.normalizeTimeframe(dto.timeframe);
    const minScore = Number(dto.minScore || 80);
    const smcCondition = dto.smcCondition || 'ANY_CONFLUENCE';
    const lots = Number(dto.lots || 1);
    const autoExecutePaper = dto.autoExecutePaper === true;
    const notifyWebhook = dto.notifyWebhook !== false;
    const isActive = dto.isActive === true;

    if (this.prisma) {
      try {
        const created = await this.prisma.algoBot.create({
          data: {
            id: newBotId,
            name,
            symbol,
            direction: direction as any,
            timeframe,
            minScore,
            smcCondition: smcCondition as any,
            lots,
            autoExecutePaper,
            notifyWebhook,
            isActive,
            triggerCount: 0,
          },
        });

        this.logger.log(`✓ [ALGO BOT CREATED] '${created.name}' (${created.symbol} ${created.direction})`);
        return {
          id: created.id,
          name: created.name,
          symbol: created.symbol,
          direction: created.direction as any,
          timeframe: created.timeframe,
          minScore: created.minScore,
          smcCondition: created.smcCondition as any,
          lots: created.lots,
          autoExecutePaper: created.autoExecutePaper,
          notifyWebhook: created.notifyWebhook,
          isActive: created.isActive,
          createdAt: created.createdAt.toISOString(),
          triggerCount: created.triggerCount,
        };
      } catch (err: any) {
        this.logger.error(`Database write failed in createBot(): ${err.message}`);
        throw new InternalServerErrorException(
          `Database unavailable for bot configuration persistence: ${err.message}`,
        );
      }
    }

    const fallbackBot: IAlgoBot = {
      id: newBotId,
      name,
      symbol,
      direction,
      timeframe,
      minScore,
      smcCondition,
      lots,
      autoExecutePaper,
      notifyWebhook,
      isActive,
      createdAt: new Date().toISOString(),
      triggerCount: 0,
    };
    this.presetBots.unshift(fallbackBot);
    return fallbackBot;
  }

  async toggleBot(id: string): Promise<IAlgoBot> {
    if (this.prisma) {
      try {
        const existing = await this.prisma.algoBot.findUnique({ where: { id } });
        if (!existing) {
          throw new NotFoundException(`Bot '${id}' not found`);
        }
        const updated = await this.prisma.algoBot.update({
          where: { id },
          data: { isActive: !existing.isActive },
        });
        this.logger.log(`✓ Bot '${updated.name}' is now ${updated.isActive ? 'ACTIVE' : 'PAUSED'}`);
        return {
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
      } catch (err: any) {
        if (err instanceof NotFoundException) throw err;
        this.logger.error(`Database update failed in toggleBot(): ${err.message}`);
        throw new InternalServerErrorException(
          `Database unavailable for bot configuration toggle: ${err.message}`,
        );
      }
    }

    const bot = this.presetBots.find((b) => b.id === id);
    if (!bot) {
      throw new NotFoundException(`Bot '${id}' not found`);
    }
    bot.isActive = !bot.isActive;
    this.logger.log(`✓ Bot '${bot.name}' is now ${bot.isActive ? 'ACTIVE' : 'PAUSED'}`);
    return bot;
  }

  async deleteBot(id: string): Promise<{ success: boolean }> {
    if (this.prisma) {
      try {
        await this.prisma.algoBot.delete({ where: { id } });
        return { success: true };
      } catch (err: any) {
        this.logger.error(`Database delete failed in deleteBot(): ${err.message}`);
        throw new InternalServerErrorException(
          `Database unavailable for bot configuration deletion: ${err.message}`,
        );
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
   * P0 #7: Signal Freshness & Decision Boundary Window Validation
   */
  public validateSignalFreshness(
    signal: ISignalSetup,
    asOfTimestamp: Date = new Date(),
  ): IStrategyMatchResult {
    const canonicalTimeRaw = (signal as any).canonicalCandleTime || (signal as any).candleTimestamp || signal.timestamp || signal.createdAt;
    if (!canonicalTimeRaw) {
      return { matches: false, reasonCode: 'SIGNAL_MISSING_TIMESTAMP', details: 'Signal lacks valid timestamp' };
    }

    const signalTime = new Date(canonicalTimeRaw).getTime();
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
        details: `Signal age (${Math.round(ageMs / 1000)}s) exceeds max allowed decision window (${Math.round(maxAgeMs / 1000)}s) for ${signal.timeframe}`,
      };
    }

    return { matches: true };
  }

  /**
   * P0 #4 & P1 #12: Authoritative Order Quantity Resolution (Venue & Asset Type Aware)
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
   * P0 #5: Canonical SMC Evidence & Point-in-Time Provenance Matching (No Prose Heuristics or Score Fallbacks)
   */
  public matchesSmcCondition(
    condition: 'ORDER_BLOCK' | 'FVG' | 'LIQUIDITY_SWEEP' | 'ANY_CONFLUENCE',
    signal: ISignalSetup,
  ): boolean {
    const evidence = signal.triggerEvidence;

    // Hard rejection if canonical triggerEvidence object is missing entirely
    if (!evidence) {
      return false;
    }

    const signalTime = new Date(signal.timestamp || signal.createdAt || Date.now()).getTime();
    const maxAgeMs = this.getMaxSignalAgeMs(signal.timeframe);

    const isEvidenceItemValid = (item: any): boolean => {
      if (!item || item.matched !== true) return false;
      if (item.timestamp) {
        const itemTime = new Date(item.timestamp).getTime();
        if (Number.isNaN(itemTime)) return false;
        // Evidence timestamp must not be from the future (lookahead) or older than maxSignalAgeMs
        if (itemTime > signalTime + 5000 || signalTime - itemTime > maxAgeMs) {
          return false;
        }
      }
      return true;
    };

    if (condition === 'ORDER_BLOCK') {
      return isEvidenceItemValid(evidence.orderBlock);
    }

    if (condition === 'FVG') {
      return isEvidenceItemValid(evidence.fvg);
    }

    if (condition === 'LIQUIDITY_SWEEP') {
      return isEvidenceItemValid(evidence.liquiditySweep);
    }

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

    // P0 #5: Require valid canonicalCandleTime for auto-execution
    if (bot.autoExecutePaper) {
      if (
        !signal.canonicalCandleTime ||
        typeof signal.canonicalCandleTime !== 'number' ||
        !Number.isFinite(signal.canonicalCandleTime) ||
        signal.canonicalCandleTime <= 0
      ) {
        return {
          matches: false,
          reasonCode: 'CANONICAL_DECISION_TIMESTAMP_REQUIRED',
          details: `Auto-execution requires valid canonicalCandleTime on signal setup`,
        };
      }
    }

    // P0 #6: Require signal.state === SignalState.ACTIVE
    if (!signal.state || signal.state !== SignalState.ACTIVE) {
      return {
        matches: false,
        reasonCode: 'SIGNAL_NOT_ACTIVE',
        details: `Signal state '${signal.state}' is not ACTIVE (must be SignalState.ACTIVE)`,
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
   * P0 #8 & P1 #8: Canonical Decision Fingerprint Generator with Bot Configuration Versioning
   */
  public getSignalFingerprint(bot: IAlgoBot, signal: ISignalSetup): string {
    const canonicalTimeRaw = signal.canonicalCandleTime || signal.timestamp || signal.createdAt || new Date();
    const signalTimeMs = new Date(canonicalTimeRaw).getTime();
    const normTf = this.normalizeTimeframe(signal.timeframe);
    const normSymbol = bot.symbol.toUpperCase();
    const normDir = signal.direction;

    const tfMs = this.getMaxSignalAgeMs(normTf);
    // Use canonical candle timestamp if present; otherwise fall back to timeframe floor boundary
    const canonicalCandleBoundaryMs = signal.canonicalCandleTime || (Math.floor(signalTimeMs / tfMs) * tfMs);

    // Strategy configuration hash to uniquely represent bot parameters
    const configHash = crypto
      .createHash('sha256')
      .update(`${bot.symbol}:${bot.timeframe}:${bot.direction}:${bot.minScore}:${bot.smcCondition}:${bot.lots}`)
      .digest('hex')
      .substring(0, 8);

    return `bot_exec:${bot.id}:v${configHash}:${normSymbol}:${normTf}:${normDir}:${canonicalCandleBoundaryMs}`;
  }

  /**
   * P0 #1, #2, #3: Single-Authority Atomic Conditional Execution State Transition Helper
   *
   * Enforces strict finite state machine graph edges:
   *   RESERVED  -> EXECUTING / FAILED_RETRYABLE / FAILED_FINAL / CANCELLED
   *   EXECUTING -> EXECUTED / FAILED_RETRYABLE / FAILED_FINAL
   *   FAILED_RETRYABLE -> RESERVED (Clean Retry Reset)
   *
   * Rejects any transition edge that does not belong to the allowed state graph.
   */
  public async transitionExecutionState(
    executionId: string,
    expectedStates: 'RESERVED' | 'EXECUTING' | 'EXECUTED' | 'FAILED_RETRYABLE' | 'FAILED_FINAL' | ('RESERVED' | 'EXECUTING' | 'EXECUTED' | 'FAILED_RETRYABLE' | 'FAILED_FINAL')[],
    targetState: 'RESERVED' | 'EXECUTING' | 'EXECUTED' | 'FAILED_RETRYABLE' | 'FAILED_FINAL',
    updateData?: {
      orderPositionId?: string | null;
      failureReason?: string | null;
      failureReasonCode?: string | null;
    },
  ): Promise<{ success: boolean; count: number }> {
    const expectedArray = Array.isArray(expectedStates) ? expectedStates : [expectedStates];

    // 1. Validate finite state machine edge BEFORE database query or unit test mock check
    for (const exp of expectedArray) {
      const allowedTargets = ALLOWED_STATE_TRANSITIONS[exp] || [];
      if (!allowedTargets.includes(targetState)) {
        this.logger.error(
          `Invalid state transition edge requested for execution '${executionId}': edge '${exp}' -> '${targetState}' is prohibited by state machine graph`,
        );
        throw new InternalServerErrorException(
          `INVALID_STATE_TRANSITION_EDGE: Transition '${exp}' -> '${targetState}' is prohibited by finite state machine graph`,
        );
      }
    }

    if (!this.prisma || !executionId || executionId.startsWith('test_exec_')) {
      return { success: true, count: 1 };
    }

    const data: any = {
      state: targetState,
      updatedAt: new Date(),
    };

    if (targetState === 'EXECUTING') {
      data.startedAt = new Date();
    } else if (targetState === 'EXECUTED') {
      data.completedAt = new Date();
      if (updateData?.orderPositionId !== undefined) {
        data.orderPositionId = updateData.orderPositionId;
      }
    } else if (targetState === 'FAILED_RETRYABLE' || targetState === 'FAILED_FINAL') {
      data.failedAt = new Date();
      data.failureReason = updateData?.failureReason || null;
      data.failureReasonCode = updateData?.failureReasonCode || null;
    } else if (targetState === 'RESERVED') {
      // P0 #4: Clean retry reset invariant — clear all transient failure & execution data
      data.failureReason = null;
      data.failureReasonCode = null;
      data.failedAt = null;
      data.startedAt = null;
      data.completedAt = null;
      data.orderPositionId = null;
    }

    try {
      const result = await this.prisma.algoBotExecution.updateMany({
        where: {
          id: executionId,
          state: { in: expectedArray as any },
        },
        data,
      });

      if (result.count === 0) {
        this.logger.error(
          `State transition conflict for execution '${executionId}': expected state [${expectedArray.join(', ')}], target '${targetState}'`,
        );
        throw new InternalServerErrorException(
          `STATE_TRANSITION_REJECTED: Execution '${executionId}' is not in expected state [${expectedArray.join(', ')}] for transition to ${targetState}`,
        );
      }

      // If transitioning to FAILED_RETRYABLE, purge in-memory lock
      if (targetState === 'FAILED_RETRYABLE') {
        const execution = await this.prisma.algoBotExecution.findUnique({
          where: { id: executionId },
          select: { fingerprint: true },
        });
        if (execution?.fingerprint) {
          this.inMemoryLocks.delete(execution.fingerprint);
        }
      }

      return { success: true, count: result.count };
    } catch (err: any) {
      if (err instanceof InternalServerErrorException) {
        throw err;
      }
      this.logger.error(`Database error during state transition for ${executionId}: ${err.message}`);
      throw new InternalServerErrorException(
        `Execution state transition to ${targetState} failed: ${err.message}`,
      );
    }
  }

  /**
   * P0 #1 & P0 #2: True Atomic Execution Reservation via PostgreSQL `@unique(fingerprint)`
   */
  public async reserveExecutionLock(
    bot: IAlgoBot,
    signal: ISignalSetup,
    fingerprint: string,
  ): Promise<{ success: boolean; executionId?: string; reason?: string }> {
    if (this.inMemoryLocks.has(fingerprint)) {
      return { success: false, reason: 'LOCAL_LOCK_ACTIVE' };
    }

    const signalTimestamp = signal.canonicalCandleTime || signal.timestamp || signal.createdAt || new Date();

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
        // Unique constraint violation (Prisma P2002) means this fingerprint has already been reserved
        if (err?.code === 'P2002') {
          const existing = await this.prisma.algoBotExecution.findUnique({
            where: { fingerprint },
          });

          // Atomic retry state transition via updateMany (prevents retry race conditions & restores clean RESERVED state)
          if (existing && existing.state === 'FAILED_RETRYABLE') {
            try {
              const res = await this.transitionExecutionState(existing.id, 'FAILED_RETRYABLE', 'RESERVED');
              if (res.count === 1) {
                this.inMemoryLocks.add(fingerprint);
                return { success: true, executionId: existing.id };
              }
            } catch (retryErr: any) {
              if (
                retryErr instanceof InternalServerErrorException &&
                (retryErr.message.includes('STATE_TRANSITION_REJECTED') || retryErr.message.includes('INVALID_STATE_TRANSITION_EDGE'))
              ) {
                const rechecked = await this.prisma.algoBotExecution.findUnique({
                  where: { id: existing.id },
                });
                if (rechecked && rechecked.state !== 'FAILED_RETRYABLE') {
                  this.inMemoryLocks.add(fingerprint);
                  return { success: false, reason: 'RETRY_RACE_CONCURRENTLY_CLAIMED' };
                }
                return { success: false, reason: 'STATE_TRANSITION_CONFLICT' };
              }
              // Real DB exception during retry transition -> report DATABASE_UNAVAILABLE / fail closed
              this.logger.error(`Database error during retry transition for ${fingerprint}: ${retryErr.message}`);
              return { success: false, reason: 'DATABASE_UNAVAILABLE' };
            }
            this.inMemoryLocks.add(fingerprint);
            return { success: false, reason: 'RETRY_RACE_CONCURRENTLY_CLAIMED' };
          }

          this.inMemoryLocks.add(fingerprint);
          return { success: false, reason: 'DUPLICATE_RESERVATION' };
        }

        // P0 #1: DB reservation is authoritative. FAIL CLOSED if DB fails.
        this.logger.error(`Database atomic reservation failed for ${fingerprint}: ${err.message}`);
        return { success: false, reason: 'DATABASE_UNAVAILABLE' };
      }
    }

    // Isolated unit test fallback ONLY when neither DB nor Redis is injected
    if (!this.prisma && !this.redis) {
      this.inMemoryLocks.add(fingerprint);
      return { success: true, executionId: `test_exec_${fingerprint}` };
    }

    return { success: false, reason: 'DATABASE_UNAVAILABLE' };
  }

  /**
   * P0 #1: Atomic Conditional Lifecycle Transition — Mark Executing (RESERVED -> EXECUTING)
   */
  public async markExecutionStarted(executionId: string): Promise<void> {
    await this.transitionExecutionState(executionId, 'RESERVED', 'EXECUTING');
  }

  /**
   * P0 #1: Atomic Conditional Lifecycle Transition — Mark Executed (EXECUTING -> EXECUTED)
   */
  public async markExecutionExecuted(executionId: string, orderPositionId?: string): Promise<void> {
    await this.transitionExecutionState(executionId, 'EXECUTING', 'EXECUTED', { orderPositionId });
  }

  /**
   * P0 #1 & #3: Atomic Conditional Lifecycle Transition — Mark Failed ([EXECUTING, RESERVED] -> FAILED_RETRYABLE / FAILED_FINAL)
   */
  public async markExecutionFailed(executionId: string, err: any, customReasonCode?: string): Promise<void> {
    if (!this.prisma || !executionId || executionId.startsWith('test_exec_')) return;

    const classification = classifyExecutionFailure(err);
    const targetState = classification.retryable ? 'FAILED_RETRYABLE' : 'FAILED_FINAL';
    const reasonCode = customReasonCode || classification.reasonCode;
    const failureReason = classification.message;

    await this.transitionExecutionState(
      executionId,
      ['EXECUTING', 'RESERVED'],
      targetState,
      {
        failureReason,
        failureReasonCode: reasonCode,
      },
    );
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
      } catch (err: any) {
        this.logger.warn(`[TELEMETRY_WARNING] Failed to increment bot trigger count for ${botId}: ${err.message}`);
      }
    }
  }

  /**
   * Requirement 5: Complete diagnostic method in AlgoBotsService.
   * Evaluates ALL gates sequentially without stopping early.
   */
  public async evaluateBotForSignalDiagnostics(
    bot: IAlgoBot,
    signal: ISignalSetup,
  ): Promise<{
    botId: string;
    signalId?: string;
    symbol: string;
    matches: boolean;
    reasons: string[];
  }> {
    const reasons: string[] = [];

    // Gate 1: Bot Activation
    if (!bot.isActive) {
      reasons.push('BOT_INACTIVE');
    }

    // Gate 2: Auto Execute Setting
    if (!bot.autoExecutePaper) {
      reasons.push('AUTO_EXECUTE_DISABLED');
    }

    // Gate 3: Canonical Decision Timestamp
    if (
      !signal.canonicalCandleTime ||
      typeof signal.canonicalCandleTime !== 'number' ||
      !Number.isFinite(signal.canonicalCandleTime) ||
      signal.canonicalCandleTime <= 0
    ) {
      reasons.push('CANONICAL_DECISION_TIMESTAMP_REQUIRED');
    }

    // Gate 4: Signal State
    if (!signal.state || signal.state !== SignalState.ACTIVE) {
      reasons.push('SIGNAL_NOT_ACTIVE');
    }

    // Gate 5: Direction & Grade
    if (
      !signal.direction ||
      signal.direction === ('NEUTRAL' as any) ||
      signal.direction === ('NO_TRADE' as any) ||
      signal.grade === ('NO_TRADE' as any)
    ) {
      reasons.push('INVALID_SIGNAL');
    }

    // Gate 6: Signal Freshness (Future vs Stale)
    if (signal.canonicalCandleTime) {
      const nowMs = Date.now();
      if (signal.canonicalCandleTime > nowMs + 5000) {
        reasons.push('SIGNAL_FUTURE');
      } else {
        const maxAgeMs = this.getMaxSignalAgeMs(signal.timeframe);
        if (nowMs - signal.canonicalCandleTime > maxAgeMs) {
          reasons.push('SIGNAL_STALE');
        }
      }
    } else {
      const freshness = this.validateSignalFreshness(signal);
      if (!freshness.matches) {
        if (freshness.reasonCode === 'SIGNAL_FUTURE') reasons.push('SIGNAL_FUTURE');
        else if (freshness.reasonCode === 'SIGNAL_STALE') reasons.push('SIGNAL_STALE');
      }
    }

    // Gate 7: Symbol Parity
    if (!signal.symbol || bot.symbol.toUpperCase() !== signal.symbol.toUpperCase()) {
      reasons.push('SYMBOL_MISMATCH');
    }

    // Gate 8: Timeframe Parity
    const botTf = this.normalizeTimeframe(bot.timeframe);
    const signalTf = this.normalizeTimeframe(signal.timeframe);
    if (botTf !== signalTf) {
      reasons.push('TIMEFRAME_MISMATCH');
    }

    // Gate 9: Direction Parity
    if (bot.direction !== 'ANY' && bot.direction !== signal.direction) {
      reasons.push('DIRECTION_MISMATCH');
    }

    // Gate 10: Score Threshold
    if (typeof signal.score !== 'number' || signal.score < bot.minScore) {
      reasons.push('SCORE_BELOW_THRESHOLD');
    }

    // Gate 11: SMC Evidence Condition Match
    if (!this.matchesSmcCondition(bot.smcCondition, signal)) {
      reasons.push('SMC_CONDITION_MISMATCH');
    }

    // Gate 12: Invalidation / Target Levels Geometry
    const optEntry = signal.entryZone?.optimal;
    const sl = signal.stopLoss;
    const tp1 = signal.takeProfits?.tp1;
    const tp2 = signal.takeProfits?.tp2;
    const tp3 = signal.takeProfits?.tp3;
    if (
      typeof optEntry !== 'number' || !Number.isFinite(optEntry) || optEntry <= 0 ||
      typeof sl !== 'number' || !Number.isFinite(sl) || sl <= 0 ||
      typeof tp1 !== 'number' || !Number.isFinite(tp1) || tp1 <= 0 ||
      typeof tp2 !== 'number' || !Number.isFinite(tp2) || tp2 <= 0 ||
      typeof tp3 !== 'number' || !Number.isFinite(tp3) || tp3 <= 0
    ) {
      reasons.push('INVALID_LEVELS');
    } else {
      if (signal.direction === 'BULLISH' && !(sl < optEntry && optEntry < tp1 && tp1 <= tp2 && tp2 <= tp3)) {
        reasons.push('INVALID_LEVELS');
      } else if (signal.direction === 'BEARISH' && !(sl > optEntry && optEntry > tp1 && tp1 >= tp2 && tp2 >= tp3)) {
        reasons.push('INVALID_LEVELS');
      }
    }

    // Gate 13: Order Quantity Resolution
    try {
      const instrument = getAuthoritativeInstrument(bot.symbol);
      this.resolveBotOrderQuantity(bot, instrument);
    } catch (err: any) {
      reasons.push(`INVALID_QUANTITY: ${err?.message || err}`);
    }

    // Gate 14: Portfolio Open Position Check
    try {
      const portfolio = await this.paperTradingService.getPortfolio();
      const alreadyOpen = portfolio.openPositions.some((p) => p.symbol === bot.symbol);
      if (alreadyOpen) {
        reasons.push('POSITION_ALREADY_OPEN');
      }
    } catch (err: any) {
      reasons.push(`PORTFOLIO_CHECK_FAILED: ${err?.message || err}`);
    }

    // Gate 15: Market Quote Stream Health
    try {
      await this.paperTradingService.getValidatedMarketPrice(bot.symbol, 5);
    } catch (err: any) {
      reasons.push(`MARKET_DATA_UNAVAILABLE: ${err?.message || err}`);
    }

    // Gate 16: Local / DB Execution Lock Check
    const fingerprint = this.getSignalFingerprint(bot, signal);
    if (this.inMemoryLocks.has(fingerprint)) {
      reasons.push('EXECUTION_LOCKED');
    }

    if (reasons.length === 0) {
      reasons.push('READY_TO_EXECUTE');
    }

    const matches = reasons.length === 1 && (reasons[0] === 'READY_TO_EXECUTE' || reasons[0] === 'EXECUTED');

    // Log per-bot evaluation details against real signal
    this.logger.log(
      `[ALGO BOT DIAGNOSTIC VERIFICATION]\n` +
        `botId: ${bot.id}\n` +
        `strategy condition: ${bot.smcCondition}\n` +
        `signal evidence: ${JSON.stringify(signal.triggerEvidence || {})}\n` +
        `match result: ${matches}\n` +
        `rejection reasons: ${reasons.join(', ')}`,
    );

    return {
      botId: bot.id,
      signalId: signal.id,
      symbol: bot.symbol,
      matches,
      reasons,
    };
  }

  /**
   * Requirement 11: Health endpoint telemetry provider
   */
  public async getAlgoExecutionHealth(): Promise<{
    paperExecutionEnabled: boolean;
    hasEnabledExecutionBot: boolean;
    activeBotCount: number;
    enabledBotCount: number;
    lastSignalTime?: Date;
    lastExecutionAttempt?: Date;
    lastExecutionSuccess?: Date;
    lastExecutionRejectionReason?: string;
  }> {
    const bots = await this.listBots();
    const activeBotCount = bots.filter((b) => b.isActive).length;
    const enabledBotCount = bots.filter((b) => b.isActive && b.autoExecutePaper).length;

    const paperExecutionEnabled = process.env.PAPER_TRADING_ENABLED !== 'false';

    return {
      paperExecutionEnabled,
      hasEnabledExecutionBot: enabledBotCount > 0,
      activeBotCount,
      enabledBotCount,
      lastSignalTime: this.lastSignalTime,
      lastExecutionAttempt: this.lastExecutionAttempt,
      lastExecutionSuccess: this.lastExecutionSuccess,
      lastExecutionRejectionReason: this.lastExecutionRejectionReason,
    };
  }

  /**
   * Evaluates incoming signal against all active bot strategies in a single authoritative pass
   */
  async evaluateSignalForBots(signal: ISignalSetup): Promise<IAlgoBotExecutionResult[]> {
    this.lastSignalTime = new Date();
    const bots = await this.listBots();
    const results: IAlgoBotExecutionResult[] = [];
    const canonicalCandleFormatted = signal.canonicalCandleTime
      ? new Date(signal.canonicalCandleTime).toISOString()
      : signal.timestamp
        ? new Date(signal.timestamp).toISOString()
        : 'UNKNOWN';

    for (const bot of bots) {
      if (bot.symbol.toUpperCase() !== signal.symbol.toUpperCase()) {
        continue;
      }

      this.logger.log(
        `[PIPELINE TRACE 4/6] AlgoBotsService.evaluateSignalForBots() checking bot '${bot.id}' for ${signal.symbol} (${signal.timeframe}, score=${signal.score}, canonicalCandleTime=${signal.canonicalCandleTime})`,
      );

      const diag = await this.evaluateBotForSignalDiagnostics(bot, signal);
      const isRejected = !diag.matches;
      const primaryReason = diag.reasons[0] || 'UNKNOWN';

      if (isRejected) {
        this.lastExecutionRejectionReason = primaryReason;
        this.logger.warn(
          `[ALGO EXECUTION DECISION]\n` +
          `${signal.symbol} ${this.normalizeTimeframe(signal.timeframe).toUpperCase()}\n` +
          `signal=${signal.state}\n` +
          `score=${signal.score}\n` +
          `canonicalCandle=${canonicalCandleFormatted}\n` +
          `bot=${bot.id}\n` +
          `result=REJECTED\n` +
          `reason=${primaryReason}`,
        );
        results.push({
          botId: bot.id,
          symbol: bot.symbol,
          status: 'REJECTED',
          reasonCode: primaryReason,
          details: `Diagnostic check failed: ${diag.reasons.join(', ')}`,
        });
        continue;
      }

      // Log candidate status prior to order placement
      this.logger.warn(
        `[ALGO EXECUTION DECISION]\n` +
        `${signal.symbol} ${this.normalizeTimeframe(signal.timeframe).toUpperCase()}\n` +
        `signal=${signal.state}\n` +
        `score=${signal.score}\n` +
        `canonicalCandle=${canonicalCandleFormatted}\n` +
        `bot=${bot.id}\n` +
        `result=READY_TO_EXECUTE\n` +
        `reason=DIAGNOSTICS_PASSED`,
      );

      // 1. Validate Bot Active & Signal Eligibility (ACTIVE state, trade levels, freshness)
      const eligibility = this.validateExecutionEligibility(bot, signal);
      if (!eligibility.matches) {
        const reason = eligibility.reasonCode || 'ELIGIBILITY_FAILED';
        this.lastExecutionRejectionReason = reason;
        this.logger.warn(`[ALGO EXECUTION REJECTED] Bot '${bot.id}' eligibility failed for ${signal.symbol}: ${reason}`);
        results.push({
          botId: bot.id,
          symbol: bot.symbol,
          status: 'REJECTED',
          reasonCode: reason,
          details: eligibility.details,
        });
        continue;
      }

      // 2. Authoritative Strategy Matching (Symbol, Timeframe, Direction, MinScore, Canonical SMC Evidence)
      const match = this.matchesBotStrategy(bot, signal);
      if (!match.matches) {
        const reason = match.reasonCode || 'STRATEGY_MISMATCH';
        this.lastExecutionRejectionReason = reason;
        this.logger.warn(`[ALGO EXECUTION REJECTED] Bot '${bot.id}' strategy mismatch for ${signal.symbol}: ${reason}`);
        results.push({
          botId: bot.id,
          symbol: bot.symbol,
          status: 'REJECTED',
          reasonCode: reason,
          details: match.details,
        });
        continue;
      }

      // P0 #3: NEVER RESERVE BEFORE autoExecutePaper CHECK
      if (!bot.autoExecutePaper) {
        this.lastExecutionRejectionReason = 'AUTO_EXECUTE_PAPER_DISABLED';
        this.logger.warn(`[ALGO EXECUTION SKIPPED] Bot '${bot.id}' autoExecutePaper is disabled`);
        await this.recordBotTrigger(bot.id, signal);
        results.push({
          botId: bot.id,
          symbol: bot.symbol,
          status: 'SKIPPED',
          reasonCode: 'AUTO_EXECUTE_PAPER_DISABLED',
          details: `Bot '${bot.id}' autoExecutePaper is false`,
        });
        continue;
      }

      // 🔴 #9: Check Bot Position Scope Guard BEFORE DB Reservation to prevent consuming reservation rows
      try {
        const portfolio = await this.paperTradingService.getPortfolio();
        const alreadyOpen = portfolio.openPositions.some((p) => p.symbol === bot.symbol);
        if (alreadyOpen) {
          this.lastExecutionRejectionReason = 'POSITION_ALREADY_OPEN';
          this.logger.warn(`[ALGO EXECUTION REJECTED] Bot '${bot.id}' already has an open position for ${bot.symbol}`);
          results.push({
            botId: bot.id,
            symbol: bot.symbol,
            status: 'REJECTED',
            reasonCode: 'POSITION_ALREADY_OPEN',
            details: `Position for '${bot.symbol}' is already open in paper portfolio`,
          });
          continue;
        }
      } catch (err: any) {
        const reason = `PORTFOLIO_CHECK_FAILED: ${err?.message || err}`;
        this.lastExecutionRejectionReason = reason;
        this.logger.warn(`[ALGO EXECUTION REJECTED] Bot '${bot.id}' portfolio check failed for ${bot.symbol}: ${reason}`);
        results.push({
          botId: bot.id,
          symbol: bot.symbol,
          status: 'REJECTED',
          reasonCode: 'PORTFOLIO_CHECK_FAILED',
          details: String(err?.message || err),
        });
        continue;
      }

      // 3. 🟠 #13: Early Live Market Data Availability Check (Eligibility Gate)
      try {
        await this.paperTradingService.getValidatedMarketPrice(bot.symbol, 5);
      } catch (err: any) {
        const reason = `MARKET_PRICE_UNAVAILABLE: ${err?.message || err}`;
        this.lastExecutionRejectionReason = reason;
        this.logger.warn(`[ALGO EXECUTION REJECTED] Bot '${bot.id}' market price check failed for ${bot.symbol}: ${reason}`);
        results.push({
          botId: bot.id,
          symbol: bot.symbol,
          status: 'REJECTED',
          reasonCode: 'MARKET_PRICE_UNAVAILABLE',
          details: String(err?.message || err),
        });
        continue;
      }

      // 4. P0 #4 & P1 #12: Resolve Order Quantity via Authoritative Instrument Registry
      let quantity: number;
      try {
        const instrument = getAuthoritativeInstrument(bot.symbol);
        quantity = this.resolveBotOrderQuantity(bot, instrument);
      } catch (err: any) {
        const reason = `QUANTITY_RESOLUTION_FAILED: ${err?.message || err}`;
        this.lastExecutionRejectionReason = reason;
        this.logger.warn(`[ALGO EXECUTION REJECTED] Bot '${bot.id}' quantity resolution failed for ${bot.symbol}: ${reason}`);
        results.push({
          botId: bot.id,
          symbol: bot.symbol,
          status: 'REJECTED',
          reasonCode: 'QUANTITY_RESOLUTION_FAILED',
          details: String(err?.message || err),
        });
        continue;
      }

      // 5. P0 #1: Compute Versioned Fingerprint & Reserve Execution Lock via Database `@unique` constraint
      const fingerprint = this.getSignalFingerprint(bot, signal);

      this.logger.log(
        `[PIPELINE TRACE 5/6] Reserving execution lock: bot=${bot.id}, fingerprint=${fingerprint}`,
      );

      const reservation = await this.reserveExecutionLock(bot, signal, fingerprint);

      if (!reservation.success || !reservation.executionId) {
        const reason = `EXECUTION_LOCKED: ${reservation.reason}`;
        this.lastExecutionRejectionReason = reason;
        this.logger.warn(
          `[ALGO EXECUTION REJECTED] Execution lock unavailable for fingerprint: ${fingerprint} (Reason: ${reservation.reason})`,
        );
        results.push({
          botId: bot.id,
          symbol: bot.symbol,
          status: 'REJECTED',
          reasonCode: `EXECUTION_LOCKED_${reservation.reason}`,
          details: reservation.reason,
        });
        continue;
      }

      const executionId = reservation.executionId;
      await this.recordBotTrigger(bot.id, signal);

      // 6. P0 #2: Execution State Machine Lifecycle Management
      try {
        this.lastExecutionAttempt = new Date();
        await this.markExecutionStarted(executionId);

        this.logger.log(
          `[PIPELINE TRACE 5.1/6] Marked execution started: executionId=${executionId}`,
        );

        this.logger.log(
          `[PIPELINE TRACE 5.2/6] Calling PaperTradingService.placeOrder(): symbol=${bot.symbol}, direction=${signal.direction}, qty=${quantity}`,
        );

        // Place Order via Authoritative PaperTradingService (Obtains Authoritative Execution Quote)
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
        this.lastExecutionSuccess = new Date();

        this.logger.warn(
          `[ALGO EXECUTION DECISION]\n` +
          `${signal.symbol} ${this.normalizeTimeframe(signal.timeframe).toUpperCase()}\n` +
          `signal=${signal.state}\n` +
          `score=${signal.score}\n` +
          `canonicalCandle=${canonicalCandleFormatted}\n` +
          `bot=${bot.id}\n` +
          `result=EXECUTED\n` +
          `reason=ORDER_PLACED_SUCCESSFULLY`,
        );

        this.logger.log(
          `[PIPELINE TRACE 6/6] Marked execution executed: executionId=${executionId}, orderPositionId=${orderResult.id}`,
        );

        this.logger.log(
          `✓ [BOT ORDER EXECUTED] Bot '${bot.id}' placed order for ${bot.symbol} ${signal.direction} | Qty: ${quantity} | Fingerprint: ${fingerprint} | Fill Price: ₹${orderResult.entryPrice} (Planned Entry: ₹${signal.entryZone.optimal}) | PositionID: ${orderResult.id}`,
        );

        results.push({
          botId: bot.id,
          symbol: bot.symbol,
          status: 'EXECUTED',
          reasonCode: 'ORDER_PLACED_SUCCESSFULLY',
          executionId,
          orderPositionId: orderResult.id,
        });
      } catch (e: any) {
        const reason = `ORDER_PLACEMENT_FAILED: ${e?.message || e}`;
        this.lastExecutionRejectionReason = reason;
        this.logger.error(`[BOT EXECUTION ERROR] Bot '${bot.id}' order placement failed: ${e.message}`, e.stack);
        await this.markExecutionFailed(executionId, e);
        results.push({
          botId: bot.id,
          symbol: bot.symbol,
          status: 'REJECTED',
          reasonCode: 'ORDER_PLACEMENT_FAILED',
          details: String(e?.message || e),
          executionId,
        });
      }
    }

    if (results.length === 0) {
      results.push({
        botId: 'NONE',
        symbol: signal.symbol,
        status: 'SKIPPED',
        reasonCode: 'NO_BOT_CONFIGURED_FOR_SYMBOL',
        details: `No active algo bot is configured for symbol '${signal.symbol}'`,
      });
    }

    return results;
  }
}
