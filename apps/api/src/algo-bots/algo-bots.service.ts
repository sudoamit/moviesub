import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { PaperTradingService } from '../paper-trading/paper-trading.service';
import { AlertsService } from '../alerts/alerts.service';
import { PrismaService } from '../common/prisma/prisma.service';
import { RedisService } from '../common/redis/redis.service';
import {
  TradeLifecycleService,
  ExecutionService,
  ReservationService,
} from '../trading-domain';
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
  TradeDecisionType,
  TradeLifecycleState,
} from '@quant/shared';
import {
  TradeDecisionService,
  IPreTradeDecisionResult,
  ExecutionFailureReason,
  IExecutionFailureClassification,
  classifyExecutionFailure,
  ALLOWED_EXECUTION_STATE_TRANSITIONS,
} from './trade-decision.service';
import * as crypto from 'crypto';
import {
  OptionContractResolver,
  ResolvedOptionContract,
  isOptionsUnderlying,
} from './option-contract-resolver';
import {
  OptionTradeLevelsResolver,
  ResolvedOptionLevels,
} from './option-trade-levels-resolver';

export {
  ExecutionFailureReason,
  IExecutionFailureClassification,
  classifyExecutionFailure,
  ALLOWED_EXECUTION_STATE_TRANSITIONS,
};

const ALLOWED_STATE_TRANSITIONS = ALLOWED_EXECUTION_STATE_TRANSITIONS;

