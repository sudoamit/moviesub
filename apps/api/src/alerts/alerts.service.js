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
var AlertsService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.AlertsService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../common/prisma/prisma.service");
const telegram_dispatcher_1 = require("./dispatcher/telegram.dispatcher");
const webhook_dispatcher_1 = require("./dispatcher/webhook.dispatcher");
const rate_limiter_1 = require("./dispatcher/rate-limiter");
const shared_1 = require("@quant/shared");
const signals_service_1 = require("../signals/signals.service");
let AlertsService = AlertsService_1 = class AlertsService {
    prisma;
    telegramDispatcher;
    webhookDispatcher;
    rateLimiter;
    signalsService;
    logger = new common_1.Logger(AlertsService_1.name);
    constructor(prisma, telegramDispatcher, webhookDispatcher, rateLimiter, signalsService) {
        this.prisma = prisma;
        this.telegramDispatcher = telegramDispatcher;
        this.webhookDispatcher = webhookDispatcher;
        this.rateLimiter = rateLimiter;
        this.signalsService = signalsService;
    }
    async createAlert(dto, userId) {
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
                minGrade: dto.minGrade || shared_1.SignalGrade.A,
                isActive: dto.isActive !== undefined ? dto.isActive : true,
            },
        });
    }
    async listAlerts(userId) {
        return this.prisma.alert.findMany({
            where: userId ? { userId } : {},
            orderBy: { createdAt: 'desc' },
        });
    }
    async deleteAlert(id) {
        const alert = await this.prisma.alert.findUnique({ where: { id } });
        if (!alert) {
            throw new common_1.NotFoundException(`Alert with id '${id}' not found`);
        }
        return this.prisma.alert.delete({ where: { id } });
    }
    async processSignalAlert(signal) {
        if (signal.score < 75)
            return { processed: 0, dispatched: 0 };
        const activeRules = await this.prisma.alert.findMany({
            where: { isActive: true },
        });
        let dispatchedCount = 0;
        for (const rule of activeRules) {
            if (signal.score < rule.minScore)
                continue;
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
            }
            else if (rule.channel === 'WEBHOOK') {
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
    async testAlert(dto) {
        const symbol = dto.symbol || 'NIFTY';
        const signal = await this.signalsService.generateSignalForSymbol(symbol, '15m');
        if (dto.channel.toUpperCase() === 'TELEGRAM') {
            const res = await this.telegramDispatcher.dispatchAlert(dto.target, signal);
            return { success: res.success, channel: 'TELEGRAM', target: dto.target, signal };
        }
        else if (dto.channel.toUpperCase() === 'WEBHOOK') {
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
};
exports.AlertsService = AlertsService;
exports.AlertsService = AlertsService = AlertsService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        telegram_dispatcher_1.TelegramDispatcher,
        webhook_dispatcher_1.WebhookDispatcher,
        rate_limiter_1.AlertRateLimiter,
        signals_service_1.SignalsService])
], AlertsService);
//# sourceMappingURL=alerts.service.js.map