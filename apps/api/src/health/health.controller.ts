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
      uptime: process.uptime(),
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

  @Get('api/ready')
  async getApiReadiness() {
    return this.getReadiness();
  }

  @Get('metrics')
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

  @Get('api/metrics')
  async getApiMetrics() {
    return this.getMetrics();
  }
}
