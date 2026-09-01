import { Test, TestingModule } from '@nestjs/testing';
import { HealthController } from './health.controller';
import { PrismaService } from '../common/prisma/prisma.service';
import { RedisService } from '../common/redis/redis.service';
import { HttpException } from '@nestjs/common';

describe('HealthController', () => {
  let controller: HealthController;
  let prismaService: jest.Mocked<Partial<PrismaService>>;
  let redisService: jest.Mocked<Partial<RedisService>>;

  beforeEach(async () => {
    prismaService = {
      isHealthy: jest.fn(),
    };

    redisService = {
      isHealthy: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        { provide: PrismaService, useValue: prismaService },
        { provide: RedisService, useValue: redisService },
      ],
    }).compile();

    controller = module.get<HealthController>(HealthController);
  });

  it('should return liveness ok', () => {
    const res = controller.getLiveness();
    expect(res.status).toBe('ok');
    expect(res.service).toBe('quant-trading-api');
  });

  it('should return readiness ready when DB and Redis are up', async () => {
    (prismaService.isHealthy as jest.Mock).mockResolvedValue(true);
    (redisService.isHealthy as jest.Mock).mockResolvedValue(true);

    const res = await controller.getReadiness();
    expect(res.status).toBe('ready');
    expect(res.services.database).toBe('up');
    expect(res.services.redis).toBe('up');
  });

  it('should throw HttpException when DB is down', async () => {
    (prismaService.isHealthy as jest.Mock).mockResolvedValue(false);
    (redisService.isHealthy as jest.Mock).mockResolvedValue(true);

    await expect(controller.getReadiness()).rejects.toThrow(HttpException);
  });
});
