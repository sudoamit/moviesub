import { RedisService } from '../../common/redis/redis.service';
export interface IRateLimitOptions {
    symbol: string;
    channel: string;
    cooldownSeconds?: number;
    quietHoursStart?: number;
    quietHoursEnd?: number;
}
export declare class AlertRateLimiter {
    private readonly redis;
    private readonly logger;
    constructor(redis: RedisService);
    /**
     * Checks if an alert can be dispatched or is rate-limited / in quiet hours
     */
    canDispatch(options: IRateLimitOptions): Promise<{
        allowed: boolean;
        reason?: string;
    }>;
    /**
     * Records a successful dispatch and sets the cooldown lock
     */
    recordDispatch(symbol: string, channel: string, cooldownSeconds?: number): Promise<void>;
}
