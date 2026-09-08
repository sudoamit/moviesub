"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const testing_1 = require("@nestjs/testing");
const health_controller_1 = require("./health.controller");
const prisma_service_1 = require("../common/prisma/prisma.service");
const redis_service_1 = require("../common/redis/redis.service");
const common_1 = require("@nestjs/common");
describe('HealthController', () => {
    let controller;
    let prismaService;
    let redisService;
    beforeEach(async () => {
        prismaService = {
            isHealthy: jest.fn(),
        };
        redisService = {
            isHealthy: jest.fn(),
        };
        const module = await testing_1.Test.createTestingModule({
            controllers: [health_controller_1.HealthController],
            providers: [
                { provide: prisma_service_1.PrismaService, useValue: prismaService },
                { provide: redis_service_1.RedisService, useValue: redisService },
            ],
        }).compile();
        controller = module.get(health_controller_1.HealthController);
    });
    it('should return liveness ok', () => {
        const res = controller.getLiveness();
        expect(res.status).toBe('ok');
        expect(res.service).toBe('quant-trading-api');
    });
    it('should return readiness ready when DB and Redis are up', async () => {
        prismaService.isHealthy.mockResolvedValue(true);
        redisService.isHealthy.mockResolvedValue(true);
        const res = await controller.getReadiness();
        expect(res.status).toBe('ready');
        expect(res.services.database).toBe('up');
        expect(res.services.redis).toBe('up');
    });
    it('should throw HttpException when DB is down', async () => {
        prismaService.isHealthy.mockResolvedValue(false);
        redisService.isHealthy.mockResolvedValue(true);
        await expect(controller.getReadiness()).rejects.toThrow(common_1.HttpException);
    });
});
//# sourceMappingURL=health.controller.spec.js.map