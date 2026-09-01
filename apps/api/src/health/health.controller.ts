import { Controller, Get, HttpException, HttpStatus } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { RedisService } from '../common/redis/redis.service';

@Controller()
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  @Get('health')
  getLiveness() {
    return {
      status: 'ok',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
      service: 'quant-trading-api',
      version: '1.0.0',
    };
  }

  @Get('api/health')
  getApiLiveness() {
    return this.getLiveness();
  }

  @Get('ready')
  async getReadiness() {
    const dbHealthy = await this.prisma.isHealthy();
    const redisHealthy = await this.redis.isHealthy();

    const isReady = dbHealthy && redisHealthy;

    const result = {
      status: isReady ? 'ready' : 'not_ready',
      timestamp: new Date().toISOString(),
      services: {
        database: dbHealthy ? 'up' : 'down',
        redis: redisHealthy ? 'up' : 'down',
      },
    };

    if (!isReady) {
      throw new HttpException(result, HttpStatus.SERVICE_UNAVAILABLE);
    }

    return result;
  }
}
