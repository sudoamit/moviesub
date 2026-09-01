import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { TelegramDispatcher } from './dispatcher/telegram.dispatcher';
import { WebhookDispatcher } from './dispatcher/webhook.dispatcher';
import { AlertRateLimiter } from './dispatcher/rate-limiter';
import { CreateAlertDto, TestAlertDto } from './dto/create-alert.dto';
import { ISignalSetup, SignalGrade } from '@quant/shared';
import { SignalsService } from '../signals/signals.service';

@Injectable()
export class AlertsService {
  private readonly logger = new Logger(AlertsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly telegramDispatcher: TelegramDispatcher,
    private readonly webhookDispatcher: WebhookDispatcher,
    private readonly rateLimiter: AlertRateLimiter,
    private readonly signalsService: SignalsService,
  ) {}

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

  async processSignalAlert(signal: ISignalSetup) {
    if (signal.score < 75) return { processed: 0, dispatched: 0 };

    const activeRules = await this.prisma.alert.findMany({
      where: { isActive: true },
    });

    let dispatchedCount = 0;

    for (const rule of activeRules) {
      if (signal.score < rule.minScore) continue;

      const rateLimit = await this.rateLimiter.canDispatch({
        symbol: signal.symbol,
        channel: rule.channel,
        cooldownSeconds: 900,
      });

      if (!rateLimit.allowed) {
        this.logger.debug(`Suppressed alert for ${signal.symbol} on ${rule.channel}: ${rateLimit.reason}`);
        continue;
      }

      let success = false;
      if (rule.channel === 'TELEGRAM') {
        const res = await this.telegramDispatcher.dispatchAlert(rule.target, signal);
        success = res.success;
      } else if (rule.channel === 'WEBHOOK') {
        const res = await this.webhookDispatcher.dispatchWebhook(rule.target, signal);
        success = res.success;
      }

      if (success) {
        dispatchedCount++;
        await this.rateLimiter.recordDispatch(signal.symbol, rule.channel, 900);
      }
    }

    return {
      processed: activeRules.length,
      dispatched: dispatchedCount,
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
