"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var AlertRateLimiter_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.AlertRateLimiter = void 0;
const common_1 = require("@nestjs/common");
const redis_service_1 = require("../../common/redis/redis.service");
let AlertRateLimiter = AlertRateLimiter_1 = class AlertRateLimiter {
    redis;
    logger = new common_1.Logger(AlertRateLimiter_1.name);
    constructor(redis) {
        this.redis = redis;
    }
    /**
     * Checks if an alert can be dispatched or is rate-limited / in quiet hours
     */
    async canDispatch(options) {
        const { symbol, channel, cooldownSeconds = 900, quietHoursStart, quietHoursEnd } = options;
        // 1. Quiet Hours Check (if configured)
        if (quietHoursStart !== undefined && quietHoursEnd !== undefined) {
            const currentHour = new Date().getHours();
            const inQuietHours = quietHoursStart > quietHoursEnd
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
    async recordDispatch(symbol, channel, cooldownSeconds = 900) {
        const key = `alert:cooldown:${symbol.toUpperCase()}:${channel.toLowerCase()}`;
        await this.redis.set(key, new Date().toISOString(), cooldownSeconds);
    }
};
exports.AlertRateLimiter = AlertRateLimiter;
exports.AlertRateLimiter = AlertRateLimiter = AlertRateLimiter_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [redis_service_1.RedisService])
], AlertRateLimiter);
//# sourceMappingURL=rate-limiter.js.map