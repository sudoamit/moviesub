import { PrismaService } from '../common/prisma/prisma.service';
import { RedisService } from '../common/redis/redis.service';
export declare class HealthController {
    private readonly prisma;
    private readonly redis;
    constructor(prisma: PrismaService, redis: RedisService);
    getLiveness(): {
        status: string;
        uptime: number;
        timestamp: string;
        service: string;
        version: string;
    };
    getApiLiveness(): {
        status: string;
        uptime: number;
        timestamp: string;
        service: string;
        version: string;
    };
    getReadiness(): Promise<{
        status: string;
        timestamp: string;
        uptime: number;
        services: {
            database: string;
            redis: string;
        };
    }>;
    getApiReadiness(): Promise<{
        status: string;
        timestamp: string;
        uptime: number;
        services: {
            database: string;
            redis: string;
        };
    }>;
    getMetrics(): Promise<{
        timestamp: string;
        uptime: number;
        memoryUsage: NodeJS.MemoryUsage;
        stats: {
            openPositions: number;
            completedTrades: number;
            totalOrders: number;
        };
    }>;
    getApiMetrics(): Promise<{
        timestamp: string;
        uptime: number;
        memoryUsage: NodeJS.MemoryUsage;
        stats: {
            openPositions: number;
            completedTrades: number;
            totalOrders: number;
        };
    }>;
}
