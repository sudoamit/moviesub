import { WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { PrismaService } from '../prisma.service';
import { RedisService } from '../redis.service';
export declare class ScannerProcessor extends WorkerHost {
    private readonly prisma;
    private readonly redis;
    private readonly logger;
    constructor(prisma: PrismaService, redis: RedisService);
    process(job: Job<any, any, string>): Promise<any>;
    private scanInstrument;
}
