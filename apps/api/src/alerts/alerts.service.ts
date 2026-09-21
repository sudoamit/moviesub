import { Injectable, Logger, NotFoundException, OnModuleInit, Optional } from '@nestjs/common';
import * as crypto from 'crypto';
import { PrismaService } from '../common/prisma/prisma.service';
import { TelegramDispatcher } from './dispatcher/telegram.dispatcher';
import { WebhookDispatcher } from './dispatcher/webhook.dispatcher';
import { AlertRateLimiter } from './dispatcher/rate-limiter';
import { CreateAlertDto, TestAlertDto } from './dto/create-alert.dto';
import { ISignalSetup, SignalGrade, TradeAlertPayload, OutboxEvent } from '@quant/shared';
import { SignalsService } from '../signals/signals.service';
import { AlertIdempotencyService } from './alert-idempotency.service';
import { OutboxService } from '../trading-domain/outbox.service';

@Injectable()
export class AlertsService implements OnModuleInit {
  private readonly logger = new Logger(AlertsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly telegramDispatcher: TelegramDispatcher,
    private readonly webhookDispatcher: WebhookDispatcher,
    private readonly rateLimiter: AlertRateLimiter,
    private readonly signalsService: SignalsService,
    private readonly idempotencyService: AlertIdempotencyService,
    @Optional() private readonly outboxService?: OutboxService,
  ) {}

  onModuleInit() {
    if (this.outboxService) {
      this.logger.log('Registering AlertsService handlers with OutboxService...');
      const tradeEventTypes = [
        'POSITION_OPENED',
        'POSITION_CLOSED',
        'SL_UPDATED',
        'TP_REACHED',
        'ORDER_FILLED',
        'RISK_LIMIT_BREACHED',
        'TRADE_ALERT',
      ];

      for (const evtType of tradeEventTypes) {
        this.outboxService.registerHandler(evtType, async (event: OutboxEvent) => {
          await this.handleOutboxEvent(event);
        });
      }
    }
  }

  /**
   * Adapts OutboxEvents into TradeAlertPayloads and processes them idempotently
   */
  async handleOutboxEvent(event: OutboxEvent): Promise<void> {
    const payload: TradeAlertPayload = {
      eventId: event.id,
      eventType: (event.payload?.eventType || event.eventType) as any,
      positionId: event.payload?.positionId || (event.aggregateType === 'POSITION' ? event.aggregateId : undefined),
      orderId: event.payload?.orderId || (event.aggregateType === 'ORDER' ? event.aggregateId : undefined),
      symbol: event.payload?.symbol || 'UNKNOWN',
      direction: event.payload?.direction || 'BUY',
      quantity: event.payload?.quantity || event.payload?.filledQuantity || 0,
      price: event.payload?.price || event.payload?.fillPrice || 0,
      realizedPnL: event.payload?.realizedPnL,
      reason: event.payload?.reason || event.payload?.notes,
      timestamp: event.createdAt,
      metadata: event.payload,
    };

    await this.processTradeAlert(payload);
  }

  async createAlert(dto: CreateAlertDto, userId?: string) {
    let targetUserId = userId;
    if (!targetUserId) {
      const user = await this.prisma.user.findFirst();
      targetUserId = user ? user.id : undefined;
    }

    if (!targetUserId) {
      const user = await this.prisma.user.create({
        data: {
          email: 'admin@quantintelligence.io',
          passwordHash: 'argon2-system-hash',
          name: 'Quant Admin',
          role: 'ADMIN',
        },
      });
      targetUserId = user.id;
    }

    return this.prisma.alert.create({
      data: {
        userId: targetUserId,
        channel: dto.channel.toUpperCase(),
        target: dto.target,
        minScore: dto.minScore || 80,
        minGrade: (dto.minGrade as any) || SignalGrade.A,
        isActive: dto.isActive !== undefined ? dto.isActive : true,
      },
    });
  }

  async listAlerts(userId?: string) {
    return this.prisma.alert.findMany({
      where: userId ? { userId } : {},
      orderBy: { createdAt: 'desc' },
    });
  }

  async deleteAlert(id: string) {
    const alert = await this.prisma.alert.findUnique({ where: { id } });
    if (!alert) {
      throw new NotFoundException(`Alert with id '${id}' not found`);
    }

    return this.prisma.alert.delete({ where: { id } });
  }

