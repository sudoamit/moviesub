import { WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { PrismaService } from '../prisma.service';
import { RedisService } from '../redis.service';
export declare class PositionMonitorProcessor extends WorkerHost {
    private readonly prisma;
    private readonly redis;
    private readonly logger;
    constructor(prisma: PrismaService, redis: RedisService);
    process(job: Job<any, any, string>): Promise<any>;
    /**
     * Retrieves persisted trading system configuration.
     */
    private getSystemConfig;
    /**
     * Main evaluation loop for all open/partially closed positions across all paper accounts.
     */
    evaluateActivePositions(): Promise<{
        checked: number;
        closed: number;
        updated: number;
    }>;
    /**
     * Resolves execution/monitoring price exclusively from the live ticker cache: ticker:${SYMBOL}:live
     * NEVER queries PostgreSQL candles or candle caches.
     */
    private resolveLivePrice;
    private calculateCharges;
    private evaluatePositionTick;
    private executeFullClose;
}
