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
Object.defineProperty(exports, "__esModule", { value: true });
exports.HealthController = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../common/prisma/prisma.service");
const redis_service_1 = require("../common/redis/redis.service");
let HealthController = class HealthController {
    prisma;
    redis;
    constructor(prisma, redis) {
        this.prisma = prisma;
        this.redis = redis;
    }
    getLiveness() {
        return {
            status: 'ok',
            uptime: process.uptime(),
            timestamp: new Date().toISOString(),
            service: 'quant-trading-api',
            version: '1.0.0',
        };
    }
    getApiLiveness() {
        return this.getLiveness();
    }
    async getReadiness() {
        const dbHealthy = await this.prisma.isHealthy();
        const redisHealthy = await this.redis.isHealthy();
        const isReady = dbHealthy && redisHealthy;
        const result = {
            status: isReady ? 'ready' : 'not_ready',
            timestamp: new Date().toISOString(),
            uptime: process.uptime(),
            services: {
                database: dbHealthy ? 'up' : 'down',
                redis: redisHealthy ? 'up' : 'down',
            },
        };
        if (!isReady) {
            throw new common_1.HttpException(result, common_1.HttpStatus.SERVICE_UNAVAILABLE);
        }
        return result;
    }
    async getApiReadiness() {
        return this.getReadiness();
    }
    async getMetrics() {
        const [openPositionsCount, totalTradesCount, totalOrdersCount] = await Promise.all([
            this.prisma.paperPosition
                .count({
                where: { status: { in: ['OPEN', 'PARTIALLY_CLOSED'] } },
            })
                .catch(() => 0),
            this.prisma.paperTrade.count().catch(() => 0),
            this.prisma.paperOrder.count().catch(() => 0),
        ]);
        return {
            timestamp: new Date().toISOString(),
            uptime: process.uptime(),
            memoryUsage: process.memoryUsage(),
            stats: {
                openPositions: openPositionsCount,
                completedTrades: totalTradesCount,
                totalOrders: totalOrdersCount,
            },
        };
    }
    async getApiMetrics() {
        return this.getMetrics();
    }
};
exports.HealthController = HealthController;
__decorate([
    (0, common_1.Get)('health'),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", void 0)
], HealthController.prototype, "getLiveness", null);
__decorate([
    (0, common_1.Get)('api/health'),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", void 0)
], HealthController.prototype, "getApiLiveness", null);
__decorate([
    (0, common_1.Get)('ready'),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], HealthController.prototype, "getReadiness", null);
__decorate([
    (0, common_1.Get)('api/ready'),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], HealthController.prototype, "getApiReadiness", null);
__decorate([
    (0, common_1.Get)('metrics'),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], HealthController.prototype, "getMetrics", null);
__decorate([
    (0, common_1.Get)('api/metrics'),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], HealthController.prototype, "getApiMetrics", null);
exports.HealthController = HealthController = __decorate([
    (0, common_1.Controller)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        redis_service_1.RedisService])
], HealthController);
//# sourceMappingURL=health.controller.js.map