export interface IAlgoBotExecutionResult {
  botId: string;
  symbol: string;
  status: 'EXECUTED' | 'REJECTED' | 'FAILED' | 'SKIPPED';
  reasonCode: string;
  details?: string;
  executionId?: string;
  orderPositionId?: string;
  tradeDecisionId?: string;
  decision?: 'TAKE' | 'REJECT';
  lifecycleState?: string;
  correlationId?: string;
}

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
  executionInstrument?: string;
  executionInstrumentType?: string;
  signalSourceInstrument?: string;
  accountId?: string;
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
      executionInstrument: 'NIFTY OPTION',
      executionInstrumentType: 'OPTION',
      signalSourceInstrument: 'NIFTY',
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
      executionInstrument: 'BANKNIFTY OPTION',
      executionInstrumentType: 'OPTION',
      signalSourceInstrument: 'BANKNIFTY',
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
    {
      id: 'bot_gold_order_flow',
      name: 'XAUUSD 15m Institutional Order Flow Scalper',
      symbol: 'XAUUSD',
      direction: 'ANY',
      timeframe: '15m',
      minScore: 75,
      smcCondition: 'ANY_CONFLUENCE',
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
  private lastTradeDecisionId?: string;
  private lastExecutionId?: string;
  private lastPositionId?: string;
  private lastLifecycleState?: string;
  private lastLifecycleTransitionTime?: Date;

  constructor(
    private readonly paperTradingService: PaperTradingService,
    private readonly alertsService: AlertsService,
    @Optional() private readonly prisma?: PrismaService,
    @Optional() private readonly redis?: RedisService,
    @Optional() private tradeDecisionService?: TradeDecisionService,
    @Optional() private readonly tradeLifecycleService?: TradeLifecycleService,
    @Optional() private readonly executionService?: ExecutionService,
    @Optional() private readonly reservationService?: ReservationService,
  ) {
    if (!this.tradeDecisionService) {
      this.tradeDecisionService = new TradeDecisionService(
        this.prisma,
        this.tradeLifecycleService,
        this.reservationService,
        this.executionService,
      );
    }
    this.logger.log('Algo Strategy Studio Service Initialized.');
  }

  public recordScanTime(time: Date = new Date()) {
    this.lastScanTime = time;
  }

  public recordSignalTime(time: Date = new Date()) {
    this.lastSignalTime = time;
  }

  public isPaperTradingEnabled(): boolean {
    return process.env.PAPER_TRADING_ENABLED === 'true';
  }

  public isPaperAlgoExecutionEnabled(): boolean {
    return (
      process.env.PAPER_TRADING_ENABLED === 'true' &&
      process.env.ENABLE_PAPER_ALGO_BOTS === 'true'
    );
  }

  public isPaperExecutionEnabled(): boolean {
    return this.isPaperAlgoExecutionEnabled();
  }

  async onModuleInit() {
    const paperTradingEnabled = this.isPaperTradingEnabled();
    const paperAlgoExecutionEnabled = this.isPaperAlgoExecutionEnabled();

    this.logger.log(
      `[ALGO PAPER EXECUTION STATUS]\n` +
        `ENABLE_PAPER_ALGO_BOTS=${process.env.ENABLE_PAPER_ALGO_BOTS || 'false'}\n` +
        `PAPER_TRADING_ENABLED=${process.env.PAPER_TRADING_ENABLED || 'false'}\n` +
        `NODE_ENV=${process.env.NODE_ENV || 'development'}\n` +
        `paperTradingEnabled=${paperTradingEnabled}\n` +
        `paperAlgoExecutionEnabled=${paperAlgoExecutionEnabled}`,
    );

    if (this.prisma) {
      try {
        for (const bot of this.presetBots) {
          const existing = await this.prisma.algoBot.findUnique({
            where: { id: bot.id },
          });
          if (!existing) {
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
                executionInstrument: bot.executionInstrument || null,
                executionInstrumentType: (bot as any).executionInstrumentType || null,
                signalSourceInstrument: (bot as any).signalSourceInstrument || null,
              },
            });
          }
        }
      } catch (err: any) {
        this.logger.warn(`Failed to seed preset AlgoBots in database: ${err?.message}`);
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
          executionInstrument: b.executionInstrument || undefined,
          executionInstrumentType: b.executionInstrumentType || (b.executionInstrument?.toUpperCase().includes('OPTION') ? 'OPTION' : 'SPOT'),
          signalSourceInstrument: b.signalSourceInstrument || undefined,
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

  async listExecutions(limit = 20) {
    if (!this.prisma) return [];
    try {
      return await this.prisma.algoBotExecution.findMany({
        take: Number(limit) || 20,
        orderBy: { createdAt: 'desc' },
      });
    } catch {
      return [];
    }
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

    const isOptBot = isOptionsUnderlying(symbol);
    const executionInstrumentType = dto.executionInstrumentType || (isOptBot ? 'OPTION' : 'SPOT');
    const executionInstrument = dto.executionInstrument || (isOptBot ? `${symbol} OPTION` : undefined);
    const signalSourceInstrument = dto.signalSourceInstrument || symbol;

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
            executionInstrument,
            executionInstrumentType,
            signalSourceInstrument,
          },
        });

        this.logger.log(
          `✓ [ALGO BOT CREATED] '${created.name}' (${created.symbol} ${created.direction})`,
        );
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
          executionInstrument: created.executionInstrument || undefined,
          signalSourceInstrument: created.signalSourceInstrument || undefined,
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
          executionInstrument: updated.executionInstrument || undefined,
          signalSourceInstrument: updated.signalSourceInstrument || undefined,
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
    const canonicalTimeRaw =
      (signal as any).canonicalCandleTime ||
      (signal as any).candleTimestamp ||
      signal.timestamp ||
      signal.createdAt;
    if (!canonicalTimeRaw) {
      return {
        matches: false,
        reasonCode: 'SIGNAL_MISSING_TIMESTAMP',
        details: 'Signal lacks valid timestamp',
      };
    }

    const signalTime = new Date(canonicalTimeRaw).getTime();
    if (Number.isNaN(signalTime)) {
      return {
        matches: false,
        reasonCode: 'SIGNAL_INVALID_TIMESTAMP',
        details: 'Signal timestamp is invalid/NaN',
      };
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
    const precision =
      typeof instrument.quantityPrecision === 'number' ? instrument.quantityPrecision : 0;
    const rawQuantity = bot.lots * lotSize;
    if (rawQuantity < minQty) {
      throw new Error(
        `BELOW_MIN_QUANTITY: Computed quantity ${rawQuantity} is below minimum executable quantity ${minQty} for ${instrument.symbol}`,
      );
    }

    const factor = Math.pow(10, precision);
    const canonicalQty = Math.floor((rawQuantity + 1e-9) * factor) / factor;

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

    // Strategy contract: SMC execution structure evidence is bounded by the last 4 execution candles (slice(-4))
    const signalTime =
      typeof signal.canonicalCandleTime === 'number' && signal.canonicalCandleTime > 0
        ? signal.canonicalCandleTime
        : signal.canonicalDecisionTime instanceof Date
          ? signal.canonicalDecisionTime.getTime()
          : typeof signal.canonicalDecisionTime === 'number'
            ? signal.canonicalDecisionTime
            : null;

    if (!signalTime) {
      return false;
    }

    // SMC execution structure evidence bounded to 20-candle execution structure lookback
    const maxStructureAgeMs = this.getMaxSignalAgeMs(signal.timeframe) * 20;

    const isEvidenceItemValid = (item: any): boolean => {
      if (!item || item.matched !== true) return false;
      if (item.timestamp) {
        const itemTime = new Date(item.timestamp).getTime();
        if (Number.isNaN(itemTime)) return false;
        // Evidence timestamp must not be from the future (> 5000ms) or older than 4 candle intervals
        if (itemTime > signalTime + 5000 || signalTime - itemTime > maxStructureAgeMs) {
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
      return {
        matches: false,
        reasonCode: 'BOT_INACTIVE',
        details: `Bot '${bot.id}' is inactive/paused`,
      };
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
      return {
        matches: false,
        reasonCode: 'INVALID_SIGNAL',
        details: `Signal direction '${signal.direction}' is NEUTRAL or NO_TRADE`,
      };
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
      return {
        matches: false,
        reasonCode: 'INVALID_LEVELS',
        details: 'Signal score must be a positive finite number',
      };
    }

    if (
      typeof optimalEntry !== 'number' ||
      !Number.isFinite(optimalEntry) ||
      optimalEntry <= 0 ||
      typeof stopLoss !== 'number' ||
      !Number.isFinite(stopLoss) ||
      stopLoss <= 0 ||
      typeof tp1 !== 'number' ||
      !Number.isFinite(tp1) ||
      tp1 <= 0 ||
      typeof tp2 !== 'number' ||
      !Number.isFinite(tp2) ||
      tp2 <= 0 ||
      typeof tp3 !== 'number' ||
      !Number.isFinite(tp3) ||
      tp3 <= 0
    ) {
      return {
        matches: false,
        reasonCode: 'INVALID_LEVELS',
        details: 'Incomplete or non-finite entry/SL/TP levels',
      };
    }

    const riskDistance = Math.abs(optimalEntry - stopLoss);
    if (!Number.isFinite(riskDistance) || riskDistance <= 0) {
      return {
        matches: false,
        reasonCode: 'INVALID_LEVELS',
        details: 'Invalid risk distance between entry and SL',
      };
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
    const canonicalTimeRaw =
      signal.canonicalCandleTime || signal.timestamp || signal.createdAt || new Date();
    const signalTimeMs = new Date(canonicalTimeRaw).getTime();
    const normTf = this.normalizeTimeframe(signal.timeframe);
    const normSymbol = bot.symbol.toUpperCase();
    const normDir = signal.direction;

    const tfMs = this.getMaxSignalAgeMs(normTf);
    // Use canonical candle timestamp if present; otherwise fall back to timeframe floor boundary
    const canonicalCandleBoundaryMs =
      signal.canonicalCandleTime || Math.floor(signalTimeMs / tfMs) * tfMs;

    // Strategy configuration hash to uniquely represent bot parameters
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
   * P0 #1, #2, #3: Single-Authority Atomic Conditional Execution State Transition Helper
   *
   * Enforces strict finite state machine graph edges:
   *   RESERVED  -> EXECUTING / FAILED_RETRYABLE / FAILED_FINAL / CANCELLED
   *   EXECUTING -> EXECUTED / FAILED_RETRYABLE / FAILED_FINAL
   *   FAILED_RETRYABLE -> RESERVED (Clean Retry Reset)
   *
   * Rejects any transition edge that does not belong to the allowed state graph.
   */
  /**
   * P0 #1, #2, #3: Single-Authority Atomic Conditional Execution State Transition Helper
   * Thin delegation wrapper routing authoritatively through TradeDecisionService.
   */
  public async transitionExecutionState(
    executionId: string,
    expectedStates:
      | 'RESERVED'
      | 'EXECUTING'
      | 'EXECUTED'
      | 'FAILED_RETRYABLE'
      | 'FAILED_FINAL'
      | ('RESERVED' | 'EXECUTING' | 'EXECUTED' | 'FAILED_RETRYABLE' | 'FAILED_FINAL')[],
    targetState: 'RESERVED' | 'EXECUTING' | 'EXECUTED' | 'FAILED_RETRYABLE' | 'FAILED_FINAL',
    updateData?: {
      orderPositionId?: string | null;
      failureReason?: string | null;
      failureReasonCode?: string | null;
    },
  ): Promise<{ success: boolean; count: number }> {
    if (this.tradeDecisionService) {
      const res = await this.tradeDecisionService.transitionExecutionState(
        executionId,
        expectedStates,
        targetState,
        updateData,
      );
      if (targetState === 'FAILED_RETRYABLE') {
        if (this.prisma && executionId && !executionId.startsWith('test_exec_')) {
          const execution = await this.prisma.algoBotExecution.findUnique({
            where: { id: executionId },
            select: { fingerprint: true },
          });
          if (execution?.fingerprint) {
            this.inMemoryLocks.delete(execution.fingerprint);
          }
        }
      }
      return res;
    }
    return { success: true, count: 1 };
  }

  /**
   * @deprecated Deprecated duplicate reservation mechanism.
   * Delegates authoritatively to TradeDecisionService.commitTradeDecisionAndReservation().
   * Maintains backward compatibility for existing callers and tests.
   */
  public async reserveExecutionLock(
    bot: IAlgoBot,
    signal: ISignalSetup,
    fingerprint: string,
    accountId?: string,
  ): Promise<{ success: boolean; executionId?: string; reason?: string }> {
    if (this.inMemoryLocks.has(fingerprint)) {
      return { success: false, reason: 'LOCAL_LOCK_ACTIVE' };
    }

    const effectiveAccountId = accountId || bot.accountId || 'acc_authoritative';

    const decisionResult: IPreTradeDecisionResult = {
      decision: TradeDecisionType.TAKE,
      decisionReasonCode: 'PRE_TRADE_APPROVED',
      decisionReason: 'Authoritative reservation',
      lifecycleState: TradeLifecycleState.PRE_TRADE_APPROVED,
      plannedLevels: {
        optimalEntry: signal.entryZone?.optimal || 100,
        stopLoss: signal.stopLoss || 90,
        target1: signal.takeProfits?.tp1 || 110,
        quantity: bot.lots || 1,
        leverage: 1.0,
        riskAmount: 1000,
        riskPercent: 1.0,
      },
    };

    if (this.tradeDecisionService) {
      try {
        const commitRes = await this.tradeDecisionService.commitTradeDecisionAndReservation({
          bot,
          signal,
          decisionResult,
          fingerprint,
          correlationId: fingerprint,
          accountId: effectiveAccountId,
        });

        if (commitRes.isDuplicate || !commitRes.executionId) {
          // Atomic retry state transition via updateMany (prevents retry race conditions & restores clean RESERVED state)
          if (this.prisma) {
            const existing = await this.prisma.algoBotExecution.findUnique({
              where: { fingerprint },
            });

            if (existing && existing.state === 'FAILED_RETRYABLE') {
              try {
                const res = await this.transitionExecutionState(
                  existing.id,
                  'FAILED_RETRYABLE',
                  'RESERVED',
                );
                if (res.count === 1) {
                  this.inMemoryLocks.add(fingerprint);
                  return { success: true, executionId: existing.id };
                }
              } catch (retryErr: any) {
                if (
                  retryErr instanceof InternalServerErrorException &&
                  (retryErr.message.includes('STATE_TRANSITION_REJECTED') ||
                    retryErr.message.includes('INVALID_STATE_TRANSITION_EDGE'))
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
                this.logger.error(
                  `Database error during retry transition for ${fingerprint}: ${retryErr.message}`,
                );
                return { success: false, reason: 'DATABASE_UNAVAILABLE' };
              }
              this.inMemoryLocks.add(fingerprint);
              return { success: false, reason: 'RETRY_RACE_CONCURRENTLY_CLAIMED' };
            }
          }

          this.inMemoryLocks.add(fingerprint);
          return { success: false, reason: 'DUPLICATE_RESERVATION' };
        }

        this.inMemoryLocks.add(fingerprint);
        return { success: true, executionId: commitRes.executionId };
      } catch (err: any) {
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
    if (this.tradeDecisionService) {
      return this.tradeDecisionService.markExecutionStarted(executionId);
    }
    await this.transitionExecutionState(executionId, 'RESERVED', 'EXECUTING');
  }

  /**
   * P0 #1: Atomic Conditional Lifecycle Transition — Mark Executed (EXECUTING -> EXECUTED)
   */
  public async markExecutionExecuted(executionId: string, orderPositionId?: string): Promise<void> {
    if (this.tradeDecisionService) {
      return this.tradeDecisionService.markExecutionExecuted(executionId, orderPositionId);
    }
    await this.transitionExecutionState(executionId, 'EXECUTING', 'EXECUTED', { orderPositionId });
  }

  /**
   * P0 #1 & #3: Atomic Conditional Lifecycle Transition — Mark Failed ([EXECUTING, RESERVED] -> FAILED_RETRYABLE / FAILED_FINAL)
   */
  public async markExecutionFailed(
    executionId: string,
    err: any,
    classificationParam?: IExecutionFailureClassification,
  ): Promise<void> {
    if (this.tradeDecisionService) {
      await this.tradeDecisionService.markExecutionFailed(executionId, err, classificationParam);
      if (this.prisma && executionId && !executionId.startsWith('test_exec_')) {
        try {
          const execution = await this.prisma.algoBotExecution.findUnique({
            where: { id: executionId },
            select: { fingerprint: true },
          });
          if (execution?.fingerprint) {
            this.inMemoryLocks.delete(execution.fingerprint);
          }
        } catch {
          // ignore cleanup errors
        }
      }
      return;
    }
    if (!this.prisma || !executionId || executionId.startsWith('test_exec_')) return;

    const classification = classificationParam || classifyExecutionFailure(err);
    const targetState = classification.retryable ? 'FAILED_RETRYABLE' : 'FAILED_FINAL';

    await this.transitionExecutionState(executionId, ['EXECUTING', 'RESERVED'], targetState, {
      failureReason: classification.message,
      failureReasonCode: classification.reasonCode,
    });
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
        this.logger.warn(
          `[TELEMETRY_WARNING] Failed to increment bot trigger count for ${botId}: ${err.message}`,
        );
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
      typeof optEntry !== 'number' ||
      !Number.isFinite(optEntry) ||
      optEntry <= 0 ||
      typeof sl !== 'number' ||
      !Number.isFinite(sl) ||
      sl <= 0 ||
      typeof tp1 !== 'number' ||
      !Number.isFinite(tp1) ||
      tp1 <= 0 ||
      typeof tp2 !== 'number' ||
      !Number.isFinite(tp2) ||
      tp2 <= 0 ||
      typeof tp3 !== 'number' ||
      !Number.isFinite(tp3) ||
      tp3 <= 0
    ) {
      reasons.push('INVALID_LEVELS');
    } else {
      if (
        signal.direction === 'BULLISH' &&
        !(sl < optEntry && optEntry < tp1 && tp1 <= tp2 && tp2 <= tp3)
      ) {
        reasons.push('INVALID_LEVELS');
      } else if (
        signal.direction === 'BEARISH' &&
        !(sl > optEntry && optEntry > tp1 && tp1 >= tp2 && tp2 >= tp3)
      ) {
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

    const matches =
      reasons.length === 1 && (reasons[0] === 'READY_TO_EXECUTE' || reasons[0] === 'EXECUTED');

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
   * Requirement 26: Health & Diagnostics endpoint telemetry provider
   */
  public async getAlgoExecutionHealth(): Promise<{
    paperTradingEnabled: boolean;
    algoPaperExecutionEnabled: boolean;
    paperExecutionEnabled: boolean;
    hasEnabledExecutionBot: boolean;
    activeBotCount: number;
    enabledBotCount: number;
    autoExecutionBotCount: number;
    lastSignalTime?: Date;
    lastExecutionAttempt?: Date;
    lastExecutionSuccess?: Date;
    lastExecutionRejectionReason?: string;
    lastTradeDecisionId?: string;
    lastExecutionId?: string;
    lastPositionId?: string;
    lastLifecycleState?: string;
    lastLifecycleTransitionTime?: Date;
  }> {
    const bots = await this.listBots();
    const activeBotCount = bots.filter((b) => b.isActive).length;
    const enabledBotCount = bots.filter((b) => b.isActive && b.autoExecutePaper).length;

    const paperTradingEnabled = this.isPaperTradingEnabled();
    const algoPaperExecutionEnabled = this.isPaperAlgoExecutionEnabled();

    let lastTradeDecisionId = this.lastTradeDecisionId;
    let lastExecutionId = this.lastExecutionId;
    let lastPositionId = this.lastPositionId;
    let lastLifecycleState = this.lastLifecycleState;
    let lastLifecycleTransitionTime = this.lastLifecycleTransitionTime;

    if (
      !lastTradeDecisionId &&
      this.prisma &&
      typeof (this.prisma.tradeDecision as any)?.findFirst === 'function'
    ) {
      try {
        const latestDecision = await this.prisma.tradeDecision.findFirst({
          orderBy: { updatedAt: 'desc' },
        });
        if (latestDecision) {
          lastTradeDecisionId = latestDecision.id;
          lastExecutionId = latestDecision.executionId || undefined;
          lastPositionId = latestDecision.orderPositionId || undefined;
          lastLifecycleState = latestDecision.lifecycleState;
          lastLifecycleTransitionTime = latestDecision.updatedAt;
        }
      } catch {}
    }

    return {
      paperTradingEnabled,
      algoPaperExecutionEnabled,
      paperExecutionEnabled: algoPaperExecutionEnabled,
      hasEnabledExecutionBot: enabledBotCount > 0,
      activeBotCount,
      enabledBotCount,
      autoExecutionBotCount: enabledBotCount,
      lastSignalTime: this.lastSignalTime,
      lastExecutionAttempt: this.lastExecutionAttempt,
      lastExecutionSuccess: this.lastExecutionSuccess,
      lastExecutionRejectionReason: this.lastExecutionRejectionReason,
      lastTradeDecisionId,
      lastExecutionId,
      lastPositionId,
      lastLifecycleState,
      lastLifecycleTransitionTime,
    };
  }

  /**
   * Requirement 27: Bot-specific multi-gate diagnostics
   */
  public async getBotDiagnostics(
    botId: string,
    signal?: ISignalSetup,
  ): Promise<{
    botId: string;
    symbol: string;
    allPassed: boolean;
    failedGates: string[];
    gateResults: { code: string; message: string; passed: boolean }[];
  }> {
    const bots = await this.listBots();
    const bot = bots.find((b) => b.id === botId);
    if (!bot) {
      throw new NotFoundException(`Bot with ID '${botId}' not found`);
    }

    let portfolio: any = null;
    try {
      portfolio = await this.paperTradingService.getPortfolio();
    } catch {}

    let liveQuote: any = null;
    try {
      liveQuote = await this.paperTradingService.getValidatedMarketPrice(bot.symbol, 5);
    } catch {}

    const dummySignal: ISignalSetup = signal || {
      id: `sig_diag_${bot.symbol}`,
      symbol: bot.symbol,
      timeframe: bot.timeframe as any,
      direction: bot.direction === 'BEARISH' ? 'BEARISH' : 'BULLISH',
      state: SignalState.ACTIVE,
      score: bot.minScore,
      canonicalCandleTime: Date.now(),
      entryZone: { min: 100, max: 102, optimal: 101 },
      stopLoss: bot.direction === 'BEARISH' ? 105 : 95,
      takeProfits: {
        tp1: bot.direction === 'BEARISH' ? 95 : 107,
        tp2: bot.direction === 'BEARISH' ? 90 : 112,
        tp3: bot.direction === 'BEARISH' ? 85 : 117,
      },
      triggerEvidence: {
        orderBlock: { matched: true, timestamp: new Date().toISOString() },
        fvg: { matched: true, timestamp: new Date().toISOString() },
        liquiditySweep: { matched: true, timestamp: new Date().toISOString() },
      } as any,
    } as any;

    return this.tradeDecisionService!.evaluateAllGates({
      bot,
      signal: dummySignal,
      accountId: portfolio?.accountId,
      portfolio,
      liveQuote,
      isPaperTradingEnabled: this.isPaperTradingEnabled(),
      isPaperAlgoExecutionEnabled: this.isPaperAlgoExecutionEnabled(),
    });
  }

  /**
   * Evaluates incoming signal against all active bot strategies in a single authoritative pass
   */
  async evaluateSignalForBots(signal: ISignalSetup): Promise<IAlgoBotExecutionResult[]> {
    this.lastSignalTime = new Date();
    const bots = await this.listBots();
    const results: IAlgoBotExecutionResult[] = [];

    const canonicalCandleTime = signal.canonicalCandleTime;
    const canonicalDecisionTime = signal.canonicalDecisionTime
      ? signal.canonicalDecisionTime instanceof Date
        ? signal.canonicalDecisionTime
        : new Date(signal.canonicalDecisionTime)
      : undefined;

    const isValidTimestamp =
      Number.isFinite(canonicalCandleTime) &&
      canonicalDecisionTime &&
      !isNaN(canonicalDecisionTime.getTime()) &&
      canonicalCandleTime === canonicalDecisionTime.getTime();

    if (!isValidTimestamp) {
      const reason = 'CANONICAL_TIMESTAMP_INVALID';
      this.lastExecutionRejectionReason = reason;
      results.push({
        botId: 'N/A',
        symbol: signal.symbol,
        status: 'REJECTED',
        reasonCode: reason,
        decision: 'REJECT',
        lifecycleState: TradeLifecycleState.TRADE_REJECTED,
        details:
          'Signal setup fails strict canonical timestamp invariant (canonicalCandleTime required and must equal canonicalDecisionTime.getTime())',
      });
      return results;
    }

    const canonicalCandleFormatted = canonicalDecisionTime.toISOString();
    const paperTradingEnabled = this.isPaperTradingEnabled();
    const paperAlgoExecutionEnabled = this.isPaperAlgoExecutionEnabled();

    for (const bot of bots) {
      const botNorm = bot.symbol.toUpperCase().replace(/_SPOT$/, '');
      const sigNorm = signal.symbol.toUpperCase().replace(/_SPOT$/, '');
      if (botNorm !== sigNorm && bot.symbol.toUpperCase() !== signal.symbol.toUpperCase()) {
        continue;
      }

      this.logger.log(
        `[PIPELINE TRACE 4/6] AlgoBotsService.evaluateSignalForBots() checking bot '${bot.id}' for ${signal.symbol} (${signal.timeframe}, score=${signal.score}, canonicalCandleTime=${signal.canonicalCandleTime})`,
      );

      // Gate 1: Global Paper Trading Engine Available
      if (!paperTradingEnabled) {
        const reason = 'PAPER_TRADING_DISABLED';
        this.lastExecutionRejectionReason = reason;
        this.logger.warn(
          `[ALGO EXECUTION REJECTED] Paper trading engine is disabled globally (PAPER_TRADING_ENABLED is not true)`,
        );
        results.push({
          botId: bot.id,
          symbol: bot.symbol,
          status: 'REJECTED',
          reasonCode: reason,
          decision: 'REJECT',
          lifecycleState: TradeLifecycleState.TRADE_REJECTED,
          details: 'Global paper trading is disabled (PAPER_TRADING_ENABLED != true)',
        });
        continue;
      }

      // Gate 2: Global Paper Algo Bot Execution Enabled
      if (!paperAlgoExecutionEnabled) {
        const reason = 'PAPER_ALGO_BOTS_DISABLED';
        this.lastExecutionRejectionReason = reason;
        this.logger.warn(
          `[ALGO EXECUTION REJECTED] Algo bot paper execution is disabled globally (ENABLE_PAPER_ALGO_BOTS is not true)`,
        );
        results.push({
          botId: bot.id,
          symbol: bot.symbol,
          status: 'REJECTED',
          reasonCode: reason,
          decision: 'REJECT',
          lifecycleState: TradeLifecycleState.TRADE_REJECTED,
          details: 'Global paper algo bot execution is disabled (ENABLE_PAPER_ALGO_BOTS != true)',
        });
        continue;
      }

      // Gate 3: Bot Activation
      if (!bot.isActive) {
        const reason = 'BOT_INACTIVE';
        this.lastExecutionRejectionReason = reason;
        this.logger.warn(`[ALGO EXECUTION REJECTED] Bot '${bot.id}' is inactive/paused`);
        results.push({
          botId: bot.id,
          symbol: bot.symbol,
          status: 'REJECTED',
          reasonCode: reason,
          decision: 'REJECT',
          lifecycleState: TradeLifecycleState.TRADE_REJECTED,
          details: `Bot '${bot.id}' is inactive/paused`,
        });
        continue;
      }

      // Gate 4: Bot Auto-Execute Paper Setting
      if (!bot.autoExecutePaper) {
        const reason = 'AUTO_EXECUTE_PAPER_DISABLED';
        this.lastExecutionRejectionReason = reason;
        await this.recordBotTrigger(bot.id, signal);
        this.logger.warn(`[ALGO EXECUTION SKIPPED] Bot '${bot.id}' autoExecutePaper is disabled`);
        results.push({
          botId: bot.id,
          symbol: bot.symbol,
          status: 'SKIPPED',
          reasonCode: reason,
          decision: 'REJECT',
          lifecycleState: TradeLifecycleState.TRADE_REJECTED,
          details: `Bot '${bot.id}' autoExecutePaper is false`,
        });
        continue;
      }

      // Fetch Live Portfolio & Live Market Quote for Pre-Trade Decision Evaluation
      let portfolio = null;
      let portfolioError: any = null;
      try {
        portfolio = await this.paperTradingService.getPortfolio();
      } catch (err: any) {
        portfolioError = err;
      }

      let liveQuote = null;
      let liveQuoteError: any = null;
      try {
        liveQuote = await this.paperTradingService.getValidatedMarketPrice(bot.symbol, 5);
      } catch (err: any) {
        liveQuoteError = err;
      }

      // Gate 5: Fail closed on authoritative account identity (Requirement 4 & 10)
      const accountId = (portfolio as any)?.accountId;
      if (!accountId || typeof accountId !== 'string' || accountId.trim() === '') {
        const reason = 'ACCOUNT_ID_REQUIRED';
        this.lastExecutionRejectionReason = reason;
        this.logger.warn(
          `[ALGO EXECUTION REJECTED] No authoritative accountId found for portfolio`,
        );
        results.push({
          botId: bot.id,
          symbol: bot.symbol,
          status: 'REJECTED',
          reasonCode: reason,
          decision: 'REJECT',
          lifecycleState: TradeLifecycleState.TRADE_REJECTED,
          details: 'Authoritative accountId is required for auto execution',
        });
        continue;
      }

      // Option Contract & Premium Resolution for NIFTY / BANKNIFTY Bots
      const isOptionsBot =
        bot.executionInstrumentType === 'OPTION' ||
        Boolean(bot.executionInstrument && bot.executionInstrument.toUpperCase().includes('OPTION')) ||
        (signal as any).executionInstrumentType === 'OPTION';

      let resolvedContract: ResolvedOptionContract | null = null;
      let optionLevels: ResolvedOptionLevels | null = null;
      let optionQuote: { price: number; timestamp: Date } | null = null;
      let optionQuoteError: any = null;

      if (isOptionsBot) {
        try {
          const spotPrice = liveQuote?.price || signal.entryZone?.optimal;
          resolvedContract = OptionContractResolver.resolveContract({
            underlyingSymbol: bot.symbol,
            signalDirection: signal.direction,
            underlyingSpotPrice: spotPrice,
            signalTimestamp: signal.canonicalCandleTime,
          });
        } catch (err: any) {
          this.logger.warn(`[OPTION CONTRACT RESOLUTION FAILED] Bot '${bot.id}': ${err.message}`);
          results.push({
            botId: bot.id,
            symbol: bot.symbol,
            status: 'REJECTED',
            reasonCode: 'OPTION_CONTRACT_REQUIRED',
            decision: 'REJECT',
            lifecycleState: TradeLifecycleState.TRADE_REJECTED,
            details: err.message,
          });
          continue;
        }

        if (resolvedContract) {
          try {
            optionQuote = await this.paperTradingService.getValidatedOptionPrice(resolvedContract.contractSymbol, 5);
          } catch (err: any) {
            optionQuoteError = err;
          }

          if (optionQuote && optionQuote.price > 0) {
            try {
              optionLevels = OptionTradeLevelsResolver.resolveLevels({
                optionEntryPrice: optionQuote.price,
                slPercent: 30,
              });
            } catch (err: any) {
              this.logger.warn(`[OPTION TRADE LEVELS FAILED] Bot '${bot.id}': ${err.message}`);
            }
          }
        }
      }

      const executionSignal: any = { ...signal };
      let executionInstrument =
        (bot as any).executionInstrument ||
        (signal as any).contractSymbol ||
        bot.symbol.toUpperCase();
      let executionInstrumentType = (bot as any).executionInstrumentType || (isOptionsBot ? 'OPTION' : 'SPOT');
      let contractSymbol =
        (signal as any).contractSymbol ||
        (bot as any).executionInstrument ||
        bot.symbol.toUpperCase();
      let strike: number | undefined;
      let optionType: string | undefined;
      let expiry: string | undefined;
      let signalDirection = signal.direction;
      let orderSide = signal.direction === 'BULLISH' ? 'BUY' : 'SELL';

      if (isOptionsBot && resolvedContract) {
        executionInstrument = resolvedContract.contractSymbol;
        executionInstrumentType = 'OPTION';
        contractSymbol = resolvedContract.contractSymbol;
        strike = resolvedContract.strike;
        optionType = resolvedContract.optionType;
        expiry = resolvedContract.expiry;
        signalDirection = signal.direction;
        orderSide = 'BUY'; // Long options only: Buy CE or Buy PE

        executionSignal.executionInstrumentType = 'OPTION';
        executionSignal.contractSymbol = contractSymbol;
        executionSignal.strike = strike;
        executionSignal.optionType = optionType;
        executionSignal.expiry = expiry;
        executionSignal.signalDirection = signalDirection;
        executionSignal.orderSide = 'BUY';

        if (optionLevels) {
          executionSignal.entryZone = {
            min: optionLevels.optimalEntry,
            max: optionLevels.optimalEntry,
            optimal: optionLevels.optimalEntry,
          };
          executionSignal.stopLoss = optionLevels.stopLoss;
          executionSignal.takeProfits = {
            tp1: optionLevels.target1,
            tp2: optionLevels.target2,
            tp3: optionLevels.target3,
          };
          executionSignal.isOptionLevels = true;
        }
      }

      const effectiveLiveQuote = isOptionsBot ? optionQuote : liveQuote;
      const effectiveLiveQuoteError = isOptionsBot ? optionQuoteError : liveQuoteError;

      // 1. Authoritative Pre-Trade Decision Evaluation
      const decisionResult = this.tradeDecisionService!.evaluatePreTradeDecision({
        bot,
        signal: executionSignal,
        portfolio,
        portfolioError,
        liveQuote: effectiveLiveQuote,
        liveQuoteError: effectiveLiveQuoteError,
      } as any);

      const fingerprint = this.tradeDecisionService!.getTradeFingerprint(bot, executionSignal, accountId);

      if (decisionResult.decision === TradeDecisionType.REJECT) {
        if (decisionResult.decisionReasonCode === 'AUTO_EXECUTE_DISABLED') {
          this.lastExecutionRejectionReason = 'AUTO_EXECUTE_PAPER_DISABLED';
          await this.recordBotTrigger(bot.id, signal);
          this.logger.warn(`[ALGO EXECUTION SKIPPED] Bot '${bot.id}' autoExecutePaper is disabled`);
          results.push({
            botId: bot.id,
            symbol: bot.symbol,
            status: 'SKIPPED',
            reasonCode: 'AUTO_EXECUTE_PAPER_DISABLED',
            details: `Bot '${bot.id}' autoExecutePaper is false`,
            decision: 'REJECT',
            lifecycleState: TradeLifecycleState.TRADE_REJECTED,
            correlationId: fingerprint,
          });
          continue;
        }

        const signalSourceInstrument =
          (bot as any).signalSourceInstrument ||
          signal.symbol.toUpperCase();

        // Commit REJECT trade decision to DB
        const commitRes = await this.tradeDecisionService!.commitTradeDecisionAndReservation({
          bot,
          signal: executionSignal,
          decisionResult,
          fingerprint,
          correlationId: fingerprint,
          accountId,
          executionInstrument,
          signalSourceInstrument,
          executionInstrumentType,
          contractSymbol,
          strike,
          optionType,
          expiry,
          signalDirection,
          orderSide,
        });

        this.lastExecutionRejectionReason = decisionResult.decisionReasonCode;
        this.logger.warn(
          `[ALGO EXECUTION DECISION]\n` +
            `${signal.symbol} ${this.normalizeTimeframe(signal.timeframe).toUpperCase()}\n` +
            `signal=${signal.state}\n` +
            `score=${signal.score}\n` +
            `canonicalCandle=${canonicalCandleFormatted}\n` +
            `bot=${bot.id}\n` +
            `result=REJECTED\n` +
            `reason=${decisionResult.decisionReasonCode}`,
        );

        results.push({
          botId: bot.id,
          symbol: bot.symbol,
          status: 'REJECTED',
          reasonCode: decisionResult.decisionReasonCode,
          details: decisionResult.decisionReason,
          tradeDecisionId: commitRes.tradeDecisionId,
          decision: 'REJECT',
          lifecycleState: commitRes.lifecycleState,
          correlationId: fingerprint,
        });
        continue;
      }

      // 2. Decision is TAKE -> Atomically Commit Trade Decision & Reserve Execution Lock
      this.logger.log(
        `[PIPELINE TRACE 5/6] Committing trade decision & reservation: bot=${bot.id}, fingerprint=${fingerprint}`,
      );

      const signalSourceInstrument =
        (bot as any).signalSourceInstrument ||
        signal.symbol.toUpperCase();

      const commitRes = await this.tradeDecisionService!.commitTradeDecisionAndReservation({
        bot,
        signal: executionSignal,
        decisionResult,
        fingerprint,
        correlationId: fingerprint,
        accountId,
        executionInstrument,
        signalSourceInstrument,
        executionInstrumentType,
        contractSymbol,
        strike,
        optionType,
        expiry,
        signalDirection,
        orderSide,
      });

      this.lastTradeDecisionId = commitRes.tradeDecisionId;
      this.lastExecutionId = commitRes.executionId;
      this.lastLifecycleState = commitRes.lifecycleState;
      this.lastLifecycleTransitionTime = new Date();

      if (commitRes.isDuplicate || !commitRes.executionId) {
        const reason = 'EXECUTION_LOCKED';
        this.lastExecutionRejectionReason = reason;
        this.logger.warn(
          `[ALGO EXECUTION REJECTED] Execution lock unavailable for fingerprint: ${fingerprint} (Reason: DUPLICATE_RESERVATION)`,
        );
        results.push({
          botId: bot.id,
          symbol: bot.symbol,
          status: 'REJECTED',
          reasonCode: reason,
          details: 'DUPLICATE_RESERVATION',
          tradeDecisionId: commitRes.tradeDecisionId,
          decision: 'REJECT',
          lifecycleState: TradeLifecycleState.RESERVATION_FAILED,
          correlationId: fingerprint,
        });
        continue;
      }

      const executionId = commitRes.executionId;
      const tradeDecisionId = commitRes.tradeDecisionId;
      await this.recordBotTrigger(bot.id, signal);

      const quantity = decisionResult.plannedLevels?.quantity;
      if (!quantity || quantity <= 0) {
        throw new Error(
          `[EXECUTION ABORTED] Authoritative planned quantity is non-positive (${quantity}) for bot '${bot.id}'. Execution cannot proceed with unvalidated fallback.`,
        );
      }
      try {
        this.lastExecutionAttempt = new Date();
        await this.markExecutionStarted(executionId);

        // Obtain fresh authoritative market quote again at execution time
        let freshExecutionQuote = null;
        try {
          if (isOptionsBot && resolvedContract) {
            freshExecutionQuote = await this.paperTradingService.getValidatedOptionPrice(resolvedContract.contractSymbol, 5);
          } else {
            freshExecutionQuote = await this.paperTradingService.getValidatedMarketPrice(bot.symbol, 5);
          }
        } catch (quoteErr: any) {
          this.logger.error(
            `[EXECUTION QUOTE FAILED] Cannot execute bot '${bot.id}': fresh market quote unavailable at execution time: ${quoteErr.message}`,
          );
          throw quoteErr;
        }

        const marketEventTime = freshExecutionQuote?.timestamp
          ? new Date(freshExecutionQuote.timestamp)
          : new Date();
        const observedAt = new Date();
        const receivedAt = new Date();
        const orderSubmittedTime = new Date();

        await this.tradeDecisionService!.updateTradeLifecycleState(
          tradeDecisionId,
          TradeLifecycleState.ORDER_SUBMITTED,
          {
            executionId,
            orderSubmittedTime,
            marketEventTime,
            observedAt,
            receivedAt,
          },
          TradeLifecycleState.RESERVATION_CREATED,
        );

        this.logger.log(
          `[PIPELINE TRACE 5.1/6] Marked execution started: executionId=${executionId}`,
        );

        this.logger.log(
          `[PIPELINE TRACE 5.2/6] Calling PaperTradingService.placeOrder(): symbol=${bot.symbol}, contractSymbol=${contractSymbol}, direction=${orderSide}, qty=${quantity}`,
        );

        // Place Order via Authoritative PaperTradingService (Obtains Authoritative Execution Quote)
        const orderResult = await this.paperTradingService.placeOrder({
          symbol: bot.symbol,
          executionInstrument,
          executionInstrumentType,
          signalSourceInstrument,
          instrumentType: isOptionsBot ? 'OPTION' : 'SPOT',
          contractSymbol,
          strike,
          optionType: optionType as any,
          expiry,
          direction: isOptionsBot ? 'BUY' : (signal.direction === 'BULLISH' ? 'BUY' : 'SELL'),
          strategyDirection: signal.direction,
          sourceBotId: bot.id,
          quantity,
          leverage: decisionResult.plannedLevels?.leverage,
          orderType: 'MARKET',
          signalPrice: executionSignal.entryZone?.optimal,
          signalTime: canonicalCandleFormatted,
          stopLoss: executionSignal.stopLoss,
          target1: executionSignal.takeProfits?.tp1,
          target2: executionSignal.takeProfits?.tp2,
          target3: executionSignal.takeProfits?.tp3,
          tradeDecisionId,
          idempotencyKey: fingerprint,
          correlationId: fingerprint,
        });

        const fillTime = new Date();
        await this.markExecutionExecuted(executionId, orderResult.id);

        // Distinct execution fill transition: ORDER_FILLED -> POSITION_OPENED
        await this.tradeDecisionService!.updateTradeLifecycleState(
          tradeDecisionId,
          TradeLifecycleState.ORDER_FILLED,
          {
            executionId,
            orderPositionId: orderResult.id,
            fillTime,
          },
          TradeLifecycleState.ORDER_SUBMITTED,
        );

        await this.tradeDecisionService!.updateTradeLifecycleState(
          tradeDecisionId,
          TradeLifecycleState.POSITION_OPENED,
          {
            executionId,
            orderPositionId: orderResult.id,
          },
          TradeLifecycleState.ORDER_FILLED,
        );

        this.lastPositionId = orderResult.id;
        this.lastExecutionSuccess = new Date();
        this.lastLifecycleState = TradeLifecycleState.POSITION_OPENED;
        this.lastLifecycleTransitionTime = new Date();

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
          tradeDecisionId,
          decision: 'TAKE',
          lifecycleState: TradeLifecycleState.POSITION_OPENED,
          correlationId: fingerprint,
        });
      } catch (e: any) {
        const classification = classifyExecutionFailure(e);
        this.lastExecutionRejectionReason = classification.reasonCode;
        this.lastLifecycleState = TradeLifecycleState.TRADE_FAILED;
        this.lastLifecycleTransitionTime = new Date();
        this.logger.error(
          `[BOT EXECUTION ERROR] Bot '${bot.id}' order placement failed: ${e.message}`,
          e.stack,
        );
        await this.markExecutionFailed(executionId, e, classification);
        await this.tradeDecisionService!.updateTradeLifecycleState(
          tradeDecisionId,
          TradeLifecycleState.TRADE_FAILED,
          { executionId },
          [
            TradeLifecycleState.ORDER_SUBMITTED,
            TradeLifecycleState.RESERVATION_CREATED,
            TradeLifecycleState.TRADE_TAKEN,
          ],
        );

        results.push({
          botId: bot.id,
          symbol: bot.symbol,
          status: 'FAILED',
          reasonCode: classification.reasonCode,
          details: classification.message,
          executionId,
          tradeDecisionId,
          decision: 'TAKE',
          lifecycleState: TradeLifecycleState.TRADE_FAILED,
          correlationId: fingerprint,
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