  /**
   * Processes a signal alert with strict eventId-based idempotency.
   * Derives a deterministic eventId if not explicitly provided.
   */
  async processSignalAlert(signal: ISignalSetup, eventId?: string) {
    if (signal.score < 75) return { processed: 0, dispatched: 0, suppressed: 0 };

    // Derive deterministic eventId if not provided: symbol + direction + timeframe + timestamp
    const effectiveEventId =
      eventId ||
      signal.id ||
      `sig_${crypto
        .createHash('sha256')
        .update(
          `${signal.symbol}:${signal.direction}:${signal.timeframe}:${
            signal.canonicalCandleTime || signal.timestamp?.toString() || ''
          }`,
        )
        .digest('hex')
        .substring(0, 16)}`;

    const activeRules = await this.prisma.alert.findMany({
      where: { isActive: true },
    });

    let dispatchedCount = 0;
    let suppressedCount = 0;

    for (const rule of activeRules) {
      if (signal.score < rule.minScore) continue;

      // 1. Check & claim idempotency lease using authoritative eventId
      const claim = await this.idempotencyService.claimDispatch(
        effectiveEventId,
        rule.channel,
        rule.target,
        300,
      );

      if (!claim.canDispatch) {
        this.logger.debug(
          `[ALERT IDEMPOTENCY] Suppressed signal alert for ${signal.symbol} on ${rule.channel} (Event: ${effectiveEventId}): ${claim.reason}`,
        );
        suppressedCount++;
        continue;
      }

      // 2. Check rate limit
      const rateLimit = await this.rateLimiter.canDispatch({
        symbol: signal.symbol,
        channel: rule.channel,
        cooldownSeconds: 900,
      });

      if (!rateLimit.allowed) {
        this.logger.debug(
          `Suppressed alert for ${signal.symbol} on ${rule.channel}: ${rateLimit.reason}`,
        );
        await this.idempotencyService.recordFailed(
          effectiveEventId,
          rule.channel,
          rule.target,
          `RATE_LIMITED: ${rateLimit.reason}`,
        );
        suppressedCount++;
        continue;
      }

      // 3. Dispatch to channel
      let success = false;
      let messageId: string | undefined;

      try {
        if (rule.channel === 'TELEGRAM') {
          const res = await this.telegramDispatcher.dispatchAlert(rule.target, signal);
          success = res.success;
          messageId = res.messageId;
        } else if (rule.channel === 'WEBHOOK') {
          const res = await this.webhookDispatcher.dispatchWebhook(rule.target, signal);
          success = res.success;
        }

        if (success) {
          dispatchedCount++;
          await this.rateLimiter.recordDispatch(signal.symbol, rule.channel, 900);
          await this.idempotencyService.recordDelivered(
            effectiveEventId,
            rule.channel,
            rule.target,
            messageId,
            { score: signal.score, grade: signal.grade },
          );
        } else {
          await this.idempotencyService.recordFailed(
            effectiveEventId,
            rule.channel,
            rule.target,
            'DISPATCH_RETURNED_FAILURE',
          );
        }
      } catch (err) {
        await this.idempotencyService.recordFailed(
          effectiveEventId,
          rule.channel,
          rule.target,
          (err as Error).message,
        );
      }
    }

    return {
      processed: activeRules.length,
      dispatched: dispatchedCount,
      suppressed: suppressedCount,
      eventId: effectiveEventId,
    };
  }

  /**
   * Processes a trade lifecycle alert with strict eventId idempotency.
   * Multiple events for the SAME positionId (e.g. OPEN vs CLOSE) are both delivered
   * because they possess distinct eventIds.
   * Retries of the SAME eventId are strictly deduplicated and suppressed.
   */
  async processTradeAlert(payload: TradeAlertPayload) {
    const activeRules = await this.prisma.alert.findMany({
      where: { isActive: true },
    });

    let dispatchedCount = 0;
    let suppressedCount = 0;
    const details: { channel: string; target: string; status: string; reason?: string }[] = [];

    for (const rule of activeRules) {
      // 1. Authoritative idempotency claim keyed strictly on eventId
      const claim = await this.idempotencyService.claimDispatch(
        payload.eventId,
        rule.channel,
        rule.target,
        300,
      );

      if (!claim.canDispatch) {
        this.logger.debug(
          `[ALERT IDEMPOTENCY] Suppressed trade alert '${payload.eventType}' for ${payload.symbol} (Event: ${payload.eventId}) on ${rule.channel}: ${claim.reason}`,
        );
        suppressedCount++;
        details.push({
          channel: rule.channel,
          target: rule.target,
          status: 'SUPPRESSED',
          reason: claim.reason,
        });
        continue;
      }

      // 2. Dispatch
      let success = false;
      let messageId: string | undefined;

      try {
        if (rule.channel === 'TELEGRAM') {
          const res = await this.telegramDispatcher.dispatchTradeAlert(rule.target, payload);
          success = res.success;
          messageId = res.messageId;
        } else if (rule.channel === 'WEBHOOK') {
          const res = await this.webhookDispatcher.dispatchTradeAlert(rule.target, payload);
          success = res.success;
        }

        if (success) {
          dispatchedCount++;
          await this.idempotencyService.recordDelivered(
            payload.eventId,
            rule.channel,
            rule.target,
            messageId,
            { eventType: payload.eventType, positionId: payload.positionId },
          );
          details.push({ channel: rule.channel, target: rule.target, status: 'DELIVERED' });
        } else {
          await this.idempotencyService.recordFailed(
            payload.eventId,
            rule.channel,
            rule.target,
            'DISPATCH_FAILED',
          );
          details.push({ channel: rule.channel, target: rule.target, status: 'FAILED' });
        }
      } catch (err) {
        await this.idempotencyService.recordFailed(
          payload.eventId,
          rule.channel,
          rule.target,
          (err as Error).message,
        );
        details.push({
          channel: rule.channel,
          target: rule.target,
          status: 'ERROR',
          reason: (err as Error).message,
        });
      }
    }

    return {
      processed: activeRules.length,
      dispatched: dispatchedCount,
      suppressed: suppressedCount,
      eventId: payload.eventId,
      details,
    };
  }

  async testAlert(dto: TestAlertDto) {
    const symbol = dto.symbol || 'NIFTY';
    const signal = await this.signalsService.generateSignalForSymbol(symbol, '15m' as any);

    if (dto.channel.toUpperCase() === 'TELEGRAM') {
      const res = await this.telegramDispatcher.dispatchAlert(dto.target, signal);
      return { success: res.success, channel: 'TELEGRAM', target: dto.target, signal };
    } else if (dto.channel.toUpperCase() === 'WEBHOOK') {
      const res = await this.webhookDispatcher.dispatchWebhook(dto.target, signal);
      return { success: res.success, channel: 'WEBHOOK', target: dto.target, signal };
    }

    return {
      success: true,
      channel: dto.channel,
      message: `Test alert simulated for ${symbol} to ${dto.target}`,
      signal,
    };
  }
}
