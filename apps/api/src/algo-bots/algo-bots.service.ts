import { Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { PaperTradingService } from '../paper-trading/paper-trading.service';
import { AlertsService } from '../alerts/alerts.service';
import { PrismaService } from '../common/prisma/prisma.service';
import { RedisService } from '../common/redis/redis.service';
import { ISignalSetup, Timeframe } from '@quant/shared';

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
export class AlgoBotsService {
  private readonly logger = new Logger(AlgoBotsService.name);

  // Process-local lock cache for fast idempotency check
  private readonly inMemoryLocks = new Set<string>();

  // In-memory store of active algorithmic bots initialized with preset institutional bots
  private bots: IAlgoBot[] = [
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
    this.logger.log(
      `Algo Strategy Studio initialized with ${this.bots.length} active automated bots.`,
    );
  }

  async listBots(): Promise<IAlgoBot[]> {
    return this.bots;
  }

  async createBot(dto: Partial<IAlgoBot>): Promise<IAlgoBot> {
    const newBot: IAlgoBot = {
      id: `bot_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
      name: dto.name || `${dto.symbol || 'NIFTY'} Custom SMC Bot`,
      symbol: (dto.symbol || 'NIFTY').toUpperCase(),
      direction: dto.direction || 'ANY',
      timeframe: dto.timeframe || '15m',
      minScore: Number(dto.minScore || 80),
      smcCondition: dto.smcCondition || 'ANY_CONFLUENCE',
      lots: Number(dto.lots || 1),
      autoExecutePaper: dto.autoExecutePaper === true,
      notifyWebhook: dto.notifyWebhook !== false,
      isActive: dto.isActive === true,
      createdAt: new Date().toISOString(),
      triggerCount: 0,
    };

    this.bots.unshift(newBot);
    this.logger.log(`✓ [ALGO BOT CREATED] '${newBot.name}' (${newBot.symbol} ${newBot.direction})`);
    return newBot;
  }

  async toggleBot(id: string): Promise<IAlgoBot> {
    const bot = this.bots.find((b) => b.id === id);
    if (!bot) {
      throw new NotFoundException(`Bot '${id}' not found`);
    }
    bot.isActive = !bot.isActive;
    this.logger.log(`✓ Bot '${bot.name}' is now ${bot.isActive ? 'ACTIVE' : 'PAUSED'}`);
    return bot;
  }

  async deleteBot(id: string): Promise<{ success: boolean }> {
    const index = this.bots.findIndex((b) => b.id === id);
    if (index === -1) {
      throw new NotFoundException(`Bot '${id}' not found`);
    }
    this.bots.splice(index, 1);
    return { success: true };
  }

  /**
   * Normalizes timeframes (e.g. 'M15' -> '15m', 'H1' -> '1h') to ensure exact string comparison parity.
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
   * Authoritative Strategy Matching Function:
   * Enforces symbol, timeframe, direction, minScore, and smcCondition.
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
        details: `Bot symbol '${bot.symbol}' does not match signal symbol '${signal.symbol}'`,
      };
    }

    // 2. Exact Timeframe Match
    const normalizedBotTf = this.normalizeTimeframe(bot.timeframe);
    const normalizedSignalTf = this.normalizeTimeframe(signal.timeframe);
    if (normalizedBotTf !== normalizedSignalTf) {
      return {
        matches: false,
        reasonCode: 'TIMEFRAME_MISMATCH',
        details: `Bot timeframe '${bot.timeframe}' (${normalizedBotTf}) does not match signal timeframe '${signal.timeframe}' (${normalizedSignalTf})`,
      };
    }

    // 3. Direction Match
    if (bot.direction !== 'ANY' && bot.direction !== signal.direction) {
      return {
        matches: false,
        reasonCode: 'DIRECTION_MISMATCH',
        details: `Bot direction '${bot.direction}' does not match signal direction '${signal.direction}'`,
      };
    }

    // 4. Min Score Threshold
    if (typeof signal.score !== 'number' || signal.score < bot.minScore) {
      return {
        matches: false,
        reasonCode: 'SCORE_BELOW_THRESHOLD',
        details: `Signal score (${signal.score}) is below bot minScore threshold (${bot.minScore})`,
      };
    }

    // 5. SMC Condition Match (Strictly inspects canonical signal output fields, NOT bot name)
    if (!this.matchesSmcCondition(bot.smcCondition, signal)) {
      return {
        matches: false,
        reasonCode: 'SMC_CONDITION_MISMATCH',
        details: `Signal does not satisfy bot SMC condition '${bot.smcCondition}'`,
      };
    }

    return { matches: true };
  }

  /**
   * Inspects canonical ISignalSetup fields (scoreBreakdown, reasoning, reasons) to evaluate SMC condition
   */
  public matchesSmcCondition(
    condition: 'ORDER_BLOCK' | 'FVG' | 'LIQUIDITY_SWEEP' | 'ANY_CONFLUENCE',
    signal: ISignalSetup,
  ): boolean {
    if (condition === 'ANY_CONFLUENCE') {
      return true;
    }

    const breakdown = signal.scoreBreakdown || {};
    const reasoning = signal.reasoning || {};
    const reasons = signal.reasons || [];

    const explicitStr = (reasons || []).join(' ').toUpperCase();
    const triggerStr = (reasoning.triggerReason || '').toUpperCase();
    const summaryStr = (reasoning.summary || '').toUpperCase();
    const liquidityStr = (reasoning.liquidityReason || '').toUpperCase();

    if (condition === 'ORDER_BLOCK') {
      const obScore = Number(breakdown.orderBlock || 0);
      const inReasons = /ORDER_BLOCK|ORDER_BLOCK_TAP|OB_TAP|OB/i.test(explicitStr);
      const inTrigger = /ORDER_BLOCK|ORDER BLOCK|OB_TAP|ORDER_BLOCK_TAP/i.test(triggerStr);
      const inSummary = /ORDER_BLOCK|ORDER BLOCK/i.test(summaryStr);
      return obScore > 0 || inReasons || inTrigger || inSummary;
    }

    if (condition === 'FVG') {
      const fvgScore = Number(breakdown.fvg || 0);
      const inReasons = /FVG|FAIR_VALUE_GAP|FVG_MITIGATION/i.test(explicitStr);
      const inTrigger = /FVG|FAIR VALUE GAP|FVG_MITIGATION/i.test(triggerStr);
      const inSummary = /FVG|FAIR VALUE GAP/i.test(summaryStr);
      return fvgScore > 0 || inReasons || inTrigger || inSummary;
    }

    if (condition === 'LIQUIDITY_SWEEP') {
      const sweepScore = Number(breakdown.liquiditySweep || 0);
      const inReasons = /LIQUIDITY_SWEEP|LIQUIDITY_TAKEN|LIQUIDITY|SWEPT/i.test(explicitStr);
      const inTrigger = /LIQUIDITY_SWEEP|LIQUIDITY|SWEPT/i.test(triggerStr);
      const inLiquidity = /LIQUIDITY_SWEEP|LIQUIDITY|SWEPT/i.test(liquidityStr);
      const inSummary = /LIQUIDITY_SWEEP|LIQUIDITY|SWEPT/i.test(summaryStr);
      return sweepScore > 0 || inReasons || inTrigger || inLiquidity || inSummary;
    }

    return false;
  }

  /**
   * Validates general signal eligibility before bot execution (NEUTRAL, NO_TRADE, invalid levels, timestamps)
   */
  public validateExecutionEligibility(bot: IAlgoBot, signal: ISignalSetup): IStrategyMatchResult {
    if (!bot.isActive) {
      return { matches: false, reasonCode: 'BOT_INACTIVE', details: `Bot '${bot.id}' is inactive/paused` };
    }

    if (!signal.direction || signal.direction === ('NEUTRAL' as any) || signal.direction === ('NO_TRADE' as any)) {
      return { matches: false, reasonCode: 'INVALID_SIGNAL', details: `Signal direction '${signal.direction}' is NEUTRAL or NO_TRADE` };
    }

    if (signal.grade === ('NO_TRADE' as any)) {
      return { matches: false, reasonCode: 'INVALID_SIGNAL', details: `Signal grade is NO_TRADE` };
    }

    const timestamp = signal.timestamp || signal.createdAt;
    if (!timestamp || Number.isNaN(new Date(timestamp).getTime())) {
      return { matches: false, reasonCode: 'INVALID_SIGNAL', details: `Signal lacks valid market timestamp` };
    }

    const optimalEntry = signal.entryZone?.optimal;
    const stopLoss = signal.stopLoss;
    const tp1 = signal.takeProfits?.tp1;

    if (!optimalEntry || optimalEntry <= 0 || !stopLoss || stopLoss <= 0 || !tp1 || tp1 <= 0) {
      return { matches: false, reasonCode: 'INVALID_SIGNAL', details: `Incomplete entry/SL/TP trade levels` };
    }

    if (signal.direction === 'BULLISH') {
      if (stopLoss >= optimalEntry || tp1 <= optimalEntry) {
        return { matches: false, reasonCode: 'INVALID_SIGNAL', details: `Invalid BULLISH SL/TP orientation relative to entry` };
      }
    } else if (signal.direction === 'BEARISH') {
      if (stopLoss <= optimalEntry || tp1 >= optimalEntry) {
        return { matches: false, reasonCode: 'INVALID_SIGNAL', details: `Invalid BEARISH SL/TP orientation relative to entry` };
      }
    }

    return { matches: true };
  }

  /**
   * Generates a deterministic execution fingerprint for bot execution deduplication
   */
  public getSignalFingerprint(bot: IAlgoBot, signal: ISignalSetup): string {
    const timestamp = signal.timestamp || signal.createdAt || new Date();
    const signalTimeMs = new Date(timestamp).getTime();
    const normTf = this.normalizeTimeframe(signal.timeframe);
    const sigId = signal.id ? `:${signal.id}` : '';
    return `bot_exec:${bot.id}:${signal.symbol.toUpperCase()}:${normTf}:${signal.direction}${sigId}:${signalTimeMs}`;
  }

  /**
   * Database + Redis persistent atomic lock reservation preventing race conditions and duplicate executions
   */
  public async reserveExecutionLock(fingerprint: string): Promise<boolean> {
    if (this.inMemoryLocks.has(fingerprint)) {
      return false;
    }

    // 1. Persistent Database Lock via AuditEvent check
    if (this.prisma) {
      try {
        const existing = await this.prisma.auditEvent.findFirst({
          where: {
            entityId: fingerprint,
            eventType: { in: ['ALGO_BOT_EXECUTION_RESERVED', 'ALGO_BOT_ORDER_PLACED'] },
          },
        });
        if (existing) {
          this.inMemoryLocks.add(fingerprint);
          return false;
        }
      } catch {
        // Continue fallback
      }
    }

    // 2. Redis Atomic Lock Check
    if (this.redis) {
      const client = this.redis.getClient();
      if (client && client.status === 'ready') {
        try {
          const res = await client.set(`lock:${fingerprint}`, 'RESERVED', 'EX', 86400, 'NX');
          if (res !== 'OK') {
            this.inMemoryLocks.add(fingerprint);
            return false;
          }
        } catch {
          // Continue fallback
        }
      }
    }

    this.inMemoryLocks.add(fingerprint);

    // 3. Write DB Reservation Audit Record
    if (this.prisma) {
      try {
        await this.prisma.auditEvent.create({
          data: {
            actor: 'SYSTEM',
            service: 'API',
            eventType: 'ALGO_BOT_EXECUTION_RESERVED',
            entityType: 'ALGO_BOT_EXECUTION',
            entityId: fingerprint,
            correlationId: fingerprint,
            payloadJson: { reservedAt: new Date().toISOString() },
          },
        });
      } catch {
        // Ignore DB insert conflict
      }
    }

    return true;
  }

  /**
   * Evaluates incoming signal against all active bot strategies
   */
  async evaluateSignalForBots(signal: ISignalSetup) {
    for (const bot of this.bots) {
      // 1. Validate Bot Active & General Eligibility
      const eligibility = this.validateExecutionEligibility(bot, signal);
      if (!eligibility.matches) {
        if (!bot.isActive) {
          this.logger.debug(`[REJECTED: BOT_INACTIVE] Bot '${bot.id}' is inactive/paused`);
        } else if (eligibility.reasonCode === 'INVALID_SIGNAL') {
          this.logger.warn(`[REJECTED: INVALID_SIGNAL] Signal for ${signal.symbol} rejected: ${eligibility.details}`);
        }
        continue;
      }

      // 2. Authoritative Strategy Matching
      const match = this.matchesBotStrategy(bot, signal);
      if (!match.matches) {
        this.logger.debug(
          `[REJECTED: ${match.reasonCode}] Bot '${bot.id}' rejected signal ${signal.symbol} ${signal.direction}: ${match.details}`,
        );
        continue;
      }

      // 3. Signal Execution Idempotency Fingerprint & Atomic Lock Reservation
      const fingerprint = this.getSignalFingerprint(bot, signal);
      const reserved = await this.reserveExecutionLock(fingerprint);
      if (!reserved) {
        this.logger.warn(
          `[REJECTED: EXECUTION_LOCKED] Duplicate signal or execution lock already held for fingerprint: ${fingerprint}`,
        );
        continue;
      }

      // Update bot trigger metadata
      bot.triggerCount += 1;
      bot.lastTriggeredAt = new Date().toISOString();
      bot.lastTriggerDetails = `${signal.direction} Trigger @ ₹${signal.entryZone.optimal.toFixed(2)} (Score: ${signal.score}/100)`;

      this.logger.log(
        `🤖 [BOT TRIGGERED] '${bot.name}' (${bot.id}) -> ${signal.symbol} ${signal.direction} @ ₹${signal.entryZone.optimal} | Fingerprint: ${fingerprint}`,
      );

      // 4. Automated Paper Execution
      if (!bot.autoExecutePaper) {
        this.logger.debug(`[AUTO_EXECUTE_DISABLED] Bot '${bot.id}' has autoExecutePaper=false`);
        continue;
      }

      try {
        // Fail closed if live exchange market data is stale or unavailable
        try {
          await this.paperTradingService.getValidatedMarketPrice(bot.symbol, 5);
        } catch (err: any) {
          this.logger.error(
            `[REJECTED: MARKET_DATA_UNAVAILABLE] Live market data unavailable for symbol '${bot.symbol}': ${err.message}`,
          );
          continue;
        }

        // Check bot position scope (prevent duplicate open positions per symbol)
        const portfolio = await this.paperTradingService.getPortfolio();
        const alreadyOpen = portfolio.openPositions.some((p) => p.symbol === bot.symbol);
        if (alreadyOpen) {
          this.logger.warn(
            `[REJECTED: POSITION_ALREADY_OPEN] Open position already exists for symbol '${bot.symbol}'`,
          );
          continue;
        }

        const lotMultiplier =
          bot.symbol === 'NIFTY'
            ? 65
            : bot.symbol === 'BANKNIFTY'
              ? 15
              : bot.symbol === 'BTCUSDT'
                ? 0.2
                : 100;

        const orderResult = await this.paperTradingService.placeOrder({
          symbol: bot.symbol,
          direction: signal.direction === 'BULLISH' ? 'BUY' : 'SELL',
          quantity: bot.lots * lotMultiplier,
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

        this.logger.log(
          `✓ [BOT ORDER EXECUTED] Bot '${bot.id}' placed order for ${bot.symbol} ${signal.direction} | Fingerprint: ${fingerprint} | Fill Price: ₹${orderResult.entryPrice} (Planned Entry: ₹${signal.entryZone.optimal}) | PositionID: ${orderResult.id}`,
        );
      } catch (e: any) {
        this.logger.error(`[BOT EXECUTION ERROR] Bot '${bot.id}' order placement failed: ${e.message}`);
      }
    }
  }
}
