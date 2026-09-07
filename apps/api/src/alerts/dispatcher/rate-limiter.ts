import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../../common/redis/redis.service';

export interface IRateLimitOptions {
  symbol: string;
  channel: string;
  cooldownSeconds?: number;
  quietHoursStart?: number; // 0-23 hour e.g. 23 (11 PM)
  quietHoursEnd?: number; // 0-23 hour e.g. 7 (7 AM)
}

@Injectable()
export class AlertRateLimiter {
  private readonly logger = new Logger(AlertRateLimiter.name);

  constructor(private readonly redis: RedisService) {}

  /**
   * Checks if an alert can be dispatched or is rate-limited / in quiet hours
   */
  async canDispatch(options: IRateLimitOptions): Promise<{ allowed: boolean; reason?: string }> {
    const { symbol, channel, cooldownSeconds = 900, quietHoursStart, quietHoursEnd } = options;

    // 1. Quiet Hours Check (if configured)
    if (quietHoursStart !== undefined && quietHoursEnd !== undefined) {
      const currentHour = new Date().getHours();
      const inQuietHours =
        quietHoursStart > quietHoursEnd
          ? currentHour >= quietHoursStart || currentHour < quietHoursEnd
          : currentHour >= quietHoursStart && currentHour < quietHoursEnd;

      if (inQuietHours) {
        this.logger.debug(`Alert for ${symbol} suppressed: Quiet hours active (${currentHour}:00)`);
        return {
          allowed: false,
          reason: `Quiet hours active (${quietHoursStart}:00 - ${quietHoursEnd}:00)`,
        };
      }
    }

    // 2. Redis Cooldown Check
    const key = `alert:cooldown:${symbol.toUpperCase()}:${channel.toLowerCase()}`;
    const exists = await this.redis.get(key);

    if (exists) {
      this.logger.debug(`Alert for ${symbol} on ${channel} suppressed: Cooldown active`);
      return { allowed: false, reason: `Rate limit cooldown active for ${symbol}` };
    }

    return { allowed: true };
  }

  /**
   * Records a successful dispatch and sets the cooldown lock
   */
  async recordDispatch(
    symbol: string,
    channel: string,
    cooldownSeconds: number = 900,
  ): Promise<void> {
    const key = `alert:cooldown:${symbol.toUpperCase()}:${channel.toLowerCase()}`;
    await this.redis.set(key, new Date().toISOString(), cooldownSeconds);
  }
}
